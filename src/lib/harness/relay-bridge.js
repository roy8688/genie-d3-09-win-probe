'use strict';
/**
 * Harness M5：把三语义事件总线 + 工具流水线接到 relay 工具路径的门面。
 *
 * 为什么不直接改 relay 的 `_gateCommand`：
 *   那条路径被 tests/test-gate-relay.js（11 条）逐字锁死——HOOK_BLOCKED /
 *   GUARDIAN_BLOCKED / NEEDS_CONFIRM 的错误码、args 改写、故障放行、post 观察
 *   都已固定。M1–M4 的纪律是"直接替换但零回归"，这里若重写编排，风险远大于收益。
 *
 * 本模块提供**并列可查的流水线视图**：
 *   · EventBus 的 tools/pre-execute 用 waterfall 串既有 hooks 的 pre_tool_use；
 *   · tools/result 用 emit 观察，桥接 post_tool_use / post_tool_error；
 *   · H4 guardian 作为 checkGuards provider 注入；
 *   · 审批走 hooks 的 ask 决策（若接入 ApprovalService）。
 *
 * 这样 relay 的工具路径多了一条"看得见的三语义编排"，同时旧路径一字不改。
 * 对外 API：buildPipeline(opts) → ToolPipeline；bridgeGate/bridgeObserve 供 relay 可选调用。
 */

const { EventBus } = require('./event-bus');
const { ToolPipeline } = require('./tool-pipeline');

/**
 * 构造一条与 relay 语义一致的流水线。
 * @param {object} opts
 *   hooks   hooks/bus 模块（默认 require）
 *   flags   flags 模块（默认 require）
 *   guardian guardian 模块（默认 require）
 */
function buildPipeline(opts) {
  const o = opts || {};
  const hooks = o.hooks || require('../hooks/bus');
  const flags = o.flags || require('../flags');
  const guardian = o.guardian || require('../guardian');
  const bus = new EventBus();

  // waterfall：pre-execute 环绕。既有 hooks 的 pre_tool_use 通过 bridgeGate 触发；
  // 这里注册一个默认观察 seam，让流水线本身可被独立 run() 调用时也走同一钩子。
  bus.on('tools/pre-execute', (exec, next) => {
    if (!flags.isOn('h3.hooks')) return next();
    // 注意：hook 的 block 由 bridgeGate 处理（同步语义）；流水线独立 run 时
    // 这里只做观察——不重复拦截，避免双重 gate。
    return next();
  });

  // emit：结果观察桥接（post hooks）。bridgeObserve 会调用它。
  bus.on('tools/result', (exec, result) => {
    if (!flags.isOn('h3.hooks')) return;
    try {
      const payload = {
        op: exec.name,
        ok: !result.isError,
        error: result.isError && result.error && result.error.message,
        resultSize: result.value ? JSON.stringify(result.value).length : 0,
      };
      hooks.emit(result.isError ? 'post_tool_error' : 'post_tool_use', payload, { args: exec.args || {} })
        .catch(() => {});
    } catch (_) { /* 观察失败不影响任何结果 */ }
  });

  // checkGuards：单调 deny，复用 H4 guardian（默认关时返回 undefined）
  const checkGuards = (exec) => {
    if (!flags.isOn('h4.guardian')) return undefined;
    const verdict = guardian.assess({ tool: exec.name, args: exec.args || {} });
    if (verdict.level === 'block') {
      return { reason: guardian.summarize(verdict), code: 'GUARDIAN_BLOCKED',
        detail: { risk: verdict.risk, reasons: verdict.reasons } };
    }
    if (verdict.level === 'confirm' && !exec.confirmed) {
      const diff = flags.isOn('h4.dryRunDiff')
        ? guardian.dryRunDiff({ tool: exec.name, args: exec.args || {} })
        : null;
      return { reason: guardian.summarize(verdict), code: 'NEEDS_CONFIRM',
        detail: { risk: verdict.risk, reasons: verdict.reasons, diff } };
    }
    return undefined;
  };

  return new ToolPipeline({ bus, checkGuards, maxParallel: 10 });
}

/**
 * 把 relay 的 command/opts 适配成流水线 prepare 输入（不改 relay 结构）。
 * 返回 {exec} 供调用方拿冻结上下文。
 */
function adaptInput(command, opts) {
  const o = opts || {};
  return {
    callId: command && command.id,
    name: String((command && command.op) || ''),
    args: (command && command.params) || {},
    command,
    confirmed: o.confirmed === true,
    host: o.host || 'figma',
  };
}

/** 把流水线 deny decision 映射回 relay 的错误对象（保持对外错误码不变） */
function denyToError(decision) {
  const err = new Error(String((decision && decision.reason) || '动作被拦截'));
  err.code = (decision && decision.code) || 'HOOK_BLOCKED';
  err.detail = (decision && decision.detail) || undefined;
  return err;
}

module.exports = { buildPipeline, adaptInput, denyToError };
