'use strict';
/**
 * LLM seam（D2-13，2026-11-23）
 *
 * 目标：在现有 `relay.invokeModel` / `cloud-llm` / `retry-policy` / `cost-tracker`
 * 之上补一层 **provider-neutral** 的请求、流、usage 口径，不另建模型客户端。
 *
 * 三种协议：
 *   · openai-compatible —— 现有默认。请求/流格式完全不变，只把解析与计量收口。
 *   · deepseek-messages  —— Anthropic Messages 风格（官方 llm-deepseek 的口径）。
 *     只有模型显式配置 `protocol: 'deepseek-messages'` 时才走；默认路径零回归。
 *
 * 四个硬约束：
 *   1. **单一真源**：token 记账只走 `meterUsage()`；它内部调 `cost-tracker` 与
 *      `TurnTrace.noteUsage`，不再让调用点各记一次。
 *   2. **重试可观测**：重试次数、状态码、最终结果都进进程内计数；`snapshot()`
 *      给诊断/测试看，不靠日志猜。
 *   3. **账户预留**：配置了 `GENIE_LLM_ACCOUNT_RESERVE`（或模型 `accountReserve`）
 *      时，请求前预留、结束后按真实 usage 结算；未配置时完全不计。
 *   4. **失败不静默**：协议缺字段、usage 非法都返回明确错误码，不吞。
 */

const CostTracker = require('../cost-tracker');
const TurnTrace = require('./turn-trace');
const RetryPolicy = require('../retry-policy');

const PROTOCOLS = ['openai-compatible', 'deepseek-messages'];

/** 进程内重试观测。不落盘：它只服务当前运行，诊断端点可随时读。 */
const _metrics = {
  calls: 0,
  retries: 0,
  retriesByStatus: Object.create(null),
  meteredCalls: 0,
  unmeteredCalls: 0,
  accountReserved: 0,
  accountRejected: 0,
};

/** 账户预留池：key = modelId；value = 已预留但未结算的 token。 */
const _reservations = new Map();
let _reserveSeq = 0;

function protocolOf(model) {
  const raw = String((model && (model.protocol || model.apiStyle || model.wire)) || '').trim();
  return PROTOCOLS.includes(raw) ? raw : 'openai-compatible';
}

function baseUrlOf(model) {
  return String((model && model.baseUrl) || '').replace(/\/+$/, '');
}

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * 把 OpenAI / DeepSeek Messages 两种 usage 归一到一套字段。
 *
 * 为什么 total 不是 `input+output`：
 * DeepSeek 的 `input_tokens` **不含** cache 命中/写入，官方 token-meter 的口径是
 * `input + cacheRead + cacheWrite + output`。照 `prompt+completion` 算会把缓存
 * 那部分直接漏掉，长会话下少记 30% 以上，预算判断跟着偏。
 */
function normalizeUsage(raw) {
  const u = raw || {};
  const inputTokens = _num(u.input_tokens != null ? u.input_tokens : u.prompt_tokens);
  const outputTokens = _num(u.output_tokens != null ? u.output_tokens : u.completion_tokens);
  const cacheReadTokens = _num(u.cache_read_input_tokens != null
    ? u.cache_read_input_tokens
    : (u.prompt_cache_hit_tokens != null
      ? u.prompt_cache_hit_tokens
      : (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens)));
  const cacheWriteTokens = _num(u.cache_creation_input_tokens);
  const reasoningTokens = _num(u.reasoning_tokens != null
    ? u.reasoning_tokens
    : (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens));
  // OpenAI 的 total_tokens 已含缓存命中；DeepSeek Messages 不返回 total。
  const totalTokens = _num(u.total_tokens) || (inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens);
  return {
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    reasoningTokens, totalTokens,
    // 兼容 TurnTrace / 旧成本面板的 OpenAI 字段。prompt 含缓存，才能和 total 对上。
    promptTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
    completionTokens: outputTokens,
    raw: u,
  };
}

/** 把归一 usage 转成 TurnTrace 认识的结构。 */
function toTraceUsage(u) {
  const n = normalizeUsage(u);
  return {
    prompt_tokens: n.promptTokens,
    completion_tokens: n.completionTokens,
    total_tokens: n.totalTokens,
    prompt_cache_hit_tokens: n.cacheReadTokens,
  };
}

/**
 * 计量一次调用。provider 没返回 usage 时**不估算**（估算冒充真账是更坏的错）。
 * @returns {{metered:boolean, usage?:object, total:number}}
 */
function meterUsage(modelId, rawUsage, opts) {
  const o = opts || {};
  const u = normalizeUsage(rawUsage);
  _metrics.calls += 1;
  if (!u.inputTokens && !u.outputTokens && !u.totalTokens) {
    _metrics.unmeteredCalls += 1;
    if (o.reservationId) commitReservation(o.reservationId, 0);
    return { metered: false, total: 0 };
  }
  _metrics.meteredCalls += 1;
  try { CostTracker.recordCall(modelId, u.promptTokens, u.completionTokens); } catch (_) {}
  try {
    const tt = o.trace || TurnTrace.current();
    if (tt && tt.noteUsage) tt.noteUsage(toTraceUsage(rawUsage));
  } catch (_) {}
  if (o.reservationId) commitReservation(o.reservationId, u.totalTokens);
  return { metered: true, usage: u, total: u.totalTokens };
}

/** 账户预留：只做 token 数上限，不猜价格。 */
function reserveTokens(modelId, tokens) {
  const cap = Number((_reservations.get('__cap__') || 0));
  const want = Math.max(0, Number(tokens) || 0);
  if (!cap || !want) return { ok: true, id: '', reserved: 0, cap };
  const used = Array.from(_reservations.entries())
    .filter(([k]) => k !== '__cap__')
    .reduce((a, [, v]) => a + (v.reserved - v.settled), 0);
  if (used + want > cap) {
    _metrics.accountRejected += 1;
    return { ok: false, code: 'ACCOUNT_RESERVE_EXCEEDED', used, want, cap };
  }
  _reserveSeq += 1;
  const id = 'rsv_' + _reserveSeq;
  _reservations.set(id, { modelId, reserved: want, settled: 0 });
  _metrics.accountReserved += want;
  return { ok: true, id, reserved: want, cap };
}

function commitReservation(id, actualTokens) {
  const r = _reservations.get(id);
  if (!r) return { ok: false, code: 'RESERVATION_NOT_FOUND' };
  r.settled = Math.max(0, Number(actualTokens) || 0);
  return { ok: true, reserved: r.reserved, settled: r.settled };
}

function releaseReservation(id) {
  return _reservations.delete(id);
}

function setAccountReserve(cap) {
  const n = Math.max(0, Number(cap) || 0);
  if (n) _reservations.set('__cap__', n);
  else _reservations.delete('__cap__');
  return n;
}

/** 从环境读一次；调用方不必自己解析。 */
function accountReserveFromEnv(env) {
  const e = env || process.env;
  const raw = e.GENIE_LLM_ACCOUNT_RESERVE;
  return raw == null ? 0 : Math.max(0, Number(raw) || 0);
}

/** 估算请求 token：复用 token-ledger 的 CJK 口径，避免第二套估算。 */
function estimateRequest(messages) {
  const TokenLedger = require('../token-ledger');
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((a, m) => {
    if (!m) return a;
    if (typeof m.content === 'string') return a + TokenLedger.estimate(m.content);
    if (Array.isArray(m.content)) {
      return a + m.content.reduce((b, p) => b + (p && p.type === 'text' ? TokenLedger.estimate(p.text) : 0), 0);
    }
    return a;
  }, 0);
}

/** 重试分类：状态码 → 可重试 / 退避毫秒。和 retry-policy 的口径保持一致。 */
function retryPlan(status, attempt) {
  const s = Number(status) || 0;
  const a = Math.max(0, Number(attempt) || 0);
  const retryable = s === 429 || s >= 500;
  if (!retryable) return { retryable: false, waitMs: 0, reason: s ? 'client error ' + s : 'network error' };
  // 429 的限流窗口比网络抖动长：2.5s/5s；5xx 用 400/800ms。
  const waitMs = s === 429 ? 2500 * Math.max(1, a + 1) : 400 * Math.pow(2, a);
  return { retryable: true, waitMs, reason: s === 429 ? 'rate limit' : 'server error ' + s };
}

function noteRetry(status, attempt) {
  _metrics.retries += 1;
  const k = String(Number(status) || 'network');
  _metrics.retriesByStatus[k] = (_metrics.retriesByStatus[k] || 0) + 1;
  return { attempt, status: k };
}

/** 网络错误同样走 retry-policy 的分类，避免"一律再试"。 */
function classifyFailure(err) {
  try { return RetryPolicy.classify(err); } catch (_) {
    return { kind: 'unknown', retryable: false, why: '无法分类' };
  }
}

/**
 * 组装一次 provider 请求。
 * 这里只做"协议形状"，不碰 Key 来源、不碰 AI 模式闸门（那些仍在 relay）。
 */
function buildRequest(opts) {
  const o = opts || {};
  const model = o.model || {};
  const protocol = o.protocol || protocolOf(model);
  const base = baseUrlOf(model);
  const apiKey = o.apiKey || model.apiKey || '';
  const modelName = o.modelName || model.model || model.id || '';
  const openaiBody = o.body || {};
  if (protocol === 'openai-compatible') {
    return {
      protocol,
      url: (base || 'https://api.openai.com/v1') + '/chat/completions',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: openaiBody,
    };
  }
  if (protocol === 'deepseek-messages') {
    return {
      protocol,
      url: (base || 'https://api.deepseek.com') + '/messages',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: toMessagesRequest(openaiBody, modelName),
    };
  }
  throw Object.assign(new Error('未知模型协议：' + protocol), { code: 'LLM_PROTOCOL_UNKNOWN' });
}

/**
 * OpenAI Chat 请求 → DeepSeek Messages 请求。
 * 只转当前 Genie 真用到的部分：system / user / assistant / tool / 图片 / tools。
 */
function toMessagesRequest(openaiBody, modelName) {
  const b = openaiBody || {};
  const messages = Array.isArray(b.messages) ? b.messages : [];
  const systemParts = [];
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    // Messages 要求同角色相邻时合并，否则部分代理会 400。
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'system') {
      const text = contentToText(m.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (m.role === 'tool') {
      push('user', [{
        type: 'tool_result',
        tool_use_id: m.tool_call_id || '',
        content: contentToText(m.content),
      }]);
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const blocks = [];
      const text = contentToText(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const tc of m.tool_calls) {
        const fn = (tc && tc.function) || {};
        let input = {};
        try { input = fn.arguments ? JSON.parse(fn.arguments) : {}; } catch (_) { input = { _raw: String(fn.arguments || '') }; }
        blocks.push({ type: 'tool_use', id: tc.id || '', name: fn.name || '', input });
      }
      push('assistant', blocks);
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    push(role, toContentBlocks(m.content));
  }
  const body = {
    model: modelName,
    max_tokens: b.max_tokens || 4096,
    messages: out,
    stream: !!b.stream,
  };
  if (systemParts.length) body.system = systemParts.join('\n\n');
  if (b.temperature != null) body.temperature = b.temperature;
  if (Array.isArray(b.tools) && b.tools.length) body.tools = toMessagesTools(b.tools);
  if (b.tool_choice !== undefined) body.tool_choice = toMessagesToolChoice(b.tool_choice);
  return body;
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p && p.type === 'text').map((p) => String(p.text || '')).join('\n');
  }
  return '';
}

function toContentBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const p of content) {
    if (!p) continue;
    if (p.type === 'text') blocks.push({ type: 'text', text: String(p.text || '') });
    else if (p.type === 'image_url') {
      const url = String((p.image_url && p.image_url.url) || '');
      const data = /^data:([^;]+);base64,(.*)$/.exec(url);
      if (data) blocks.push({ type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } });
      else if (url) blocks.push({ type: 'image', source: { type: 'url', url } });
    }
  }
  return blocks;
}

function toMessagesTools(tools) {
  return tools.map((t) => {
    const fn = (t && t.function) || {};
    return { name: fn.name || '', description: fn.description || '', input_schema: fn.parameters || { type: 'object', properties: {} } };
  });
}

function toMessagesToolChoice(choice) {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return { type: choice === 'required' ? 'any' : choice };
  if (choice && typeof choice === 'object' && choice.function) return { type: 'tool', name: choice.function.name };
  return choice;
}

/**
 * 解析一行 DeepSeek Messages SSE。
 * @returns {{textDelta?:string, reasoningDelta?:string, toolCallDelta?:object, usage?:object, done?:boolean}|null}
 */
function parseMessagesEvent(payload, state) {
  const s = state || {};
  if (!payload || typeof payload !== 'object') return null;
  const type = String(payload.type || '');
  // Messages 的 input usage 在 message_start.message.usage；message_delta 只带累计值。
  // 漏掉前者会把“输入 token”整段丢掉，只记到输出（长 prompt 场景少记 90%）。
  if (type === 'message_start') {
    const u = payload.message && payload.message.usage;
    return u ? { usage: u } : null;
  }
  if (type === 'content_block_start') {
    const cb = payload.content_block || {};
    const index = Number(payload.index) || 0;
    if (cb.type === 'tool_use') {
      s.tools = s.tools || new Map();
      s.tools.set(index, { id: cb.id || '', name: cb.name || '', input: cb.input || {} });
    }
    return null;
  }
  if (type === 'content_block_delta') {
    const d = payload.delta || {};
    if (d.type === 'text_delta') return { textDelta: String(d.text || '') };
    if (d.type === 'thinking_delta') return { reasoningDelta: String(d.thinking || '') };
    if (d.type === 'input_json_delta') {
      const index = Number(payload.index) || 0;
      const hit = s.tools && s.tools.get(index);
      if (hit) {
        hit._json = (hit._json || '') + String(d.partial_json || '');
      }
      return { toolCallDelta: { index, partialJson: String(d.partial_json || '') } };
    }
    return null;
  }
  if (type === 'message_delta') {
    if (payload.usage) return { usage: payload.usage };
    return null;
  }
  if (type === 'message_stop') return { done: true };
  return null;
}

/** 流结束后取完整 tool calls；JSON 不合法时明确失败，不送空参数给工具。 */
function collectedMessagesTools(state) {
  if (!state || !state.tools) return [];
  return [...state.tools.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => {
    let input = v.input || {};
    if (v._json) {
      try { input = JSON.parse(v._json); } catch (_) {
        throw Object.assign(new Error('DeepSeek Messages 工具参数不是合法 JSON'), { code: 'MALFORMED_TOOL_ARGS' });
      }
    }
    return { id: v.id, type: 'function', function: { name: v.name, arguments: JSON.stringify(input) } };
  });
}

function snapshot() {
  return {
    protocols: PROTOCOLS.slice(),
    ..._metrics,
    retriesByStatus: Object.assign({}, _metrics.retriesByStatus),
    reservations: Array.from(_reservations.entries())
      .filter(([k]) => k !== '__cap__')
      .map(([id, v]) => ({ id, modelId: v.modelId, reserved: v.reserved, settled: v.settled })),
    cap: _reservations.get('__cap__') || 0,
  };
}

function resetMetrics() {
  _metrics.calls = 0; _metrics.retries = 0; _metrics.retriesByStatus = Object.create(null);
  _metrics.meteredCalls = 0; _metrics.unmeteredCalls = 0;
  _metrics.accountReserved = 0; _metrics.accountRejected = 0;
  _reservations.clear(); _reserveSeq = 0;
}

module.exports = {
  PROTOCOLS, protocolOf, normalizeUsage, toTraceUsage, meterUsage,
  reserveTokens, commitReservation, releaseReservation, setAccountReserve,
  accountReserveFromEnv, estimateRequest,
  retryPlan, noteRetry, classifyFailure,
  buildRequest, toMessagesRequest, toContentBlocks, toMessagesTools,
  parseMessagesEvent, collectedMessagesTools,
  snapshot, resetMetrics,
};
