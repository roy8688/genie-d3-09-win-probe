'use strict';
/**
 * 工具结果契约（D2-01）
 *
 * 为什么要有这一层：
 *  · 以前 `AgentTools.execute()` 的返回是散的：`{ok, content, command, raw, code, error}`，
 *    有的工具带 raw、有的只带 code、失败时连错误码都没有。UI 想画"工具卡"必须先猜字段，
 *    一猜就分叉：日志里能看、卡片上是空的。
 *  · 统一 envelope 不是"多包一层好看"，而是让 trace、工具卡、审批、证据总线**共用同一份结果**：
 *    模型读 `content`，人读 `contentBlocks`，审计读 `evidence`，UI 读 `meta`。
 *
 * 刻意不做的事：
 *  · 不改模型看到的文字：`content` 原样保留，避免为了结构好看把回答喂变味。
 *  · 不在每个工具里手写 envelope：`normalize()` 是唯一入口，工具只返回旧字段也能被补齐。
 *  · 不把大对象塞进 content：`raw` 留在结构里给 UI，不进模型上下文。
 */

const crypto = require('node:crypto');

const MAX_BLOCK_CHARS = 4000;

function asString(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}

function hashOf(s) {
  return crypto.createHash('sha256').update(asString(s)).digest('hex').slice(0, 16);
}

/** 文本块。type 只用 text/json/image/link 四种，UI 不必理解工具名。 */
function textBlock(text, opts) {
  const o = opts || {};
  let t = asString(text);
  if (t.length > MAX_BLOCK_CHARS) t = t.slice(0, MAX_BLOCK_CHARS) + '\n…（已截断）';
  return { type: o.type || 'text', text: t };
}

function jsonBlock(value, opts) {
  const o = opts || {};
  return { type: 'json', text: asString(value), title: String(o.title || '') };
}

function linkBlock(url, title) {
  return { type: 'link', url: String(url || ''), text: String(title || '') };
}

/**
 * 从旧返回推断内容块。
 * 有显式 `contentBlocks` 时尊重它；否则把 content 变成单个 text 块。
 * 图片工具（read_image）已经自己带 `raw.mime/data`，这里不重复转 base64。
 */
function blocksOf(res) {
  const r = res || {};
  if (Array.isArray(r.contentBlocks) && r.contentBlocks.length) return r.contentBlocks;
  if (r.ok && r.raw && r.raw.mime && r.raw.data) {
    return [{ type: 'image', mime: String(r.raw.mime), data: String(r.raw.data), name: String(r.raw.name || '') }];
  }
  return [textBlock(r.content || '')];
}

function evidenceOf(name, res) {
  const r = res || {};
  if (Array.isArray(r.evidence) && r.evidence.length) return r.evidence;
  const out = [];
  const raw = r.raw || {};
  if (raw.path) out.push({ kind: 'file', path: String(raw.path) });
  if (r.command && r.command.op) out.push({ kind: 'command', op: String(r.command.op) });
  return out;
}

/**
 * 把任意工具的旧返回补齐成统一结构。
 * @param {object} res 旧返回（`{ok, content, ...}`）
 * @param {object} [ctx] { name, startedAt, endedAt, callId }
 */
function normalize(res, ctx) {
  const c = ctx || {};
  const r = res || {};
  const ok = r.ok !== false;
  const content = asString(r.content);
  const error = !ok
    ? {
      code: String((r.error && r.error.code) || r.code || 'TOOL_FAILED'),
      message: String((r.error && r.error.message) || r.content || '工具执行失败'),
      retryable: !!(r.error && r.error.retryable),
    }
    : null;
  return {
    ok,
    name: String(c.name || r.name || ''),
    callId: String(c.callId || r.callId || ''),
    content,
    contentBlocks: blocksOf(r),
    evidence: evidenceOf(c.name, r),
    command: r.command || null,
    raw: r.raw === undefined ? null : r.raw,
    error,
    code: error ? error.code : '',
    meta: Object.assign({}, (r.meta && typeof r.meta === 'object') ? r.meta : {}, {
      contentHash: hashOf(content),
      chars: content.length,
      startedAt: Number(c.startedAt || r.startedAt || 0) || null,
      endedAt: Number(c.endedAt || r.endedAt || 0) || null,
    }),
  };
}

function success(content, opts) {
  return normalize(Object.assign({ ok: true, content }, opts || {}));
}

function failure(code, message, opts) {
  return normalize(Object.assign({ ok: false, content: message, code }, opts || {}));
}

function isEnvelope(v) {
  return !!(v && typeof v === 'object' && Array.isArray(v.contentBlocks) && v.meta && Object.prototype.hasOwnProperty.call(v, 'ok'));
}

module.exports = { normalize, success, failure, isEnvelope, textBlock, jsonBlock, linkBlock, hashOf, MAX_BLOCK_CHARS };
