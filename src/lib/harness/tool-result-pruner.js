'use strict';
/**
 * 工具结果裁剪器（对标 DeepSeek Harness `compaction/compaction-tool-result-pruner`）
 *
 * 动机：agent loop 里工具结果会逐轮回喂模型。一个 `scan_nodes` 返回 200 个节点、
 * 一次 grep 返回几千行，几轮之后上下文就被撑爆——而且是**最没信息量的那部分**
 * （中间大段重复）撑爆的。
 *
 * Harness 的做法：超过 thresholdChars 时，保头 headChars + 保尾 tailChars，
 * 中间换成一个 marker。字符按 **Unicode code point** 计（不是 UTF-16 code unit），
 * 所以切点不会把代理对劈成两半。
 *
 * 与 Harness 的差异（诚实声明）：
 *  · Harness 把裁剪写成 session 事件（compaction/prune 影子计价 + tool/result 替换），
 *    依赖其 session surface 机制；Genie 没有 surface，因此在**构造回喂消息时**裁剪，
 *    不改写已落盘的历史——语义更弱但不会破坏已有会话日志的哈希链。
 */

const SpillStore = require('./spill-store');

/** 默认预算：阈值 8KB 字符、头 3KB、尾 2KB（Harness 同量级）。 */
const DEFAULTS = { thresholdChars: 8000, headChars: 3000, tailChars: 2000 };

/**
 * D3-06：裁剪不再只说“缩小查询范围”。完整输出先落 spill，marker 里给路径；
 * 落盘失败也如实写出来——不能把“丢了”伪装成“裁剪了”。
 */
function pruneMarker(omitted, spillPath, spillError) {
  if (spillPath) {
    return '\n\n…（中间 ' + omitted + ' 字符已裁剪；完整内容：' + spillPath
      + '，可用 fs_read 带 startLine/endLine 读取，或用 grep 在该路径内检索）…\n\n';
  }
  const why = spillError ? '完整内容落盘失败（' + spillError + '）' : '未落盘';
  return '\n\n…（中间 ' + omitted + ' 字符已裁剪；' + why + '，如需完整内容请缩小查询范围）…\n\n';
}

/** 已经裁剪过的内容不要再裁/再落盘，否则每轮回喂都会多一个 spill 文件。 */
function alreadyPruned(text) {
  return text.includes('字符已裁剪') && (text.includes('完整内容：') || text.includes('完整内容落盘失败'));
}

function spillOf(text, opts) {
  const o = opts || {};
  if (o.spill === false) return { path: '', error: '' };
  try {
    const saved = SpillStore.saveTextSync({
      sessionId: o.sessionId || 'anonymous',
      suggestedName: String(o.toolName || 'tool') + (o.callId ? '-' + String(o.callId) : '') + '.txt',
      content: text,
    });
    return { path: saved.path, error: '', bytes: saved.bytes };
  } catch (e) {
    return { path: '', error: String((e && e.code) || 'SPILL_IO') };
  }
}

/** 按 code point 计长度（Array.from 展开后长度即 code point 数）。 */
function codePointLength(s) {
  const str = String(s == null ? '' : s);
  return Array.from(str).length;
}

/** 解析并校验配置；非法值直接抛错（fail-loud，不静默兜底）。 */
function resolveConfig(cfg) {
  const o = cfg || {};
  const thresholdChars = o.thresholdChars == null ? DEFAULTS.thresholdChars : Number(o.thresholdChars);
  const headChars = o.headChars == null ? DEFAULTS.headChars : Number(o.headChars);
  const tailChars = o.tailChars == null ? DEFAULTS.tailChars : Number(o.tailChars);
  for (const [k, v] of [['thresholdChars', thresholdChars], ['headChars', headChars], ['tailChars', tailChars]]) {
    if (!Number.isInteger(v) || v < 0) throw new Error('tool-result-pruner: ' + k + ' 必须是非负整数，收到 ' + v);
  }
  if (thresholdChars < 1) throw new Error('tool-result-pruner: thresholdChars 必须 >= 1');
  if (headChars + tailChars >= thresholdChars) {
    throw new Error('tool-result-pruner: headChars + tailChars 必须小于 thresholdChars（否则裁剪不会变小）');
  }
  return { thresholdChars: thresholdChars, headChars: headChars, tailChars: tailChars };
}

/**
 * 裁剪一个工具结果字符串。
 * @param {string} content 原始内容
 * @param {object} [cfg] {thresholdChars, headChars, tailChars}
 * @param {object} [opts] {sessionId, toolName, callId, spill:boolean}
 * @returns {{content:string, pruned:boolean, charsBefore:number, charsAfter:number, omitted:number, spillPath:string, spillBytes:number, spillError:string}}
 */
function pruneText(content, cfg, opts) {
  const c = resolveConfig(cfg);
  const text = String(content == null ? '' : content);
  const points = Array.from(text);
  const before = points.length;
  if (before <= c.thresholdChars || alreadyPruned(text)) {
    return { content: text, pruned: false, charsBefore: before, charsAfter: before, omitted: 0, spillPath: '', spillBytes: 0, spillError: '' };
  }
  const omitted = before - c.headChars - c.tailChars;
  if (omitted <= 0) {
    return { content: text, pruned: false, charsBefore: before, charsAfter: before, omitted: 0, spillPath: '', spillBytes: 0, spillError: '' };
  }
  const spill = spillOf(text, opts);
  const head = points.slice(0, c.headChars).join('');
  const tail = c.tailChars > 0 ? points.slice(before - c.tailChars).join('') : '';
  const marker = pruneMarker(omitted, spill.path, spill.error);
  const out = head + marker + tail;
  return {
    content: out, pruned: true,
    charsBefore: before, charsAfter: Array.from(out).length, omitted,
    spillPath: spill.path, spillBytes: spill.bytes || 0, spillError: spill.error,
  };
}

/**
 * 裁剪一条回喂消息的内容。只处理字符串 content；数组式 content（多模态块）
 * 保持原样但按 text 块拼接判断是否超限——超限时整体退化成一个纯文本块，
 * 避免块结构半截保留造成模型困惑。
 */
function pruneContent(content, cfg, opts) {
  if (typeof content === 'string') return pruneText(content, cfg, opts).content;
  if (Array.isArray(content)) {
    const total = content.reduce((n, b) => n + (b && b.type === 'text' ? codePointLength(b.text) : 0), 0);
    const c = resolveConfig(cfg);
    if (total <= c.thresholdChars) return content;
    const joined = content.map((b) => (b && b.type === 'text' ? b.text : '')).join('\n');
    return pruneText(joined, cfg, opts).content;
  }
  return content;
}

/**
 * 批量裁剪 agent loop 的 tool 消息数组（原地不修改，返回新数组）。
 * 只处理 role==='tool' 的消息；其它角色原样透传。
 *
 * D3-06：`opts.sessionId` 决定 spill 目录；`m.name` / `m.tool_call_id` 只用于
 * 生成可读文件名，不参与安全边界（边界由 spill-store 自己编码）。
 */
function pruneToolMessages(messages, cfg, opts) {
  if (!Array.isArray(messages)) return [];
  const o = opts || {};
  return messages.map((m) => {
    if (!m || m.role !== 'tool') return m;
    const r = typeof m.content === 'string'
      ? pruneText(m.content, cfg, Object.assign({}, o, {
        toolName: m.name || o.toolName,
        callId: m.tool_call_id || m.callId || o.callId,
      }))
      : null;
    if (!r || !r.pruned) return m;
    const next = Object.assign({}, m, { content: r.content });
    if (r.spillPath) next.spillPath = r.spillPath;
    if (r.spillBytes) next.spillBytes = r.spillBytes;
    if (r.spillError) next.spillError = r.spillError;
    return next;
  });
}

module.exports = {
  DEFAULTS, resolveConfig,
  codePointLength, pruneMarker, alreadyPruned, pruneText, pruneContent, pruneToolMessages,
};
