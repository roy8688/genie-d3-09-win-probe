'use strict';
/**
 * 子智能体运行时（P1）—— 对标 DSH `subagent/subagent`
 *
 * 核心不是“再开一个聊天窗口”，而是：
 *   · 父会话把一段**明确任务**交给子会话；
 *   · 子会话有自己的消息历史与工具作用域，不继承父会话的全部上下文；
 *   · 深度有限、可取消、结果必须结构化回传；
 *   · 子会话默认**没有交互通道**：需要审批的工具直接 unavailable，不能卡住父轮次。
 *
 * 本模块只管生命周期与状态；真正的模型/工具执行由注入的 `runTurn` 完成，
 * 这样它可以独立测试，也不会反向依赖 relay。
 */

const MAX_DEPTH_DEFAULT = 2;
const MAX_CONCURRENT_DEFAULT = 3;

function makeId() {
  return 'sub_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function cleanTask(v) {
  return String(v == null ? '' : v).replace(/\u0000/g, '').trim().slice(0, 12000);
}

class SubagentManager {
  /**
   * @param {object} opts
   *   runTurn({id, task, title, depth, signal, parentSessionId, meta}) => Promise<{ok,content,...}>
   *   maxDepth=2, maxConcurrent=3, now=()=>Date.now()
   */
  constructor(opts) {
    const o = opts || {};
    if (typeof o.runTurn !== 'function') throw new Error('SubagentManager 需要 runTurn');
    this.runTurn = o.runTurn;
    this.maxDepth = Math.max(0, Number(o.maxDepth == null ? MAX_DEPTH_DEFAULT : o.maxDepth));
    this.maxConcurrent = Math.max(1, Number(o.maxConcurrent || MAX_CONCURRENT_DEFAULT));
    this.now = typeof o.now === 'function' ? o.now : () => Date.now();
    this.children = new Map();   // id -> record
  }

  list() {
    return Array.from(this.children.values()).map((c) => ({
      id: c.id, title: c.title, status: c.status, depth: c.depth,
      startedAt: c.startedAt, endedAt: c.endedAt || 0,
      parentSessionId: c.parentSessionId,
      result: c.status === 'done' ? String(c.result || '').slice(0, 2000) : '',
      error: c.error || '',
    }));
  }

  active() {
    return this.list().filter((c) => c.status === 'running').length;
  }

  /** 取消一个子会话；已结束的返回 already_done，不报错。 */
  cancel(id) {
    const c = this.children.get(String(id || ''));
    if (!c) return { ok: false, code: 'SUBAGENT_NOT_FOUND' };
    if (c.status !== 'running') return { ok: true, status: c.status, changed: false };
    c.status = 'cancelled';
    c.endedAt = this.now();
    try { c.controller.abort(); } catch (_) {}
    return { ok: true, status: 'cancelled', changed: true };
  }

  cancelAll(reason) {
    for (const c of this.children.values()) {
      if (c.status === 'running') {
        c.status = 'cancelled';
        c.endedAt = this.now();
        c.error = reason || 'parent cancelled';
        try { c.controller.abort(); } catch (_) {}
      }
    }
  }

  /**
   * 运行一个子任务并等待结果。
   * @param {object} input {task, title, depth=0, parentSessionId, signal, meta, modelId}
   */
  async spawn(input) {
    const i = input || {};
    const task = cleanTask(i.task);
    if (!task) return { ok: false, code: 'SUBAGENT_TASK_EMPTY', content: '子任务不能为空' };
    const depth = Math.max(0, Number(i.depth || 0));
    if (depth > this.maxDepth) {
      return { ok: false, code: 'SUBAGENT_DEPTH', content: '子智能体嵌套超过上限（' + this.maxDepth + ' 层）' };
    }
    if (this.active() >= this.maxConcurrent) {
      return { ok: false, code: 'SUBAGENT_BUSY', content: '同时运行的子智能体已达上限（' + this.maxConcurrent + '）' };
    }

    const id = String(i.id || makeId());
    const controller = (typeof AbortController === 'function') ? new AbortController() : null;
    const rec = {
      id, task, title: String(i.title || task.slice(0, 40)),
      depth, status: 'running', startedAt: this.now(), endedAt: 0,
      parentSessionId: String(i.parentSessionId || ''), result: '', error: '',
      controller,
    };
    this.children.set(id, rec);

    // 父取消 → 子取消；子自己也可被 cancel() 中止。
    const onParentAbort = () => {
      if (rec.status === 'running') {
        rec.status = 'cancelled';
        rec.endedAt = this.now();
        try { controller.abort(); } catch (_) {}
      }
    };
    if (i.signal && typeof i.signal.addEventListener === 'function') {
      if (i.signal.aborted) onParentAbort();
      else i.signal.addEventListener('abort', onParentAbort, { once: true });
    }

    const signal = controller ? controller.signal : i.signal;
    try {
      const result = await this.runTurn({
        id, task, title: rec.title, depth: depth + 1,
        parentSessionId: rec.parentSessionId, signal,
        meta: Object.assign({}, i.meta || {}, { depth: depth + 1 }),
      }) || {};
      if (rec.status === 'running') {
        rec.status = result.ok === false ? 'failed' : 'done';
        rec.result = String(result.content == null ? '' : result.content);
        rec.error = String((result && result.error) || '');
        rec.endedAt = this.now();
      }
      return {
        ok: rec.status === 'done', content: rec.result || rec.error || '（子智能体没有返回内容）',
        childId: id, status: rec.status, depth: rec.depth, error: rec.error,
      };
    } catch (e) {
      const aborted = (e && e.name === 'AbortError') || /abort|cancel/i.test(String((e && e.message) || e));
      if (rec.status === 'running') {
        rec.status = aborted ? 'cancelled' : 'failed';
        rec.error = String((e && e.message) || e);
        rec.endedAt = this.now();
      }
      return {
        ok: false, code: aborted ? 'SUBAGENT_CANCELLED' : 'SUBAGENT_FAILED',
        content: aborted ? '子智能体已取消' : '子智能体失败：' + rec.error,
        childId: id, status: rec.status, depth: rec.depth, error: rec.error,
      };
    } finally {
      if (i.signal && typeof i.signal.removeEventListener === 'function') {
        i.signal.removeEventListener('abort', onParentAbort);
      }
    }
  }
}

module.exports = { SubagentManager, makeId, MAX_DEPTH_DEFAULT, MAX_CONCURRENT_DEFAULT };
