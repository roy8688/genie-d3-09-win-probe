'use strict';
/**
 * Harness M5：三语义事件总线（对标 Cordis `vendor/cordis/src/events.ts`）
 *
 * 为什么不是直接用 Node 的 EventEmitter：
 *   EventEmitter 只有"广播、忽略返回值"一种语义。Harness 的关键能力——
 *   **环绕式拦截**（waterfall 的 next()）、**短路返回第一个结果**（serial）、
 *   **观察不干扰**（emit）——EventEmitter 一个都没有。工具执行流水线要靠
 *   waterfall 做 pre/post-execute 的可改写 seam，靠 emit 做结果观察，
 *   没有这三语义就只能写 if 分支（又回到老路）。
 *
 * 精确语义（对齐 cordis events.ts:12-14, 193-265）：
 *   emit(name, ...args)      同步广播，**忽略返回值**，不 await Promise。
 *                            监听器同步 throw 会中断并外抛（与 cordis 一致）。
 *   parallel(name, ...args)  并发执行全部监听器，Promise.allSettled；聚合错误抛 AggregateError。
 *   serial(name, ...args)    顺序 await，返回**第一个 bail 值**（非 null/false/undefined），无则 undefined。
 *   bail(name, ...args)      同 serial 但同步；命中即停。
 *   waterfall(name, ...args) 环绕递归：最后一个参数必须是调用方的 next()；
 *                            每个监听器拿到 [...args, next]，可 `const r = await next(); return f(r)`
 *                            显式串联，也可不调 next 直接 veto（短路）；
 *                            next() 只能调一次，重复调用抛错（对齐 cordis）。
 *
 * 与既有 hooks/bus.js 的分工：
 *   hooks/bus.js = 20 个具名生命周期钩子的注册/脱敏/审计/超时隔离（业务层）；
 *   本模块      = 通用派发语义（机制层）。工具流水线用本模块的 waterfall/emit
 *   做编排，再在 seam 里桥接到 hooks/bus 的具名事件——两层职责不重叠。
 */

const DispatchMode = Object.freeze(['emit', 'parallel', 'serial', 'bail', 'waterfall']);

/** cordis isBailed：非 null/false/undefined 即视为"命中"（events.ts:12-14） */
function isBailed(v) {
  return v !== null && v !== false && v !== undefined;
}

class EventBus {
  constructor(opts) {
    this._listeners = new Map(); // name -> [{fn, id, seq}]
    this._seq = 0;
    this._onError = (opts && opts.onError) || null; // 观察错误的回调（不改写语义）
  }

  /** 注册监听器，返回撤销函数（DSH 的可逆副作用纪律） */
  on(name, fn) {
    if (typeof fn !== 'function') throw new Error('事件监听器必须是函数');
    const arr = this._listeners.get(name) || [];
    const item = { fn, id: 'l' + (++this._seq), seq: this._seq };
    arr.push(item);
    this._listeners.set(name, arr);
    return () => this.off(name, item.id);
  }

  once(name, fn) {
    const off = this.on(name, (...args) => { off(); return fn(...args); });
    return off;
  }

  off(name, id) {
    const arr = this._listeners.get(name) || [];
    const next = arr.filter((h) => h.id !== id);
    this._listeners.set(name, next);
    return arr.length !== next.length;
  }

  clear(name) {
    if (name) this._listeners.delete(name);
    else this._listeners.clear();
  }

  listeners(name) {
    return (this._listeners.get(name) || []).slice();
  }

  _noteError(kind, err) {
    if (this._onError) {
      try { this._onError(kind, err); } catch (_) { /* 错误观察器不许反转语义 */ }
    }
  }

  /** 同步广播：忽略返回值，同步 throw 中断并外抛（对齐 cordis emit） */
  emit(name, ...args) {
    for (const h of (this._listeners.get(name) || []).slice()) {
      h.fn(...args); // 不 try/catch：与 cordis 一致，同步 throw 会外抛
    }
  }

  /** 并发派发：全部执行，聚合错误（对齐 cordis parallel） */
  async parallel(name, ...args) {
    const arr = (this._listeners.get(name) || []).slice();
    const results = await Promise.allSettled(arr.map((h) => Promise.resolve().then(() => h.fn(...args))));
    const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
    for (const e of errors) this._noteError('parallel', e);
    if (errors.length) throw new AggregateError(errors, `事件 ${name} 有 ${errors.length} 个监听器失败`);
  }

  /** 顺序 await，返回第一个 bail 值（对齐 cordis serial） */
  async serial(name, ...args) {
    for (const h of (this._listeners.get(name) || []).slice()) {
      const v = await h.fn(...args);
      if (isBailed(v)) return v;
    }
    return undefined;
  }

  /** 同步顺序，返回第一个 bail 值（对齐 cordis bail） */
  bail(name, ...args) {
    for (const h of (this._listeners.get(name) || []).slice()) {
      const v = h.fn(...args);
      if (isBailed(v)) return v;
    }
    return undefined;
  }

  /**
   * 环绕递归派发（对齐 cordis waterfall events.ts:250-265）。
   * 调用方必须传 next 作为最后一个参数；next 只能被调用一次。
   * 监听器不调 next = veto，最内层的默认逻辑不执行。
   */
  waterfall(name, ...all) {
    if (all.length < 1 || typeof all[all.length - 1] !== 'function') {
      throw new Error(`waterfall(${name}) 最后一个参数必须是 next 函数`);
    }
    const inner = all.pop();           // 最内层默认逻辑
    const args = all;                  // 第一层监听器的参数
    const cbs = (this._listeners.get(name) || []).slice().map((h) => h.fn);
    let index = 0;

    // cordis events.ts:250-265：dispatch(...nextArgs) 把 next 传来的参数展开给下一层，
    // 最后一层调 inner(...nextArgs)。所以 next(more) 能向下传参，不是闭包固定 args。
    const dispatch = (...nextArgs) => {
      if (index >= cbs.length) return inner(...nextArgs);
      const cb = cbs[index++];
      let called = false;
      const next = (...more) => {
        if (called) throw new Error('next() called multiple times');
        called = true;
        return dispatch(...more);
      };
      // 同步 throw 原样外抛；Promise 由调用方 await（waterfall 返回类型由监听器决定）。
      return cb(...nextArgs, next);
    };
    return dispatch(...args);
  }
}

module.exports = { EventBus, DispatchMode, isBailed };
