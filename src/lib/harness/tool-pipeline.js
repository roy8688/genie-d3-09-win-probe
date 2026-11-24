'use strict';
/**
 * Harness M5：工具执行流水线（对标 DSH `packages/core/tools/src/pipeline.ts`）
 *
 * 五阶段（对齐 pipeline.ts:191-234 / 306-336 / 356-384）：
 *   prepare  = createExecution（快照+冻结）→ pre-execute waterfall（allow/deny/ask）
 *            → 审批 → guards（单调：只能 deny，不能把 deny 翻成 allow）
 *   dispatch = execute waterfall（默认 body = 调用方的 execute 函数）
 *   complete = post-execute waterfall（accept 可改 content/value；block 转 isError）
 *            → emit tools/result（观察，异常不影响结果）
 *
 * 三语义事件 seam（经 EventBus）：
 *   tools/pre-execute  waterfall  → 返回 PreDecision {kind:'allow'|'deny'|'ask'|'cancel', reason?}
 *   tools/execute      waterfall  → 默认 next 是真实 execute；监听器可环绕（前/后处理、替换结果）
 *   tools/post-execute waterfall  → 返回 PostDecision {kind:'accept'|'block', content?, value?, feedback?}
 *   tools/result       emit       → 观察深冻结结果，异常只记录不污染
 *
 * 并发上限：executeBatch 用滚动池（Promise.race(inFlight) 完成一个补一个），
 * 结果按模型序的连续 slot 提交——对齐 batch.ts:117-234。
 *
 * 与 relay 的关系：relay 的 `_gateCommand`（H3 hooks + H4 guardian）是本流水线的
 * "guards + 审批" 具体 provider；本模块是机制层，不 require relay，零循环依赖。
 * 错误码（HOOK_BLOCKED / GUARDIAN_BLOCKED / NEEDS_CONFIRM）由调用方在收到 deny 时
 * 按 reason.code 映射，保持对外契约不变。
 */

const { EventBus, isBailed } = require('./event-bus');

/** 冻结快照：参数一旦进入流水线就不再可变（对齐 DSH snapshotJsonValue + deepFreeze） */
function snapshot(v) {
  if (v === null || v === undefined || typeof v !== 'object') return v;
  return Object.freeze(JSON.parse(JSON.stringify(v)));
}

class ToolPipeline {
  constructor(opts) {
    const o = opts || {};
    this.bus = o.bus || new EventBus({ onError: o.onError });
    // guards：返回 undefined=放行；返回字符串/对象=deny。单调：任一 deny 即拒。
    this.checkGuards = o.checkGuards || (() => undefined);
    // approval：req -> Promise<'allowed-once'|'rejected'|'cancelled'|'unavailable'>
    this.approval = o.approval || null;
    this.maxParallel = o.maxParallel || 10;
  }

  /** 建执行上下文（不可变快照 + token + 取消信号） */
  createExecution(input) {
    const exec = {
      callId: input.callId,
      name: input.name || (input.command && input.command.op) || '',
      args: snapshot(input.args !== undefined ? input.args : (input.command && input.command.params) || {}),
      command: input.command,
      signal: input.signal || null,
      token: input.token || null,
      parent: input.parent || null,
      rootCallId: input.rootCallId || input.callId,
      confirmed: input.confirmed === true,
      meta: input.meta || {},
    };
    return Object.freeze(exec);
  }

  /**
   * prepare：pre-execute waterfall → 审批 → guards。
   * @returns {Promise<{kind:'dispatch'|'deny', exec, result?, decision?}>}
   */
  async prepare(input) {
    const exec = this.createExecution(input);
    if (exec.signal && exec.signal.aborted) {
      return { kind: 'deny', exec, decision: { kind: 'cancel', reason: '已取消' } };
    }

    // 1) pre-execute waterfall：默认 allow。监听器可 deny/ask/cancel 或环绕。
    let decision;
    try {
      decision = await Promise.resolve(this.bus.waterfall('tools/pre-execute', exec, () => ({ kind: 'allow' })));
    } catch (e) {
      return { kind: 'deny', exec, decision: { kind: 'deny', reason: 'pre-execute 失败：' + (e && e.message || e) } };
    }
    if (!decision || typeof decision !== 'object') decision = { kind: 'allow' };

    if (decision.kind === 'cancel') return { kind: 'deny', exec, decision };
    if (decision.kind === 'deny') return { kind: 'deny', exec, decision };
    // pre-execute 可返回 {args} 改写入参（对齐 DSH 的 allow/args 决策）。
    // 改写后的 exec 是新快照，原 exec 保持冻结不可变。
    if (decision.args && typeof decision.args === 'object') {
      const nextExec = this.createExecution({
        ...input, args: decision.args, command: exec.command,
      });
      return { kind: 'dispatch', exec: nextExec, args: decision.args };
    }
    if (decision.kind === 'ask') {
      const outcome = await this._ask(exec, decision);
      if (outcome !== 'allowed-once') {
        return {
          kind: 'deny', exec,
          decision: {
            kind: 'deny', code: decision.code || 'APPROVAL_REQUIRED',
            reason: '审批未通过：' + outcome, approvalOutcome: outcome, risk: decision.risk,
          },
        };
      }
    }

    // 2) guards：单调 deny，不能翻 allow。
    let denial;
    try { denial = this.checkGuards(exec); }
    catch (e) { denial = '守卫检查失败：' + (e && e.message || e); }
    if (denial) {
      const reason = (denial && typeof denial === 'object') ? denial : { reason: String(denial) };
      return { kind: 'deny', exec, decision: { kind: 'deny', ...reason, byGuard: true } };
    }
    return { kind: 'dispatch', exec };
  }

  async _ask(exec, decision) {
    if (!this.approval) return 'unavailable';
    try {
      const outcome = await this.approval({
        toolName: exec.name, callId: exec.callId, args: exec.args,
        risk: decision.risk || 'write',
        code: decision.code || 'APPROVAL_REQUIRED',
        reason: decision.reason, displayReason: decision.displayReason,
        signal: exec.signal,
      });
      return ['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(outcome) ? outcome : 'unavailable';
    } catch (_) {
      return 'unavailable';
    }
  }

  /** dispatch：execute waterfall，默认 next 是真执行体。返回 {exec, result} 或 {exec, error}。 */
  async dispatch(exec, execute) {
    if (typeof execute !== 'function') throw new Error('ToolPipeline.dispatch 需要 execute 函数');
    try {
      const result = await Promise.resolve(this.bus.waterfall('tools/execute', exec, () => execute(exec)));
      return { exec, result };
    } catch (e) {
      return { exec, error: e };
    }
  }

  /** emit 观察：深冻结结果，逐监听器隔离异常（不对结果产生任何影响）。 */
  observe(exec, result) {
    const observed = snapshot(result);
    for (const h of this.bus.listeners('tools/result')) {
      try { h.fn(exec, observed); } catch (_) { /* 观察失败不影响结果 */ }
    }
    return observed;
  }

  /** complete：post-execute waterfall（可替换 content/value / block 转 error）+ emit 观察。 */
  async complete(exec, outcome) {
    let result = outcome.error
      ? { isError: true, error: { message: String(outcome.error && outcome.error.message || outcome.error) }, value: undefined }
      : (outcome.result && typeof outcome.result === 'object'
        ? { isError: false, value: outcome.result, content: outcome.result }
        : { isError: false, value: outcome.result, content: outcome.result });

    try {
      const post = await Promise.resolve(this.bus.waterfall(
        'tools/post-execute', exec, result, () => ({ kind: 'accept' })
      ));
      if (post && post.kind === 'block') {
        result = {
          isError: true,
          error: { message: String(post.feedback || post.reason || '被 post-execute 拦截') },
          value: undefined, content: undefined,
        };
      } else if (post && post.kind === 'accept') {
        if ('value' in post) result.value = post.value;
        if ('content' in post) result.content = post.content;
      }
    } catch (e) {
      // post-execute 抛错 → 转 isError，但不丢原始结果类型（对齐 pipeline.ts 的 toolErrorResult）
      result = {
        isError: true,
        error: { message: 'post-execute 失败：' + (e && e.message || e) },
        value: undefined, content: undefined,
      };
    }

    // emit 观察：监听器同步 throw 不能污染结果（逐监听器 try/catch）
    this.observe(exec, result);
    return result;
  }

  /** 单次完整执行：prepare → dispatch → complete。 */
  async run(input, execute) {
    const prepared = await this.prepare(input);
    if (prepared.kind === 'deny') {
      return {
        isError: true,
        error: { message: String(prepared.decision.reason || '被拦截'), ...prepared.decision },
        value: undefined, content: undefined,
      };
    }
    const outcome = await this.dispatch(prepared.exec, execute);
    return this.complete(prepared.exec, outcome);
  }

  /**
   * 批量执行，有界并发（滚动池）。结果按输入顺序返回。
   * @param {Array} inputs 每项 {callId,name,args,...}
   * @param {Function} execute (exec) => result|Promise
   */
  async executeBatch(inputs, execute) {
    const list = Array.isArray(inputs) ? inputs : [];
    const n = list.length;
    const out = new Array(n);
    const limit = Math.max(1, Math.min(n || 1, Number(this.maxParallel) || 10));
    let next = 0;
    const inFlight = new Map();

    const startOne = (index) => {
      const p = Promise.resolve().then(() => this.run(list[index], execute))
        .then((r) => ({ index, r }), (e) => ({
          index,
          r: { isError: true, error: { message: String(e && e.message || e) }, value: undefined },
        }));
      inFlight.set(index, p);
    };

    while (next < n && inFlight.size < limit) startOne(next++);
    while (inFlight.size) {
      const done = await Promise.race(inFlight.values());
      inFlight.delete(done.index);
      out[done.index] = done.r;
      if (next < n) startOne(next++);
    }
    return out;
  }
}

module.exports = { ToolPipeline, snapshot, isBailed };
