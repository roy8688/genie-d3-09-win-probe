'use strict';
/**
 * 工具超时策略（D3-06）
 *
 * 对标 DSH `guard/timeout-policy` + `util/timeout`，但只保留 Genie 真正需要的那一层：
 *
 *  · **按工具预算**，不是“所有工具一律 60 秒”。读文件不该和跑构建共用同一根尺子。
 *  · **只通过 AbortSignal 通知**，超时后由能力自己停（shell 杀进程组、终端 kill、
 *    后台 job kill）；本模块不假装能替别人停掉工作。
 *  · **结构化 TOOL_TIMEOUT**：`{code, name, message, info:{toolName, timeoutMs}}`，
 *    调用方不必靠字符串猜“这是不是超时”。
 *  · 到点先给结构化结果，再 abort；工具若忽略 abort 继续跑，结果会被丢弃，
 *    但不会产生 unhandledRejection，也不会把 turn 永久挂住。
 *
 * 与旧 `Guards.withTimeout` 的差异：旧实现是 Promise.race，超时后底层还在跑，且没有
 * 工具预算概念。这里保留 `withTimeout` 给既有测试/别的调用方，但 relay 的工具执行
 * 统一改走本模块。
 */

const fs = require('node:fs');
const path = require('node:path');
const paths = require('../paths');

const TOOL_TIMEOUT = 'TOOL_TIMEOUT';
const TOOL_ABORTED = 'TOOL_ABORTED';

const DEFAULT_MS = 60000;
const MAX_MS = 600000;

/** 每工具默认预算。未列出的工具用 DEFAULT_MS。 */
const DEFAULT_BUDGETS = Object.freeze({
  shell_exec: 120000,
  job_start: 15000,
  job_wait: 30000,
  job_output: 10000,
  job_kill: 10000,
  terminal_start: 30000,
  terminal_exec: 60000,
  terminal_write: 10000,
  terminal_read: 10000,
  terminal_kill: 10000,
  lsp: 60000,
  web_fetch: 45000,
  web_search: 45000,
  fs_read: 30000,
  fs_write: 30000,
  fs_list: 30000,
  grep: 30000,
  glob: 30000,
  apply_patch: 30000,
  str_replace_editor: 30000,
  read_image: 30000,
});

function configFile() {
  if (process.env.GENIE_TIMEOUT_CONFIG) return process.env.GENIE_TIMEOUT_CONFIG;
  const dataFile = path.join(paths.config, 'timeout.json');
  // 打包态数据根可能不会复制 config/；代码根里的默认配置仍然可用。
  if (!fs.existsSync(dataFile)) {
    const rootFile = path.join(paths.root || paths.dataRoot || '', 'config', 'timeout.json');
    if (rootFile !== dataFile && fs.existsSync(rootFile)) return rootFile;
  }
  return dataFile;
}

function asMs(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error('timeout-policy: ' + name + ' 必须是非负数，收到 ' + v);
  return n;
}

/**
 * 读取配置。缺文件 = 用内置默认；文件存在但非法 = 抛错（不静默降级）。
 * @returns {{defaultMs:number,maxMs:number,tools:Object<string,number>}}
 */
function loadConfig() {
  const file = configFile();
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { defaultMs: DEFAULT_MS, maxMs: MAX_MS, tools: Object.assign({}, DEFAULT_BUDGETS) };
    }
    throw new Error('timeout-policy: 配置读取失败（' + file + '）：' + ((e && e.message) || e));
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('timeout-policy: 配置必须是对象（' + file + '）');
  }
  const defaultMs = raw.defaultMs == null ? DEFAULT_MS : asMs(raw.defaultMs, 'defaultMs');
  const maxMs = raw.maxMs == null ? MAX_MS : asMs(raw.maxMs, 'maxMs');
  if (maxMs <= 0 || defaultMs <= 0) throw new Error('timeout-policy: defaultMs/maxMs 必须 > 0');
  if (defaultMs > maxMs) throw new Error('timeout-policy: defaultMs 不能大于 maxMs');
  const tools = Object.assign({}, DEFAULT_BUDGETS);
  if (raw.tools != null) {
    if (typeof raw.tools !== 'object' || Array.isArray(raw.tools)) {
      throw new Error('timeout-policy: tools 必须是对象');
    }
    for (const [name, value] of Object.entries(raw.tools)) {
      const ms = asMs(value, 'tools.' + name);
      if (ms > maxMs) throw new Error('timeout-policy: tools.' + name + ' 不能大于 maxMs');
      tools[name] = ms;
    }
  }
  return { defaultMs, maxMs, tools };
}

/**
 * 取一个工具的超时预算。
 * @param {string} toolName
 * @param {{requested?:number, config?:object, minMs?:number}} [opts]
 * @returns {number} 0 表示“本次不设超时”（内部哨兵，调用方必须显式处理）
 */
function budgetFor(toolName, opts) {
  const o = opts || {};
  const cfg = o.config || loadConfig();
  const name = String(toolName || '');
  const table = Object.prototype.hasOwnProperty.call(cfg.tools, name) ? cfg.tools[name] : cfg.defaultMs;
  const requested = o.requested == null ? table : Number(o.requested);
  if (!Number.isFinite(requested) || requested < 0) {
    throw new Error('timeout-policy: ' + name + ' 的 timeoutMs 必须是非负数，收到 ' + o.requested);
  }
  if (requested === 0) return 0;
  const minMs = o.minMs == null ? 1 : Math.max(0, Number(o.minMs));
  return Math.min(cfg.maxMs, Math.max(minMs, requested));
}

/** 结构化超时错误；`info` 让调用方可直接展示而不必解析中文文案。 */
function timeoutError(toolName, timeoutMs) {
  const name = String(toolName || 'tool');
  const ms = Number(timeoutMs);
  const message = '工具调用超时：' + name + ' 超过 ' + ms + 'ms';
  return {
    code: TOOL_TIMEOUT,
    name: 'ToolTimeoutError',
    message,
    info: { name: 'ToolTimeoutError', code: TOOL_TIMEOUT, toolName: name, timeoutMs: ms },
  };
}

/**
 * 在一个预算内跑工具。
 *
 * @param {(signal:AbortSignal)=>Promise<any>|any} fn 真实工具执行；必须把 signal 往下传
 * @param {{toolName:string, timeoutMs?:number, signal?:AbortSignal, onTimeout?:Function, config?:object}} opts
 * @returns {Promise<{ok:true,value:any}|{ok:false,error:object}>}
 */
async function runTool(fn, opts) {
  const o = opts || {};
  const toolName = String(o.toolName || 'tool');
  const timeoutMs = o.timeoutMs == null ? budgetFor(toolName, { config: o.config }) : Number(o.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return { ok: false, error: { code: 'TOOL_TIMEOUT_CONFIG', name: 'ToolTimeoutConfigError', message: '非法超时预算：' + o.timeoutMs } };
  }

  // 0 = 内部“无超时”哨兵。调用方显式传 0 才可能到这里（budgetFor 不会返回 0）。
  if (timeoutMs === 0) {
    try { return { ok: true, value: await Promise.resolve(fn(o.signal || null)) }; }
    catch (e) { return { ok: false, error: { code: 'TOOL_ERROR', name: 'ToolError', message: String((e && e.message) || e) } }; }
  }

  const controller = new AbortController();
  let timedOut = false;
  let settled = false;
  let timer = null;

  const upstream = o.signal || null;
  const onUpstreamAbort = () => {
    if (timedOut) return;
    try { controller.abort(upstream.reason); } catch (_) {}
  };
  if (upstream) {
    if (upstream.aborted) onUpstreamAbort();
    else upstream.addEventListener('abort', onUpstreamAbort, { once: true });
  }

  const work = Promise.resolve()
    .then(() => fn(controller.signal))
    .then(
      (value) => (timedOut ? { __late: true } : { ok: true, value }),
      (e) => (timedOut ? { __late: true } : {
        ok: false,
        error: {
          code: (e && e.code) || 'TOOL_ERROR',
          name: (e && e.name) || 'ToolError',
          message: String((e && e.message) || e),
        },
      })
    );

  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try { if (typeof o.onTimeout === 'function') o.onTimeout({ toolName, timeoutMs }); } catch (_) { /* 观测回调不得影响主流程 */ }
      try { controller.abort(Object.assign(new Error('超时'), { code: TOOL_TIMEOUT })); } catch (_) {}
      resolve({ ok: false, error: timeoutError(toolName, timeoutMs) });
    }, timeoutMs);
  });

  let result;
  try {
    result = await Promise.race([work, timeout]);
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    if (upstream) upstream.removeEventListener('abort', onUpstreamAbort);
  }

  // 迟到的成功/失败已经被 work 的 then 消费；这里不 race/abandon 工具 promise，
  // 只丢弃结果，保证没有 unhandledRejection。
  if (result && result.__late) {
    return { ok: false, error: timeoutError(toolName, timeoutMs) };
  }
  return result;
}

/** 诊断用：当前预算表 + 配置来源。 */
function status() {
  const cfg = loadConfig();
  return { ok: true, source: configFile(), defaultMs: cfg.defaultMs, maxMs: cfg.maxMs, tools: cfg.tools };
}

module.exports = {
  TOOL_TIMEOUT, TOOL_ABORTED,
  DEFAULT_MS, MAX_MS, DEFAULT_BUDGETS,
  loadConfig, budgetFor, timeoutError, runTool, status,
};
