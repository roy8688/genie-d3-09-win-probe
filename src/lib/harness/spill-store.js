'use strict';
/**
 * 本地 spill 存储（D3-06）
 *
 * 作用只有一个：把“已经给模型裁剪过、但用户可能还想看”的完整工具输出写到
 * 一个私有文件，并返回路径和检索提示。对标 DSH `spill/spill-local`，但刻意不做：
 *  · 不做 retention（保留/省略是 `tool-result-pruner` 的事）；
 *  · 不做消息替换（那是 relay/pruner 的事）；
 *  · 不做检索 API（模型用现成的 `fs_read` / `grep` 去看）。
 *
 * 安全约定：
 *  · root 是 `0700`，session 目录是 `0700`，文件用 `wx` + `0600` 独占创建；
 *  · sessionId / suggestedName 是外部输入，逐字符编码成安全路径段，杜绝 `../`；
 *  · 清理只删 root 下 `session-*` 里的普通文件，不跟随符号链接；
 *  · 写失败必须抛错，由调用方决定“保留内联结果”还是“标记落盘失败”，不静默吞。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const CLEANUP_PERIOD_DAYS = 30;
const MAX_SPILL_BYTES = 32 * 1024 * 1024;

function rootDir() {
  return process.env.GENIE_SPILL_DIR || path.join(os.tmpdir(), 'genie-spill');
}

/** 把任意字符串编码成一个不会穿越目录的文件名片段。 */
function encodeSegment(raw) {
  const s = String(raw == null ? '' : raw);
  if (s.length === 0) return '~';
  if (s === '.') return '~002E';
  if (s === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const ch = String.fromCharCode(code);
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)
      ? ch
      : '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

function sessionDir(sessionId, root) {
  const base = root || rootDir();
  const hash = crypto.createHash('sha256').update(String(sessionId || 'anonymous')).digest('hex').slice(0, 12);
  return path.join(base, 'session-' + hash);
}

function isErrno(e, code) {
  return !!(e && e.code === code);
}

/**
 * 写一条完整文本。
 * @param {{sessionId?:string, suggestedName?:string, content:string, root?:string}} input
 * @returns {{path:string, bytes:number, retrievalHint:string}}
 */
function saveTextSync(input) {
  const i = input || {};
  const content = String(i.content == null ? '' : i.content);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_SPILL_BYTES) {
    const e = new Error('spill 内容过大：' + bytes + 'B > ' + MAX_SPILL_BYTES + 'B');
    e.code = 'SPILL_TOO_LARGE';
    throw e;
  }
  const root = i.root || rootDir();
  const dir = sessionDir(i.sessionId, root);
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir 的 mode 对“已存在的目录”不生效；这里显式收紧，避免 root 被别的
    // 调用方提前建成 0755 后，session 文件对同机其他用户可读。
    fs.chmodSync(root, 0o700);
    fs.chmodSync(dir, 0o700);
  } catch (e) {
    const err = new Error('spill 目录创建失败：' + ((e && e.message) || e));
    err.code = 'SPILL_IO';
    throw err;
  }

  const safe = encodeSegment(i.suggestedName || 'tool-output.txt').slice(0, 120);
  const file = path.join(dir, crypto.randomBytes(6).toString('hex') + '-' + safe);
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
  } catch (e) {
    const err = new Error('spill 写入失败：' + ((e && e.message) || e));
    err.code = 'SPILL_IO';
    throw err;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
  }
  return {
    path: file,
    bytes,
    retrievalHint: '用 fs_read 带 startLine/endLine 读取，或用 grep 在该路径内检索。',
  };
}

/**
 * 清理过期 spill。只处理 `session-*` 目录里的普通文件；符号链接、目录、非本
 * 格式文件一律不动。空 session 目录顺带删除。
 * @param {{root?:string, cleanupPeriodDays?:number, now?:number}} [opts]
 * @returns {{scanned:number, removed:number, skipped:number, errors:string[]}}
 */
function sweep(opts) {
  const o = opts || {};
  const root = o.root || rootDir();
  const days = o.cleanupPeriodDays == null ? CLEANUP_PERIOD_DAYS : Number(o.cleanupPeriodDays);
  const now = o.now == null ? Date.now() : Number(o.now);
  const out = { scanned: 0, removed: 0, skipped: 0, errors: [] };
  if (!Number.isFinite(days) || days <= 0) return out;
  const cutoff = now - days * 24 * 60 * 60 * 1000;

  let entries;
  try {
    const st = fs.lstatSync(root);
    if (!st.isDirectory() || st.isSymbolicLink()) return out;
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    if (!isErrno(e, 'ENOENT')) out.errors.push(String((e && e.message) || e));
    return out;
  }

  for (const ent of entries) {
    if (!ent.isDirectory() || !/^session-[a-f0-9]{12}$/.test(ent.name)) { out.skipped++; continue; }
    const dir = path.join(root, ent.name);
    let files;
    try { files = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { out.errors.push(String((e && e.message) || e)); continue; }
    let kept = 0;
    for (const f of files) {
      out.scanned++;
      if (!f.isFile() || f.isSymbolicLink()) { out.skipped++; kept++; continue; }
      const p = path.join(dir, f.name);
      let st;
      try { st = fs.lstatSync(p); } catch (_) { out.errors.push('lstat 失败：' + p); continue; }
      if (!st.isFile() || st.isSymbolicLink()) { out.skipped++; kept++; continue; }
      if (st.mtimeMs < cutoff) {
        try { fs.unlinkSync(p); out.removed++; } catch (e) { out.errors.push(String((e && e.message) || e)); kept++; }
      } else kept++;
    }
    if (kept === 0) { try { fs.rmdirSync(dir); } catch (_) {} }
  }
  return out;
}

/** 诊断：root、文件数、总字节；不读取文件内容。 */
function status() {
  const root = rootDir();
  const info = { ok: true, root, sessions: 0, files: 0, bytes: 0, cleanupPeriodDays: CLEANUP_PERIOD_DAYS, errors: [] };
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (e) {
    if (isErrno(e, 'ENOENT')) return info;
    info.errors.push(String((e && e.message) || e));
    return info;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || !/^session-[a-f0-9]{12}$/.test(ent.name)) continue;
    info.sessions++;
    const dir = path.join(root, ent.name);
    let files;
    try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const f of files) {
      if (!f.isFile() || f.isSymbolicLink()) continue;
      const p = path.join(dir, f.name);
      try { const st = fs.lstatSync(p); info.files++; info.bytes += st.size; } catch (_) {}
    }
  }
  return info;
}

module.exports = {
  CLEANUP_PERIOD_DAYS, MAX_SPILL_BYTES,
  encodeSegment, sessionDir, rootDir, saveTextSync, sweep, status,
};
