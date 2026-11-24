'use strict';
/**
 * Agent Loop 的三个守卫（对标 DeepSeek Harness guard/ 与 fs/ 下的策略包）
 *
 * ① RepeatReminder       ← guard/repeat-tool-reminder
 *    模型用完全相同的参数连续调同一个工具，是 agent loop 里最常见的死循环形态。
 *    Harness 的做法不是否决调用，而是**在结果后追加一条提醒**（先温和、后详细），
 *    让模型自己意识到"这条路已经走不通了"。
 *
 * ② ToolTimeout          ← guard/timeout-policy
 *    工具声明超时预算，超时映射成结构化 TOOL_TIMEOUT，而不是让整个 turn 挂着。
 *
 * ③ ObservationPolicy    ← fs/fs-observation-policy
 *    "改之前必须先看过"。Harness 对文件编辑强制此纪律（未读即拒绝，FS_NOT_OBSERVED）；
 *    Genie 映射到 Figma：**修改类工具要求本会话先做过读类调用**，否则拒绝并提示先 scan。
 *
 * 三者都是纯逻辑、无副作用、可独立测试；由 agent-loop 在合适时机调用。
 */

/* ------------------------------------------------------------------ *
 * ① 连续重复调用提醒
 * ------------------------------------------------------------------ */

const GENTLE_REMINDER =
  '你正在用完全相同的参数重复调用同一个工具。请先仔细分析上一次的返回结果：'
  + '如果任务还没完成，换一种做法或换一组参数，不要重复同一次调用。';

function detailedReminder(toolName, count, canonicalArgs) {
  return '检测到重复的工具调用：\n'
    + '- 工具：' + toolName + '\n'
    + '- 连续次数：' + count + '\n'
    + '- 参数：' + canonicalArgs + '\n'
    + '这些重复调用没有产生任何进展。不要再用这组完全相同的参数调用该工具；'
    + '请检查最新结果，改做别的动作、换参数，或者在已有证据足够时直接结束任务。';
}

/** 深排序 JSON 值，让只有键序不同的两个参数对象规范化成同一字符串。 */
function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortJsonValue(value[k]);
    return out;
  }
  return value;
}

/** 规范化参数：深排序后 stringify。 */
function canonicalize(args) {
  try { return JSON.stringify(sortJsonValue(args === undefined ? null : args)); }
  catch { return String(args); }
}

/** 把一个 `*` 通配符模式编译成锚定正则（其余正则元字符按字面量处理）。 */
function wildcardToRegExp(pattern) {
  const escaped = String(pattern).replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  return new RegExp('^' + escaped.split('*').join('.*') + '$');
}

/** 头截断参数预览，只影响提醒文案，不影响链键比较（链键始终用完整规范化串）。 */
function previewArguments(canonical, cap) {
  if (canonical.length <= cap) return canonical;
  return canonical.slice(0, cap) + '… (+' + (canonical.length - cap) + ' 字符)';
}

/** 校验阈值：非空、整数、>=2、不重复；返回升序数组（fail-loud，不静默兜底）。 */
function validateThresholds(values) {
  const arr = Array.isArray(values) ? values : [3, 5, 8];
  if (arr.length === 0) throw new Error('repeat-reminder: thresholds 不能为空');
  for (const v of arr) {
    if (!Number.isInteger(v) || v < 2) throw new Error('repeat-reminder: 阈值必须是不小于 2 的整数，收到 ' + v);
  }
  if (new Set(arr).size !== arr.length) throw new Error('repeat-reminder: thresholds 不能有重复值');
  return arr.slice().sort((a, b) => a - b);
}

class RepeatReminder {
  /**
   * @param {object} [opts]
   * @param {number[]} [opts.thresholds=[3,5,8]] 触发提醒的连续次数
   * @param {string[]} [opts.include] 只跟踪这些工具（通配符），空表示全部
   * @param {string[]} [opts.exclude] 不跟踪这些工具（既不计数也不重置）
   * @param {number} [opts.argumentsPreviewChars=500]
   */
  constructor(opts) {
    const o = opts || {};
    this.thresholds = validateThresholds(o.thresholds);
    this.thresholdSet = new Set(this.thresholds);
    this.include = (o.include || []).map(wildcardToRegExp);
    this.exclude = (o.exclude || []).map(wildcardToRegExp);
    this.previewChars = Number.isInteger(o.argumentsPreviewChars) ? o.argumentsPreviewChars : 500;
    if (this.previewChars < 1) throw new Error('repeat-reminder: argumentsPreviewChars 必须是 >=1 的整数');
    this.key = null;
    this.count = 0;
    this.lastReminder = null;
  }

  /** 该工具是否参与计数（未跟踪的调用是透明的：既不计数也不重置）。 */
  tracked(name) {
    const n = String(name || '');
    if (this.include.length > 0 && !this.include.some((re) => re.test(n))) return false;
    return !this.exclude.some((re) => re.test(n));
  }

  /**
   * 观测一次工具调用，必要时返回要追加给模型的提醒文本。
   * @returns {string|null}
   */
  observe(name, args) {
    const n = String(name || '');
    if (!this.tracked(n)) return null;
    const canonical = canonicalize(args);
    const key = n + '\u0000' + canonical;
    this.count = this.key === key ? this.count + 1 : 1;
    this.key = key;
    if (!this.thresholdSet.has(this.count)) return null;
    const text = this.count === this.thresholds[0]
      ? GENTLE_REMINDER
      : detailedReminder(n, this.count, previewArguments(canonical, this.previewChars));
    this.lastReminder = { tool: n, count: this.count, text: text };
    return text;
  }

  /** 重置链（用户插话、换回合时调用：跨用户输入的重复不算死循环）。 */
  reset() { this.key = null; this.count = 0; this.lastReminder = null; }

  /** 只读快照，供诊断端点。 */
  state() { return { count: this.count, keyed: this.key !== null, lastReminder: this.lastReminder }; }
}

/* ------------------------------------------------------------------ *
 * ② 工具超时
 * ------------------------------------------------------------------ */

const TOOL_TIMEOUT = 'TOOL_TIMEOUT';

/**
 * 给一次工具执行套上超时预算。
 *
 * 与 Harness 的差异：Harness 依赖协作式 `AbortSignal`（工具承诺响应 abort）；
 * Genie 的工具走 relay 指令通道，未必响应 abort，所以这里用 race 兜住——
 * **超时后返回结构化 TOOL_TIMEOUT，但底层 promise 仍会被 catch 掉，不产生 unhandledRejection**。
 *
 * @param {function} fn  async () => any
 * @param {number} timeoutMs
 * @param {object} [opts] {onTimeout}
 * @returns {Promise<{ok:boolean, value?:any, error?:{code,name,message}}>}
 */
function withTimeout(fn, timeoutMs, opts) {
  const o = opts || {};
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) {
    return Promise.resolve(fn()).then((v) => ({ ok: true, value: v }));
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const message = '工具调用超时：超过 ' + ms + 'ms';
      if (typeof o.onTimeout === 'function') { try { o.onTimeout({ timeoutMs: ms }); } catch { /* 观测回调不得影响主流程 */ } }
      resolve({ ok: false, error: { code: TOOL_TIMEOUT, name: 'ToolTimeoutError', message: message } });
    }, ms);
    Promise.resolve()
      .then(fn)
      .then((v) => {
        if (settled) return; // 已超时：结果丢弃，但 promise 已被消费，不会 unhandledRejection
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, value: v });
      })
      .catch((e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, error: { code: 'TOOL_ERROR', name: 'ToolError', message: String((e && e.message) || e) } });
      });
  });
}

/* ------------------------------------------------------------------ *
 * ③ 先读后写（观察策略）
 * ------------------------------------------------------------------ */

const FS_NOT_OBSERVED = 'FS_NOT_OBSERVED';

/**
 * 记录"本会话已经权威地看过什么"，并据此约束修改动作。
 *
 * Genie 映射：Figma 里没有文件版本号，所以不做 CAS（Harness 的 replaceIfVersion）；
 * 只做**存在性纪律**：写入/修改类工具要求本会话先有至少一次成功的读类观测，
 * 否则拒绝并给出"先 scan 再改"的明确提示。这拦的是"模型凭空想象画布现状就动手改"。
 */
class ObservationPolicy {
  constructor(opts) {
    const o = opts || {};
    /** @type {Set<string>} 已观测过的目标键 */
    this.observed = new Set();
    /**
     * 读类工具：本身当然允许执行，且成功后应标记"已观测"。
     * 必须显式声明——否则 get_document_info 会被"改前必读"误拦，
     * 变成"要读先读"的死锁。
     */
    this.readTools = new Set(o.readTools || []);
    /**
     * 未读过就允许的动作：默认放开纯新建（无覆盖风险），
     * 调用方还可追加"不触碰画布"的本地工具（如 todo_write / ask_user_question）——
     * 它们不改画布，纳入"先读后写"只会造出无意义的拦截。
     */
    this.allowUnobserved = new Set(['create_frame', 'create_text'].concat(o.allowUnobserved || []));
    this.enabled = o.enabled !== false;
  }

  /** 记录一次权威观测（读类工具成功后调用）。 */
  observe(targetKey) { this.observed.add(String(targetKey)); }

  /** 是否已观测过。 */
  has(targetKey) { return this.observed.has(String(targetKey)); }

  /** 该工具是否是读类（读类成功后应标记观测）。 */
  isReader(toolName) { return this.readTools.has(String(toolName)); }

  /**
   * 写前检查。
   * @param {string} toolName 即将调用的工具名
   * @param {string} targetKey 目标（默认 document）
   * @returns {{ok:boolean, code?:string, message?:string}}
   */
  requireObserved(toolName, targetKey) {
    if (!this.enabled) return { ok: true };
    const n = String(toolName);
    if (this.readTools.has(n)) return { ok: true };       // 读类：放行
    if (this.allowUnobserved.has(n)) return { ok: true };  // 纯新建：豁免
    if (this.observed.has(String(targetKey || 'document'))) return { ok: true };
    return {
      ok: false,
      code: FS_NOT_OBSERVED,
      message: '修改画布前需要先读取现状：请先调用 get_document_info 或 scan_nodes 了解当前文档/页面，再执行 ' + n + '。',
    };
  }

  /** 清空（新会话）。 */
  reset() { this.observed.clear(); }

  state() {
    return { observed: Array.from(this.observed), enabled: this.enabled, readTools: Array.from(this.readTools) };
  }
}

module.exports = {
  RepeatReminder, withTimeout, ObservationPolicy,
  TOOL_TIMEOUT, FS_NOT_OBSERVED,
  canonicalize, sortJsonValue, wildcardToRegExp, validateThresholds,
  GENTLE_REMINDER,
};
