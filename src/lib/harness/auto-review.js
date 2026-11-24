'use strict';
/**
 * Harness S5：自动授权审查内核（对标 deepseek-harness `experimental/auto-review`）
 *
 * 每次工具调用执行前，让审查模型按固定策略评估一次：低风险放行、
 * 高风险拒绝；拒绝时按模式决定是硬拒、还是转人工确认。
 *
 * 迁移边界（诚实声明）：
 *  · 迁移的是**纯逻辑**：固定策略提示词、JSON 决策解析（拒绝重复键/非法组合）、
 *    risk→decision 映射、ask/never/full 三模式决策树、错误码 AUTO_REVIEW_DENIED。
 *  · 不迁移 cordis 的 hooks/approval 会话系统——Genie 用注入的 reviewer 函数与
 *    ask 回调对接现有 UI，零新依赖、独立可测。
 *
 * 设计纪律：默认不开启（实验性插件）；审查模型失败一律**保守放行**并记 reason，
 * 绝不让"审查服务抖动"把整个 agent loop 卡死（与 relay 的 gate 故障放行一致）。
 */

const REVIEW_POLICY = `你是工具调用审查员。只输出一个 JSON，不要解释。
判定规则：
- risk=low → {"allow":true}
- risk=medium → {"allow":true} 或 {"deny":true,"reason":"..."}
- risk=high → {"deny":true,"reason":"..."}
reason 不超过 120 字。禁止输出其它字段。`;

/** 风险分级（本地确定性，不调用模型）：工具名 → 风险。未知工具按 medium。 */
const RISK = {
  get_document_info: 'low', list_pages: 'low', scan_nodes: 'low',
  audit_layout: 'low', audit_spacing: 'low', check_naming: 'low',
  list_todos: 'low',
  create_frame: 'medium', create_text: 'medium', create_rectangle: 'medium',
  set_text: 'medium', set_corner_radius: 'medium', set_layout: 'medium', align_nodes: 'medium',
  delete_node: 'high', duplicate_node: 'low', undo: 'medium', redo: 'medium',
  exec_js: 'high', export_node: 'medium',
};
function riskOf(name, args) {
  const n = String(name || '');
  if (RISK[n]) return RISK[n];
  // exec_js 即使换了名字，参数里带脚本也按高危
  if (args && typeof args.code === 'string') return 'high';
  return 'medium';
}

/**
 * 解析审查模型的输出。拒绝：重复键、非法组合、缺 allow/deny。
 * @returns {{ok:boolean, allow?:boolean, reason?:string, error?:string}}
 */
function parseDecision(text) {
  const raw = String(text == null ? '' : text).trim();
  // 去掉可能的代码围栏
  const body = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let obj;
  try { obj = JSON.parse(body); } catch (e) { return { ok: false, error: '审查输出不是合法 JSON' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: '审查输出不是对象' };
  const keys = Object.keys(obj);
  if (new Set(keys).size !== keys.length) return { ok: false, error: '审查输出有重复键' };
  const hasAllow = Object.prototype.hasOwnProperty.call(obj, 'allow');
  const hasDeny = Object.prototype.hasOwnProperty.call(obj, 'deny');
  if (hasAllow === hasDeny) return { ok: false, error: '审查输出必须且只能有 allow 或 deny 之一' };
  if (hasAllow) {
    if (obj.allow !== true) return { ok: false, error: 'allow 必须为 true' };
    return { ok: true, allow: true };
  }
  if (obj.deny !== true) return { ok: false, error: 'deny 必须为 true' };
  const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 120) : '';
  return { ok: true, allow: false, reason };
}

/**
 * 审查一次工具调用。
 * @param {object} call   {id, name, args}
 * @param {object} opts
 *   mode        'full' | 'ask' | 'never'（默认 full=不审查）
 *   reviewer    async ({system, tool, risk, args}) => text  审查模型（注入）
 *   ask         async ({tool, risk, reason}) => boolean      人工确认（ask 模式；注入）
 *   riskOf      可选：自定义风险分级函数
 * @returns {Promise<{decision:'allow'|'deny', code?:string, reason?:string, risk:string, via:string}>}
 */
async function review(call, opts) {
  const o = opts || {};
  const name = String((call && call.name) || '');
  const args = (call && call.args) || {};
  const risk = (typeof o.riskOf === 'function' ? o.riskOf(name, args) : riskOf(name, args)) || 'medium';
  const mode = o.mode || 'full';

  // full / 未开审查：直接放行
  if (mode === 'full' || typeof o.reviewer !== 'function') {
    return { decision: 'allow', risk, via: 'full' };
  }
  // low 风险无需问模型，直接放行（省一次云端调用）
  if (risk === 'low') return { decision: 'allow', risk, via: 'risk-low' };

  let parsed;
  try {
    const text = await o.reviewer({ system: REVIEW_POLICY, tool: name, risk, args });
    parsed = parseDecision(text);
  } catch (e) {
    // 审查服务异常 → 保守放行（可用性优先），如实记录
    return { decision: 'allow', risk, via: 'reviewer-error', reason: String((e && e.message) || e) };
  }
  if (!parsed.ok) {
    return { decision: 'allow', risk, via: 'parse-error', reason: parsed.error };
  }
  if (parsed.allow) return { decision: 'allow', risk, via: 'model' };

  // 模型判 deny
  if (mode === 'never') {
    return { decision: 'deny', code: 'AUTO_REVIEW_DENIED', risk, via: 'model',
      reason: parsed.reason || '审查模型拒绝该调用' };
  }
  // ask：转人工；无 ask 回调时保守拒绝（因为模型明确判了 deny）
  if (typeof o.ask === 'function') {
    let approved = false;
    try { approved = await o.ask({ tool: name, risk, reason: parsed.reason }); } catch (_) { approved = false; }
    if (approved) return { decision: 'allow', risk, via: 'human-override' };
  }
  return { decision: 'deny', code: 'AUTO_REVIEW_DENIED', risk, via: 'ask-denied',
    reason: parsed.reason || '审查模型拒绝，且未获人工批准' };
}

module.exports = { REVIEW_POLICY, RISK, riskOf, parseDecision, review };
