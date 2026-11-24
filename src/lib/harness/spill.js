'use strict';
/**
 * 大输出落盘（对标 DeepSeek Harness `spill/`）
 *
 * 问题：工具结果超大的时候，纯裁剪（tool-result-pruner）会把中段**扔掉**——
 * 信息就真没了。模型的正确做法常常是"先看头，需要时再细看某一段"，
 * 裁剪却把它变成了单向损失。
 *
 * spill 的思路：超过阈值就把完整内容落盘，只把**头部摘要 + 文件路径**回喂模型。
 * 模型需要细节时可以再发一次更精确的调用（或用读文件工具读那段）。
 * 上下文省了，信息也没丢。
 *
 * 与 Harness 的差异（诚实声明）：
 *  · Harness 的 spill 是服务 + 策略包，带引用句柄与回收策略；
 *  · Genie 这里是最小实现：落盘到 temp/spill/，按时间+工具名命名，回喂路径；
 *  · 不做自动回收（Harness 有 retention 策略），依赖 temp 目录本身的清理；
 *    落盘失败一律退回"只裁剪"，绝不让 spill 成为新的失败点。
 */

const SpillStore = require('./spill-store');

/** 默认阈值：超过 32KB 才落盘（8KB~32KB 交给 pruner 裁剪，够用且不产垃圾文件）。 */
const DEFAULT_THRESHOLD_BYTES = 32768;
/** 落盘后内联回喂的头部预算：3KB，足够模型判断"这是什么、要不要细看"。 */
const DEFAULT_INLINE_BYTES = 3072;

function byteLength(s) { return Buffer.byteLength(String(s == null ? '' : s), 'utf8'); }

/** 按字节取前缀（不切多字节字符）。 */
function headByBytes(s, maxBytes) {
  const str = String(s == null ? '' : s);
  let bytes = 0;
  let out = '';
  for (const ch of str) {
    const b = byteLength(ch);
    if (bytes + b > maxBytes) break;
    bytes += b;
    out += ch;
  }
  return out;
}

/** 安全化文件名片段。 */
function safeName(s) {
  return String(s || 'output').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40);
}

/**
 * 判断是否需要落盘，需要则落盘并生成回喂内容。
 *
 * @param {object} p
 * @param {string} p.content     工具原始结果
 * @param {string} [p.toolName]  工具名（用于文件名与提示）
 * @param {string} [p.dir]      落盘目录（默认由调用方注入 paths.temp/spill）
 * @param {number} [p.thresholdBytes]
 * @param {number} [p.inlineBytes]
 * @returns {{content:string, spilled:boolean, path?:string, bytes:number}}
 */
function maybeSpill(p) {
  const o = p || {};
  const text = String(o.content == null ? '' : o.content);
  const bytes = byteLength(text);
  const threshold = Number.isInteger(o.thresholdBytes) ? o.thresholdBytes : DEFAULT_THRESHOLD_BYTES;
  const inline = Number.isInteger(o.inlineBytes) ? o.inlineBytes : DEFAULT_INLINE_BYTES;

  // 未超阈值 / 没有目录 / 空内容：原样返回
  if (bytes <= threshold || !o.dir || !text) {
    return { content: text, spilled: false, bytes: bytes };
  }

  const dir = o.dir ? String(o.dir) : SpillStore.rootDir();
  let saved;
  try {
    // D3-06：统一走 spill-store（私有 0700 / 文件 0600 / session 隔离 / 安全文件名）。
    // 旧实现直接 writeFileSync 到 temp/spill，既没有权限保护，也会被缓存清理误删。
    saved = SpillStore.saveTextSync({
      root: dir,
      sessionId: o.sessionId || 'anonymous',
      suggestedName: safeName(o.toolName) + '.txt',
      content: text,
    });
  } catch (_) {
    // 落盘失败：原样交回，让上层 pruner 兜底裁剪（不抛错、不中断循环）
    return { content: text, spilled: false, bytes: bytes, error: 'spill_failed' };
  }
  const file = saved.path;

  const head = headByBytes(text, inline);
  const lines = text.split('\n').length;
  return {
    content: head
      + '\n\n…（完整内容 ' + bytes + ' 字节 / ' + lines + ' 行，已保存到：' + file + '）'
      + '\n（需要细节时请缩小查询范围或直接读取该文件的指定片段）',
    spilled: true,
    path: file,
    bytes: bytes,
  };
}

module.exports = { DEFAULT_THRESHOLD_BYTES, DEFAULT_INLINE_BYTES, maybeSpill, headByBytes, byteLength };
