'use strict';
/**
 * 上下文压缩与检查点（P0-4）—— 对标 DSH `compaction/compaction`
 *
 * 为什么不能只做「工具结果裁剪」：
 *   裁剪只解决“单条 tool 输出太大”，解决不了“40 轮历史把 system 顶出窗口”。
 *   本地 4B 的 numCtx 只有 2048，云端模型也有窗口上限；历史一旦超限，
 *   最前面的 system（人格/权限/工作区）先被丢掉，模型就开始答非所问。
 *
 * 本模块做三件事：
 *   ① **保留 head**：system 与最初一条用户任务不压，任务目标不能丢；
 *   ② **保留最近轮次**：从尾部按预算取，且保证 assistant(tool_calls) 与
 *      role:tool 不被切断（DSH `tool-pairing` 的同一语义）；
 *   ③ **可解释的摘要**：优先调用注入的 summarize（模型生成），失败或未注入时
 *      用确定性摘要兜底。绝不让压缩失败阻断对话。
 *
 * 纪律：
 *   · 纯逻辑，不写会话；检查点由调用方通过 SessionLog 追加 `session/compaction`；
 *   · 不改入参 messages，返回新数组；
 *   · 压缩结果必须可回放：摘要里保留“谁说了什么事实”，不只保留“已压缩”一句话。
 */

const DEFAULT_MAX_CHARS = 24000;
const DEFAULT_TAIL_RATIO = 0.55;
const DEFAULT_HEAD_MESSAGES = 2;   // 非 system 的头部保留条数（通常 user + assistant）

/** D1-11：预算可以由 token meter 驱动；char 预算仍保留给旧调用方。 */
function estimateTokens(messages) {
  try {
    const TL = require('../token-ledger');
    if (typeof TL.estimateMessages === 'function') return TL.estimateMessages(messages || []);
  } catch (_) {}
  return Math.ceil(estimateChars(messages) / 3);
}

function messageTokens(m) {
  try {
    const TL = require('../token-ledger');
    if (typeof TL.estimate === 'function') {
      return TL.estimate(m && m.content) + (Array.isArray(m && m.tool_calls) ? TL.estimate(JSON.stringify(m.tool_calls)) : 0);
    }
  } catch (_) {}
  return Math.ceil((String((m && m.content) || '').length + (Array.isArray(m && m.tool_calls) ? 100 : 0)) / 3);
}

/** 从尾部按 token 预算取最近消息，保证不切开 tool 配对。 */
function tailWindowTokens(messages, budgetTokens) {
  let used = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = messageTokens(messages[i]);
    if (used + t > budgetTokens && start < messages.length) break;
    used += t;
    start = i;
  }
  return safeCut(messages, start);
}

function estimateChars(messages) {
  let n = 0;
  for (const m of messages || []) {
    if (!m) continue;
    n += String(m.content == null ? '' : m.content).length;
    if (Array.isArray(m.tool_calls)) {
      try { n += JSON.stringify(m.tool_calls).length; } catch (_) { n += 200; }
    }
  }
  return n;
}

function roleOf(m) { return String((m && m.role) || ''); }

/** 判断一条消息是否是“工具结果”，它必须紧跟带 tool_calls 的 assistant。 */
function isToolMessage(m) { return roleOf(m) === 'tool'; }

/**
 * 把切点向前挪到一个合法的消息边界：
 *   · 不能以 role:tool 开头（会失去配对的 assistant）；
 *   · 如果切点前一条是 assistant(tool_calls)，要么连它一起保留，要么整组丢掉。
 * 返回新的 start 索引（可能比原 cut 更小）。
 */
function safeCut(messages, cut) {
  let i = Math.max(0, Math.min(messages.length, cut));
  while (i > 0 && isToolMessage(messages[i])) i--;
  if (i > 0 && roleOf(messages[i - 1]) === 'assistant' && Array.isArray(messages[i - 1].tool_calls)) {
    // 切点正好落在 tool 结果之后：保留前一条 assistant 才能配对。
    i -= 1;
  }
  return i;
}

/** 从尾部按字符预算取最近消息，保证不切开 tool 配对。 */
function tailWindow(messages, budgetChars) {
  let used = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const len = String((m && m.content) || '').length + (Array.isArray(m && m.tool_calls) ? 100 : 0);
    if (used + len > budgetChars && start < messages.length) break;
    used += len;
    start = i;
  }
  return safeCut(messages, start);
}

/** 确定性摘要：只取用户说过的事实与助手最终结论，不搬 tool 原文。 */
function fallbackSummary(dropped, opts) {
  const o = opts || {};
  const maxLines = Number(o.maxLines || 10);
  const maxChars = Number(o.maxChars || 900);
  const lines = [];
  let inTool = false;
  for (const m of dropped || []) {
    if (isToolMessage(m)) { inTool = true; continue; }
    if (inTool && roleOf(m) !== 'user' && roleOf(m) !== 'assistant') continue;
    inTool = false;
    const role = roleOf(m);
    if (role !== 'user' && role !== 'assistant') continue;
    const text = String(m.content || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const label = role === 'user' ? '用户' : 'Genie';
    lines.push('- ' + label + '：' + text.slice(0, 90) + (text.length > 90 ? '…' : ''));
    if (lines.length >= maxLines) break;
  }
  let body = lines.join('\n');
  if (body.length > maxChars) body = body.slice(0, maxChars) + '\n…（更早内容已压缩）';
  return body || '（更早的对话没有可提取的文本）';
}

/**
 * 压缩一组 OpenAI messages。
 *
 * @param {Array} messages 原消息（可含 system / user / assistant / tool）
 * @param {object} opts {
 *   maxChars=24000, tailRatio=.55, headMessages=2,
 *   summarize=async({dropped, kept, stats})=>string,  // 可选模型摘要
 *   force=false
 * }
 * @returns {Promise<{messages, compacted, summary, stats, droppedCount, beforeChars, afterChars}>}
 */
async function compactMessages(messages, opts) {
  const o = opts || {};
  const input = Array.isArray(messages) ? messages.map((m) => Object.assign({}, m)) : [];
  const maxChars = Math.max(2000, Number(o.maxChars || DEFAULT_MAX_CHARS));
  const maxTokens = Number(o.maxTokens || 0);
  const beforeChars = estimateChars(input);
  const beforeTokens = maxTokens ? estimateTokens(input) : 0;
  const headMessages = Math.max(0, Number(o.headMessages == null ? DEFAULT_HEAD_MESSAGES : o.headMessages));
  const base = {
    beforeChars,
    beforeTokens,
    maxChars,
    maxTokens,
    headMessages,
    totalMessages: input.length,
  };
  if (!o.force && (maxTokens ? beforeTokens <= maxTokens : beforeChars <= maxChars)) {
    return {
      messages: input, compacted: false, summary: '', droppedCount: 0,
      beforeChars, afterChars: beforeChars,
      beforeTokens, afterTokens: beforeTokens,
      stats: Object.assign({}, base, { afterChars: beforeChars, afterTokens: beforeTokens, droppedCount: 0 }),
    };
  }

  const system = [];
  let restStart = 0;
  while (restStart < input.length && roleOf(input[restStart]) === 'system') {
    system.push(input[restStart]);
    restStart += 1;
  }
  const rest = input.slice(restStart);
  if (!rest.length) {
    return {
      messages: input, compacted: false, summary: '', droppedCount: 0,
      beforeChars, afterChars: beforeChars,
      stats: Object.assign({}, base, { afterChars: beforeChars, droppedCount: 0 }),
    };
  }

  const headStart = 0;
  let headEnd = Math.min(headMessages, rest.length);
  // 头部若正好停在 assistant(tool_calls) 上，必须把紧随其后的 tool 结果一起留下，
  // 否则保留下来的是一个“有 tool_calls 却没有结果”的非法请求。
  if (headEnd > headStart && roleOf(rest[headEnd - 1]) === 'assistant' && Array.isArray(rest[headEnd - 1].tool_calls)) {
    while (headEnd < rest.length && isToolMessage(rest[headEnd])) headEnd += 1;
  }
  // 头部也不能把预算吃掉：如果 head 自己就超了 1/4 预算，退化成只保最初一条用户消息。
  const headBudget = maxTokens ? Math.floor(maxTokens * 0.25) : Math.floor(maxChars * 0.25);
  const headOver = maxTokens ? estimateTokens(rest.slice(0, headEnd)) > headBudget : estimateChars(rest.slice(0, headEnd)) > headBudget;
  if (headEnd > 1 && headOver) headEnd = 1;
  const head = rest.slice(headStart, headEnd);
  const headChars = estimateChars(head);
  const headTokens = maxTokens ? estimateTokens(head) : 0;
  const tailBudget = maxTokens
    ? Math.max(120, Math.floor((maxTokens - headTokens - 300) * (Number(o.tailRatio) || DEFAULT_TAIL_RATIO)))
    : Math.max(400, Math.floor((maxChars - headChars) * (Number(o.tailRatio) || DEFAULT_TAIL_RATIO)));
  const tailStart = maxTokens ? tailWindowTokens(rest, tailBudget) : tailWindow(rest, tailBudget);
  if (tailStart <= head.length) {
    return {
      messages: input, compacted: false, summary: '', droppedCount: 0,
      beforeChars, afterChars: beforeChars,
      beforeTokens, afterTokens: beforeTokens,
      stats: Object.assign({}, base, { afterChars: beforeChars, afterTokens: beforeTokens, droppedCount: 0 }),
    };
  }

  const dropped = rest.slice(head.length, tailStart);
  const tail = rest.slice(tailStart);
  let summary = '';
  if (typeof o.summarize === 'function' && dropped.length) {
    try {
      summary = String(await o.summarize({
        dropped, kept: system.concat(head, tail),
        stats: Object.assign({}, base, { droppedCount: dropped.length }),
      }) || '').trim();
    } catch (_) { summary = ''; }
  }
  if (!summary) summary = fallbackSummary(dropped, o);

  const summaryMsg = {
    role: 'user',
    content: '【早前对话压缩摘要】\n' + summary
      + '\n（以上是更早内容的压缩记录；需要原文时再向用户确认，不要凭摘要编细节。）',
    synthetic: 'compaction',
    ts: Date.now(),
  };
  const out = system.concat(head, [summaryMsg], tail);
  const afterChars = estimateChars(out);
  const afterTokens = maxTokens ? estimateTokens(out) : 0;
  return {
    messages: out,
    compacted: true,
    summary,
    droppedCount: dropped.length,
    beforeChars,
    afterChars,
    beforeTokens,
    afterTokens,
    stats: Object.assign({}, base, {
      afterChars,
      afterTokens,
      droppedCount: dropped.length,
      keptHead: head.length,
      keptTail: tail.length,
      summaryChars: summary.length,
    }),
  };
}

/**
 * 检查点：把一次压缩事实追加到会话日志。
 * 不写消息内容，只写“压缩了哪些区间、摘要多长、前后字符数”，便于回放与审计。
 */
function appendCheckpoint(log, result, meta) {
  if (!log || typeof log.append !== 'function') return null;
  const r = result || {};
  const m = Object.assign({}, meta || {});
  const payload = {
    beforeChars: r.beforeChars || 0,
    afterChars: r.afterChars || 0,
    beforeTokens: r.beforeTokens || 0,
    afterTokens: r.afterTokens || 0,
    droppedCount: r.droppedCount || 0,
    summaryChars: String(r.summary || '').length,
    summaryPreview: String(r.summary || '').slice(0, 240),
    meta: m,
  };
  // 手动压缩要“真的用上”摘要：模型下一轮不再拿到被压缩的旧消息，
  // 改由 system 里的这段摘要接管。自动压缩只存预览（避免无谓写盘）。
  if (m.storeSummary) payload.summary = String(r.summary || '').slice(0, 4000);
  return log.append('session/compaction', payload);
}

module.exports = {
  DEFAULT_MAX_CHARS, DEFAULT_TAIL_RATIO,
  estimateChars, estimateTokens, safeCut, tailWindow, tailWindowTokens, fallbackSummary,
  compactMessages, appendCheckpoint,
};
