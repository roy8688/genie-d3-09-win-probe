'use strict';
/**
 * 按项数保留有序逻辑项（对标 Harness `util/output-retention` 的 ItemRetainer）。
 *
 * 为什么单独一个文件：它与 TextRetainer 的资源模型不同（项 vs 字节），
 * 且两者都需要 `push` / `finish` 这两个自然名——放在同一个文件里会触发
 * check.js 的 silent-override 门禁（同名方法定义两次）。拆开即语义清晰、门禁干净。
 */

function omittedNone() { return { kind: 'none' }; }
function omittedExact(count) { return { kind: 'exact', count: count }; }

/** 按项数保留有序逻辑项（仅 head）。 */
class ItemRetainer {
  constructor(opts) {
    const o = opts || {};
    this.maxItems = Math.max(1, Number(o.maxItems) || 50);
    this.items = [];
    this.seen = 0;
    this.truncated = false;
  }

  /** @returns {{kept:boolean, truncated:boolean}} */
  push(item) {
    this.seen += 1;
    if (this.items.length >= this.maxItems) {
      this.truncated = true;
      return { kept: false, truncated: true };
    }
    this.items.push(item);
    return { kept: true, truncated: this.truncated };
  }

  /** @returns {{items:Array, truncated:boolean, seen:number, kept:number, omitted:object}} */
  finish() {
    const omitted = this.seen > this.items.length ? omittedExact(this.seen - this.items.length) : omittedNone();
    return {
      items: this.items.slice(), truncated: this.truncated, seen: this.seen,
      kept: this.items.length, omitted: omitted,
    };
  }
}

module.exports = { ItemRetainer };
