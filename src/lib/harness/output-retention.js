'use strict';
/**
 * 有界输出保留库（对标 DeepSeek Harness `util/output-retention`）
 *
 * 只回答一个机械问题：**在给定预算内我们留下了什么、丢了什么**。
 * 不掺业务语义（不分组、不加行号、不加退出码），业务侧自己拼模型可见文案。
 *
 * 两种保留器，因为资源模型不同：
 *  · ItemRetainer —— 按「有序逻辑项」计数（文件路径、搜索命中），仅保留 head；
 *  · TextRetainer —— 按「字节」计（命令输出、网页正文），支持 head / tail / headTail，
 *    且切点保证 UTF-8 边界不产生替换符。
 *
 * 与 Harness 的差异（诚实声明）：
 *  · Harness 用 TypeScript + 泛型；这里是同语义的 JS 实现，API 形状对齐（push/finish/omitted）；
 *  · 不做 spill 落盘（Harness 的 spill 是独立包），本模块只做内存内裁剪。
 */

const { ItemRetainer } = require('./item-retainer');

/** 省略信息：exact 为常规形态（每个单位/字节都被观测到，计数精确）。 */
function omittedNone() { return { kind: 'none' }; }
function omittedExact(count) { return { kind: 'exact', count: count }; }

/** 单个字符串的 UTF-8 字节数。 */
function byteLength(s) { return Buffer.byteLength(String(s == null ? '' : s), 'utf8'); }

/**
 * 从字符串**头部**截取不超过 maxBytes 的前缀，切点回退到 code point 边界。
 * 直接 slice Buffer 会把多字节字符切成半个，toString 后变 U+FFFD——这里逐字符累加避免。
 */
function headByBytes(s, maxBytes) {
  const str = String(s == null ? '' : s);
  if (maxBytes <= 0) return { text: '', bytes: 0 };
  let bytes = 0;
  let out = '';
  for (const ch of str) {
    const b = byteLength(ch);
    if (bytes + b > maxBytes) break;
    bytes += b;
    out += ch;
  }
  return { text: out, bytes: bytes };
}

/** 从字符串**尾部**截取不超过 maxBytes 的后缀（同样保证 UTF-8 边界）。 */
function tailByBytes(s, maxBytes) {
  const str = String(s == null ? '' : s);
  if (maxBytes <= 0) return { text: '', bytes: 0 };
  let bytes = 0;
  let out = '';
  const chars = Array.from(str);
  for (let i = chars.length - 1; i >= 0; i--) {
    const b = byteLength(chars[i]);
    if (bytes + b > maxBytes) break;
    bytes += b;
    out = chars[i] + out;
  }
  return { text: out, bytes: bytes };
}

/** 不切断代理对的字符截断（Harness 同名函数语义）。 */
function truncateWithoutSplittingSurrogatePair(text, maxChars) {
  const chars = Array.from(String(text == null ? '' : text));
  if (chars.length <= maxChars) return String(text == null ? '' : text);
  if (maxChars <= 0) return '';
  return chars.slice(0, maxChars).join('');
}

/**
 * 按字节保留文本流。
 * mode: 'head' | 'tail' | 'headTail'
 */
class TextRetainer {
  constructor(opts) {
    const o = opts || {};
    this.mode = o.mode === 'tail' || o.mode === 'headTail' ? o.mode : 'head';
    this.maxBytes = Math.max(1, Number(o.maxBytes) || 8192);
    this.parts = [];
    this.seenBytes = 0;
    this.droppedBytes = 0;
    this.truncated = false;
  }

  /**
   * 喂入一段文本。返回 {kept, truncated}：
   *  · kept=false 表示这段完全没留下（预算已满且策略不需要它）。
   *  · 注意 headTail 在 head 预算满之后仍会继续吃尾部预算，因此 kept 可能是"只留了尾部"。
   */
  push(chunk) {
    const text = String(chunk == null ? '' : chunk);
    const n = byteLength(text);
    this.seenBytes += n;
    if (n === 0) return { kept: true, truncated: this.truncated };

    if (this.mode === 'head') {
      // room 只按「已留字节」算，避免把被丢弃的字节重复计入预算
      const room = this.maxBytes - this._keptBytes();
      if (room <= 0) {
        this.droppedBytes += n;
        this.truncated = true;
        return { kept: false, truncated: true };
      }
      const t = headByBytes(text, room);
      if (t.text) this.parts.push(t.text);
      if (t.bytes < n) {
        this.droppedBytes += n - t.bytes;
        this.truncated = true;
      }
      return { kept: t.bytes === n, truncated: this.truncated };
    }

    if (this.mode === 'tail') {
      // tail 模式只留最后 maxBytes：整体重新计算，简单且不丢尾
      this.parts.push(text);
      const all = this.parts.join('');
      const keep = tailByBytes(all, this.maxBytes);
      this.parts = keep.text ? [keep.text] : [];
      const dropped = byteLength(all) - keep.bytes;
      this.truncated = dropped > 0;
      this.droppedBytes = dropped;
      return { kept: dropped === 0, truncated: this.truncated };
    }

    // headTail：头部预算 = 60%，尾部预算 = 40%（与 Harness 的 head+tail 双预算同构）
    const headBudget = Math.max(1, Math.floor(this.maxBytes * 0.6));
    const tailBudget = Math.max(0, this.maxBytes - headBudget);
    this.parts.push(text);
    const all = this.parts.join('');
    const seen = byteLength(all);
    if (seen <= this.maxBytes) {
      this.truncated = false;
      this.droppedBytes = 0;
      return { kept: true, truncated: false };
    }
    const head = headByBytes(all, headBudget).text;
    const tail = tailByBytes(all, tailBudget).text;
    this._ht = { head: head, tail: tail };
    this.truncated = true;
    this.droppedBytes = seen - byteLength(head) - byteLength(tail);
    return { kept: false, truncated: true };
  }

  _keptBytes() {
    let b = 0;
    for (const p of this.parts) b += byteLength(p);
    return b;
  }

  /**
   * 收尾，返回 {text, truncated, seenBytes, keptBytes, omitted}。
   * headTail 模式下中段用一行说明替代（形如 `… 省略 N 字节 …`）。
   */
  finish() {
    if (this.mode === 'headTail') {
      const state = this._ht;
      if (!state) {
        const text = this.parts.join('');
        return { text: text, truncated: false, seenBytes: byteLength(text), keptBytes: byteLength(text), omitted: omittedNone() };
      }
      const gap = this.droppedBytes;
      const text = state.head + '\n… 省略 ' + gap + ' 字节 …\n' + state.tail;
      return {
        text: text, truncated: true, seenBytes: this.seenBytes,
        keptBytes: byteLength(state.head) + byteLength(state.tail),
        omitted: omittedExact(gap),
      };
    }
    const text = this.parts.join('');
    return {
      text: text, truncated: this.truncated, seenBytes: this.seenBytes,
      keptBytes: byteLength(text),
      omitted: this.truncated ? omittedExact(this.droppedBytes) : omittedNone(),
    };
  }
}

/** 渲染一句人类可读的省略说明（Harness `formatRetentionNotice` 的最小版）。 */
function describeOmitted(omitted, unit) {
  const u = unit || '项';
  if (!omitted || omitted.kind === 'none') return '';
  if (omitted.kind === 'exact') return '已省略 ' + omitted.count + ' ' + u;
  return '部分内容已省略';
}

module.exports = {
  TextRetainer, ItemRetainer,
  headByBytes, tailByBytes, byteLength,
  truncateWithoutSplittingSurrogatePair,
  describeOmitted, omittedExact, omittedNone,
};
