'use strict';
/**
 * D3-05 文件系统 seam（2026-11-23）
 *
 * 对齐官方 `packages/fs` 的分层：provider 负责目标解析、文本读写、原子发布；
 * observation policy 负责"读过哪一版"，写入按 mtime+size+hash 做 CAS。
 * 与官方 Cordis 版不同，这里用显式 FileSystem 对象 + 进程内 observation 表，
 * 因为 Genie 的 native 工具上下文不是 Cordis Context。
 *
 * 关键约束：
 *  · 所有写/编辑/删除/补丁都先拿 observation；没读过已有文件 → FS_NOT_OBSERVED；
 *  · 读后文件被外部改过 → FS_STALE_VERSION（工具层映射 STALE_FILE）；
 *  · 发布前在 rename 前一刻再验一次，避免"校验完到 rename 之间"被改；
 *  · 路径默认限制在工作区；permission=full 才允许额外路径（由调用方显式传入）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const WinPath = require('./win-path');

const MAX_READ = 240 * 1024;
const MAX_WRITE = 2 * 1024 * 1024;
const MAX_HASH_BYTES = 16 * 1024 * 1024;
const SEARCH_MAX_FILES = 5000;
const SEARCH_MAX_MATCHES = 200;
const SEARCH_MAX_PATHS = 200;
const SEARCH_MAX_FILE_BYTES = 512 * 1024;
const OBSERVATION_LIMIT = 4000;

const ERROR_CODES = {
  NOT_FOUND: 'FS_NOT_FOUND',
  NOT_DIRECTORY: 'FS_NOT_DIRECTORY',
  NOT_REGULAR_FILE: 'FS_NOT_REGULAR_FILE',
  NOT_TEXT: 'FS_NOT_TEXT',
  TOO_LARGE: 'FS_TOO_LARGE',
  OUTSIDE: 'FS_OUTSIDE_WORKSPACE',
  INVALID_PATH: 'FS_INVALID_PATH',
  STALE: 'FS_STALE_VERSION',
  NOT_OBSERVED: 'FS_NOT_OBSERVED',
  ALREADY_EXISTS: 'FS_ALREADY_EXISTS',
  AMBIGUOUS_EDIT: 'FS_AMBIGUOUS_EDIT',
  EDIT_NOT_FOUND: 'FS_EDIT_NOT_FOUND',
  INVALID_EDIT: 'FS_INVALID_EDIT',
  PATCH_PARSE: 'FS_PATCH_PARSE',
  PATCH_MISMATCH: 'FS_PATCH_MISMATCH',
  PATCH_UNSUPPORTED: 'FS_PATCH_UNSUPPORTED',
  IO: 'FS_IO_ERROR',
};

class FsError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = 'FsError';
    this.code = code || ERROR_CODES.IO;
    if (cause) this.cause = cause;
  }
}

function isFsError(e) {
  return e instanceof FsError && typeof e.code === 'string' && e.code.startsWith('FS_');
}

function fsError(message, code, cause) {
  return new FsError(message, code, cause);
}

// ── observation store ─────────────────────────────────────────────────
// ownerKey 通常是 sessionId；没有会话时退回 workspace 根。一个 owner 的观察表
// 只在进程内有效，不落盘：这是"本会话看过哪一版"，不是内容缓存。
const observedByOwner = new Map();

function ownerBucket(ownerKey) {
  let m = observedByOwner.get(ownerKey);
  if (!m) {
    m = new Map();
    observedByOwner.set(ownerKey, m);
  }
  return m;
}

function recordObservation(ownerKey, targetKey, observation) {
  const m = ownerBucket(ownerKey);
  m.set(targetKey, observation);
  if (m.size > OBSERVATION_LIMIT) {
    // Map 保留插入顺序，淘汰最旧的一条；只丢"看过"的事实，不丢文件。
    const first = m.keys().next().value;
    if (first !== undefined) m.delete(first);
  }
}

function priorObservation(ownerKey, targetKey) {
  return ownerBucket(ownerKey).get(targetKey);
}

function clearObservations(ownerKey) {
  if (ownerKey === undefined) observedByOwner.clear();
  else observedByOwner.delete(ownerKey);
}

// ── versions ───────────────────────────────────────────────────────────
function hashOfFile(abs, size) {
  if (size > MAX_HASH_BYTES) return 'size:' + size;
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 16);
  } catch (_) {
    return 'stat:' + size;
  }
}

/** mtime + size + 内容哈希：三者一起才是"我看到的是哪一版"。 */
function versionOf(abs) {
  const st = fs.statSync(abs);
  const size = st.isFile() ? st.size : 0;
  return {
    mtimeMs: Math.round(st.mtimeMs),
    size,
    hash: st.isFile() ? hashOfFile(abs, size) : 'dir',
  };
}

function sameVersion(a, b) {
  if (!a || !b) return false;
  if (typeof a === 'string') return String(a) === String(b.hash || '');
  if (typeof b === 'string') return String(b) === String(a.hash || '');
  return Number(a.size) === Number(b.size)
    && String(a.hash || '') === String(b.hash || '')
    && Math.round(Number(a.mtimeMs)) === Math.round(Number(b.mtimeMs));
}

// ── path resolution ───────────────────────────────────────────────────
function insideRoot(root, candidate) {
  if (process.platform === 'win32') return WinPath.inside(root, candidate);
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function toDisplay(root, abs, allowOutside) {
  if (!allowOutside && insideRoot(root, abs)) {
    return path.relative(root, abs).split(path.sep).join('/') || '.';
  }
  return abs;
}

function resolveMissing(abs) {
  const missing = [];
  let cur = abs;
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    missing.unshift(path.basename(cur));
    cur = parent;
  }
  if (!fs.existsSync(cur)) throw fsError('路径的父目录不存在：' + abs, ERROR_CODES.NOT_FOUND);
  const st = fs.statSync(cur);
  if (!st.isDirectory()) throw fsError('路径中间不是目录：' + abs, ERROR_CODES.NOT_DIRECTORY);
  const realBase = fs.realpathSync(cur);
  return path.join(realBase, ...missing);
}

/**
 * 解析一个路径为稳定 target。已存在路径走 realpath（符号链接被展开），
 * 不存在路径按最近存在的父目录 realpath 拼回，避免 `..` 逃逸。
 */
function resolveTarget(root, input, allowOutside) {
  if (typeof input !== 'string' || input.length === 0) {
    throw fsError('路径必须是非空字符串', ERROR_CODES.INVALID_PATH);
  }
  if (input.includes('\0')) throw fsError('路径包含 NUL', ERROR_CODES.INVALID_PATH);
  const rootReal = fs.realpathSync(root);
  const absInput = path.isAbsolute(input) ? path.normalize(input) : path.resolve(rootReal, input);
  let abs;
  let exists = false;
  try {
    abs = fs.realpathSync(absInput);
    exists = true;
  } catch (e) {
    if (e && e.code === 'ENOENT') abs = resolveMissing(absInput);
    else if (e && e.code === 'ENOTDIR') throw fsError('路径中间不是目录：' + input, ERROR_CODES.NOT_DIRECTORY, e);
    else throw fsError('无法解析路径：' + input + '（' + (e && e.message) + '）', ERROR_CODES.IO, e);
  }
  if (!allowOutside && !insideRoot(rootReal, abs)) {
    throw fsError('路径不在工作区内：' + input, ERROR_CODES.OUTSIDE);
  }
  return {
    abs,
    targetKey: abs,
    displayPath: toDisplay(rootReal, abs, allowOutside),
    exists,
    root: rootReal,
    outside: !insideRoot(rootReal, abs),
  };
}

// ── atomic publication ───────────────────────────────────────────────
function atomicWrite(abs, content, opts = {}) {
  const parent = path.dirname(abs);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = path.join(parent, '.' + path.basename(abs) + '.genie-tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'));
  let mode = opts.mode;
  try {
    const st = fs.statSync(abs);
    if (mode === undefined) mode = st.mode & 0o777;
  } catch (_) {
    if (mode === undefined) mode = 0o644;
  }
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
    if (opts.expectAbsent) {
      if (fs.existsSync(abs)) throw fsError('文件在写入前被创建：' + abs, ERROR_CODES.ALREADY_EXISTS);
    } else if (opts.expectCurrentVersion !== undefined) {
      let current = null;
      try { current = versionOf(abs); } catch (_) { current = null; }
      if (!current || !sameVersion(opts.expectCurrentVersion, current)) {
        throw fsError('文件在提交前被改过：' + abs, ERROR_CODES.STALE);
      }
    }
    fs.renameSync(tmp, abs);
    if (mode !== undefined) {
      try { fs.chmodSync(abs, mode); } catch (_) {}
    }
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
  }
}

// ── patch (Codex/OpenAI compatible) ─────────────────────────────────
const PATCH_BEGIN = '*** Begin Patch';
const PATCH_END = '*** End Patch';
const PATCH_EOF = '*** End of File';
const PATCH_MOVE = '*** Move to: ';
const PATCH_ADD = '*** Add File: ';
const PATCH_DELETE = '*** Delete File: ';
const PATCH_UPDATE = '*** Update File: ';

class PatchParseError extends FsError {
  constructor(lineNumber, reason) {
    super('补丁第 ' + lineNumber + ' 行无效：' + reason, ERROR_CODES.PATCH_PARSE);
    this.name = 'PatchParseError';
    this.lineNumber = lineNumber;
    this.reason = reason;
  }
}

function trimWs(v) {
  return String(v).replace(/^\p{White_Space}+/u, '').replace(/\p{White_Space}+$/u, '');
}

function trimEndWs(v) {
  return String(v).replace(/\p{White_Space}+$/u, '');
}

function patchLines(patch) {
  const leading = patch.slice(0, patch.length - patch.replace(/^\p{White_Space}+/u, '').length);
  const offset = leading.split('\n').length - 1;
  let lines = trimWs(patch).split(/\r?\n/u).map((text, index) => ({ text, number: offset + index + 1 }));
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (['<<EOF', "<<'EOF'", '<<"EOF"'].includes(first.text) && last.text.endsWith('EOF') && lines.length >= 4) {
    lines = lines.slice(1, -1);
  }
  if (trimWs(lines[0].text) !== PATCH_BEGIN) throw new PatchParseError(lines[0].number, "Expected '" + PATCH_BEGIN + "'");
  if (trimWs(lines[lines.length - 1].text) !== PATCH_END) throw new PatchParseError(lines[lines.length - 1].number, "Expected '" + PATCH_END + "'");
  return lines.map((line, index) => index < lines.length - 1
    ? { ...line, text: line.text.replace(/\r$/u, '') }
    : line);
}

function emptyHunk(h) {
  return h.oldLines.length === 0 && h.newLines.length === 0;
}

function ensureUpdate(op, lineNumber) {
  if (!op || op.kind !== 'update') return;
  const last = op.hunks[op.hunks.length - 1];
  if (!last) throw new PatchParseError(op.lineNumber, "Update for '" + op.path + "' requires at least one hunk");
  if (emptyHunk(last)) throw new PatchParseError(lineNumber, 'Update hunk must contain context, added, or removed lines');
}

function parsePatch(patch) {
  if (typeof patch !== 'string' || !patch.trim()) throw new PatchParseError(1, '补丁为空');
  const lines = patchLines(patch);
  const ops = [];
  let ended = false;
  for (const line of lines.slice(1)) {
    const op = ops[ops.length - 1];
    const header = op && op.kind === 'update' && line !== lines[lines.length - 1] ? trimEndWs(line.text) : trimWs(line.text);
    if (ended && line !== lines[lines.length - 1]) {
      if (trimWs(line.text) !== '') throw new PatchParseError(line.number, "Unexpected content after '" + PATCH_END + "'");
      continue;
    }
    if (header === PATCH_END) {
      ensureUpdate(op, line.number);
      ended = true;
    } else if (header.startsWith(PATCH_ADD)) {
      ensureUpdate(op, line.number);
      ops.push({ kind: 'add', path: header.slice(PATCH_ADD.length), lineNumber: line.number, content: '' });
    } else if (header.startsWith(PATCH_DELETE)) {
      ensureUpdate(op, line.number);
      ops.push({ kind: 'delete', path: header.slice(PATCH_DELETE.length), lineNumber: line.number });
    } else if (header.startsWith(PATCH_UPDATE)) {
      ensureUpdate(op, line.number);
      ops.push({ kind: 'update', path: header.slice(PATCH_UPDATE.length), lineNumber: line.number, hunks: [] });
    } else if (!op && header.startsWith('*** Environment ID:')) {
      throw new PatchParseError(line.number, 'Environment ID headers are unsupported');
    } else if (op && op.kind === 'add' && line.text.startsWith('+')) {
      op.content += line.text.slice(1) + '\n';
    } else if (op && op.kind === 'update') {
      readUpdate(op, line);
    } else {
      throw new PatchParseError(line.number, 'Expected an Add File, Delete File, or Update File header');
    }
  }
  return ops;
}

function readUpdate(op, line) {
  const text = trimEndWs(line.text);
  const previous = op.hunks[op.hunks.length - 1];
  const marker = text === '@@' || text.startsWith('@@ ');
  if (previous && previous.isEndOfFile) {
    if (text === '') return;
    if (!marker) throw new PatchParseError(line.number, "Expected '@@' after '*** End of File'");
  }
  if (!previous && op.moveTo === undefined && text.startsWith(PATCH_MOVE)) {
    op.moveTo = text.slice(PATCH_MOVE.length);
    return;
  }
  if (marker) {
    if (previous && emptyHunk(previous)) throw new PatchParseError(line.number, 'Update hunk must contain context, added, or removed lines');
    const hunk = { lineNumber: line.number, oldLines: [], newLines: [], isEndOfFile: false };
    if (text.startsWith('@@ ')) hunk.context = text.slice(3);
    op.hunks.push(hunk);
    return;
  }
  if (text === PATCH_EOF) {
    if (previous) {
      if (emptyHunk(previous)) throw new PatchParseError(line.number, 'Update hunk must contain context, added, or removed lines');
      previous.isEndOfFile = true;
    }
    return;
  }
  const prefix = line.text[0];
  if (line.text !== '' && prefix !== ' ' && prefix !== '+' && prefix !== '-') {
    throw new PatchParseError(line.number, "Expected a context (' '), added ('+'), removed ('-') line, or '@@'");
  }
  const hunk = previous || { lineNumber: line.number, oldLines: [], newLines: [], isEndOfFile: false };
  if (!previous) op.hunks.push(hunk);
  const content = line.text.slice(1);
  if (prefix === '+') hunk.newLines.push(content);
  else if (prefix === '-') hunk.oldLines.push(content);
  else {
    hunk.oldLines.push(content);
    hunk.newLines.push(content);
  }
}

const MATCH_PASSES = [
  (v) => v,
  (v) => v.replace(/\p{White_Space}+$/u, ''),
  (v) => v.replace(/^\p{White_Space}+/u, '').replace(/\p{White_Space}+$/u, ''),
  (v) => String(v).replace(/^\p{White_Space}+/u, '')
    .replace(/[\u2010-\u2015\u2212]/gu, '-')
    .replace(/[\u2018-\u201B]/gu, "'")
    .replace(/[\u201C-\u201F]/gu, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/gu, ' '),
];

function seekSequence(lines, pattern, start, eof) {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return undefined;
  const lastIndex = lines.length - pattern.length;
  const first = eof ? lastIndex : start;
  for (const normalize of MATCH_PASSES) {
    const expected = pattern.map(normalize);
    for (let index = first; index <= lastIndex; index++) {
      if (expected.every((v, offset) => normalize(lines[index + offset]) === v)) return index;
    }
  }
  return undefined;
}

function applyHunks(before, hunks) {
  const original = before.split('\n');
  if (original[original.length - 1] === '') original.pop();
  const replacements = [];
  let lineIndex = 0;
  for (const hunk of hunks) {
    if (hunk.context !== undefined) {
      const pattern = [hunk.context];
      const found = seekSequence(original, pattern, lineIndex, false);
      if (found === undefined) {
        return { ok: false, failure: { hunkLineNumber: hunk.lineNumber, stage: 'context', searchStart: lineIndex, pattern } };
      }
      lineIndex = found + 1;
    }
    if (hunk.oldLines.length === 0) {
      const start = original[original.length - 1] === '' ? original.length - 1 : original.length;
      replacements.push({ start, oldLength: 0, newLines: hunk.newLines });
      continue;
    }
    let pattern = hunk.oldLines.slice();
    let newLines = hunk.newLines.slice();
    let found = seekSequence(original, pattern, lineIndex, hunk.isEndOfFile);
    if (found === undefined && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1);
      if (newLines[newLines.length - 1] === '') newLines = newLines.slice(0, -1);
      found = seekSequence(original, pattern, lineIndex, hunk.isEndOfFile);
    }
    if (found === undefined) {
      return { ok: false, failure: { hunkLineNumber: hunk.lineNumber, stage: 'oldLines', searchStart: lineIndex, pattern: hunk.oldLines.slice() } };
    }
    replacements.push({ start: found, oldLength: pattern.length, newLines });
    lineIndex = found + pattern.length;
  }
  replacements.sort((a, b) => a.start - b.start);
  let lines = original;
  for (const r of replacements.reverse()) {
    lines = lines.slice(0, r.start).concat(r.newLines, lines.slice(r.start + r.oldLength));
  }
  if (lines[lines.length - 1] !== '') lines.push('');
  return { ok: true, after: lines.join('\n') };
}

// ── search helpers ───────────────────────────────────────────────────
function globToRegExp(glob) {
  let out = '^';
  const g = String(glob || '').replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        out += '[\\s\\S]*';
        i += 1;
        if (g[i + 1] === '/') i += 1;
      } else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else if (ch === '[') {
      const end = g.indexOf(']', i + 1);
      if (end > i) { out += g.slice(i, end + 1); i = end; } else out += '\\[';
    } else out += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(out + '$', 'i');
}

function walkFiles(root, maxFiles, onFile) {
  let seen = 0;
  let truncated = false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of names) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { stack.push(abs); continue; }
      if (!ent.isFile()) continue;
      if (seen >= maxFiles) { truncated = true; return { truncated }; }
      seen += 1;
      if (onFile(abs, seen) === false) return { truncated: true };
    }
  }
  return { truncated };
}

function relTo(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

function readTextIfSmall(abs) {
  try {
    const st = fs.statSync(abs);
    if (st.size > SEARCH_MAX_FILE_BYTES) return null;
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return null;
    return buf.toString('utf8');
  } catch (_) { return null; }
}

// ── FileSystem ───────────────────────────────────────────────────────
class FileSystem {
  constructor(opts) {
    this.workspaceRoot = fs.realpathSync(opts.workspaceRoot);
    this.ownerKey = opts.ownerKey || this.workspaceRoot;
    this.allowOutside = opts.allowOutside === true;
    this.maxRead = opts.maxRead || MAX_READ;
    this.maxWrite = opts.maxWrite || MAX_WRITE;
  }

  resolve(input) {
    return resolveTarget(this.workspaceRoot, input, this.allowOutside);
  }

  processPath(target) {
    return target.abs;
  }

  stat(input) {
    const target = this.resolve(input);
    let st;
    try { st = fs.statSync(target.abs); } catch (e) {
      if (e && e.code === 'ENOENT') return { target, info: null };
      throw fsError('无法读取文件状态：' + target.displayPath, ERROR_CODES.IO, e);
    }
    return {
      target,
      info: {
        version: versionOf(target.abs),
        type: st.isFile() ? 'file' : st.isDirectory() ? 'directory' : 'other',
        size: st.isFile() ? st.size : undefined,
      },
    };
  }

  /** 观察当前状态并记入本 owner 的 observation 表。 */
  observe(input) {
    const { target, info } = this.stat(input);
    const observation = info ? { kind: 'present', version: info.version, type: info.type } : { kind: 'absent' };
    recordObservation(this.ownerKey, target.targetKey, observation);
    return { target, info, observation };
  }

  priorFor(target) {
    return priorObservation(this.ownerKey, target.targetKey);
  }

  requireObserved(target, verb) {
    const prior = this.priorFor(target);
    if (!prior) {
      throw fsError(verb + ' 前必须先读取 "' + target.displayPath + '"', ERROR_CODES.NOT_OBSERVED);
    }
    if (prior.kind === 'absent') {
      throw fsError('不能' + verb + ' "' + target.displayPath + '"：文件不存在', ERROR_CODES.NOT_FOUND);
    }
    return prior;
  }

  readText(input, opts = {}) {
    const { target, info } = this.stat(input);
    if (!info) throw fsError('文件不存在：' + target.displayPath, ERROR_CODES.NOT_FOUND);
    if (info.type === 'directory') throw fsError('不是文件：' + target.displayPath, ERROR_CODES.NOT_REGULAR_FILE);
    if (info.type !== 'file') throw fsError('不是普通文件：' + target.displayPath, ERROR_CODES.NOT_REGULAR_FILE);
    if (info.size > this.maxRead) throw fsError('文件过大（' + info.size + 'B，上限 ' + this.maxRead + 'B）', ERROR_CODES.TOO_LARGE);
    let buf;
    try { buf = fs.readFileSync(target.abs); } catch (e) {
      throw fsError('读取失败：' + target.displayPath, ERROR_CODES.IO, e);
    }
    if (buf.includes(0)) throw fsError('二进制文件不能按文本读取：' + target.displayPath, ERROR_CODES.NOT_TEXT);
    const after = versionOf(target.abs);
    if (!sameVersion(info.version, after)) {
      throw fsError('文件在读取过程中被改过：' + target.displayPath, ERROR_CODES.STALE);
    }
    if (opts.record !== false) recordObservation(this.ownerKey, target.targetKey, { kind: 'present', version: info.version, type: 'file' });
    return { target, info, content: buf.toString('utf8') };
  }

  writeText(input, content, opts = {}) {
    const text = String(content == null ? '' : content);
    if (text.length > this.maxWrite) throw fsError('内容过大（' + text.length + 'B）', ERROR_CODES.TOO_LARGE);
    const { target, info } = this.stat(input);
    if (opts.createOnly && info) {
      throw fsError('文件已存在，不能按 create 写入：' + target.displayPath, ERROR_CODES.ALREADY_EXISTS);
    }
    const prior = this.priorFor(target);
    const expected = opts.expectedVersion;
    if (expected != null && expected !== '') {
      if (!info) throw fsError('文件在读取之后已不存在，拒绝写入：' + target.displayPath, ERROR_CODES.STALE);
      // 显式版本也不能绕过 observation policy：版本必须来自本会话读过的那一版。
      if (!prior || prior.kind !== 'present') {
        throw fsError('覆盖已有文件前必须先读取：' + target.displayPath, ERROR_CODES.NOT_OBSERVED);
      }
      if (!sameVersion(expected, info.version) || !sameVersion(prior.version, info.version)) {
        throw fsError('文件在读取之后被改过，已拒绝覆盖：' + target.displayPath, ERROR_CODES.STALE);
      }
    } else if (info) {
      if (!prior || prior.kind !== 'present') {
        throw fsError('覆盖已有文件前必须先读取：' + target.displayPath, ERROR_CODES.NOT_OBSERVED);
      }
      if (!sameVersion(prior.version, info.version)) {
        throw fsError('文件在读取之后被改过，已拒绝覆盖：' + target.displayPath, ERROR_CODES.STALE);
      }
    } else if (prior && prior.kind === 'present') {
      throw fsError('文件在读取之后已不存在，拒绝写入：' + target.displayPath, ERROR_CODES.STALE);
    }
    if (info && info.type !== 'file') throw fsError('不是普通文件：' + target.displayPath, ERROR_CODES.NOT_REGULAR_FILE);

    let before = null;
    if (info) {
      try { before = fs.readFileSync(target.abs, 'utf8'); } catch (_) { before = null; }
    }
    atomicWrite(target.abs, text, info
      ? { expectCurrentVersion: info.version }
      : { expectAbsent: true });
    const afterVersion = versionOf(target.abs);
    recordObservation(this.ownerKey, target.targetKey, { kind: 'present', version: afterVersion, type: 'file' });
    return {
      target,
      operation: info ? 'update' : 'create',
      version: afterVersion,
      before,
      after: text,
    };
  }

  createText(input, content, opts = {}) {
    return this.writeText(input, content, { ...opts, expectedVersion: undefined, createOnly: true });
  }

  editText(input, edit, opts = {}) {
    const oldString = String(edit && edit.oldString == null ? '' : edit.oldString);
    const newString = String(edit && edit.newString == null ? '' : edit.newString);
    if (!oldString) throw fsError('oldString 不能为空', ERROR_CODES.INVALID_EDIT);
    const target = this.resolve(input);
    const prior = this.requireObserved(target, '编辑');
    const { info } = this.stat(target.abs);
    if (!info) throw fsError('文件不存在：' + target.displayPath, ERROR_CODES.NOT_FOUND);
    if (info.type !== 'file') throw fsError('不是普通文件：' + target.displayPath, ERROR_CODES.NOT_REGULAR_FILE);
    if (!sameVersion(prior.version, info.version)) {
      throw fsError('文件在读取之后被改过，已拒绝编辑：' + target.displayPath, ERROR_CODES.STALE);
    }
    if (opts.expectedVersion != null && !sameVersion(opts.expectedVersion, info.version)) {
      throw fsError('文件在读取之后被改过，已拒绝编辑：' + target.displayPath, ERROR_CODES.STALE);
    }
    const content = fs.readFileSync(target.abs, 'utf8');
    const offsets = [];
    let cursor = 0;
    while (true) {
      const hit = content.indexOf(oldString, cursor);
      if (hit < 0) break;
      offsets.push(hit);
      cursor = hit + oldString.length;
    }
    if (!offsets.length) throw fsError('找不到要替换的文本：' + target.displayPath, ERROR_CODES.EDIT_NOT_FOUND);
    if (!edit.replaceAll && offsets.length > 1) {
      throw fsError('要替换的文本出现 ' + offsets.length + ' 次，请提供更多上下文：' + target.displayPath, ERROR_CODES.AMBIGUOUS_EDIT);
    }
    const after = edit.replaceAll
      ? content.split(oldString).join(newString)
      : content.slice(0, offsets[0]) + newString + content.slice(offsets[0] + oldString.length);
    atomicWrite(target.abs, after, { expectCurrentVersion: info.version });
    const afterVersion = versionOf(target.abs);
    recordObservation(this.ownerKey, target.targetKey, { kind: 'present', version: afterVersion, type: 'file' });
    return { target, version: afterVersion, before: content, after, replacements: offsets.length };
  }

  patchText(input, patchOrHunks, opts = {}) {
    const hunks = Array.isArray(patchOrHunks) ? patchOrHunks : null;
    let ops;
    if (hunks) {
      const target = this.resolve(input);
      const prior = this.requireObserved(target, '打补丁');
      const { info } = this.stat(target.abs);
      if (!info) throw fsError('文件不存在：' + target.displayPath, ERROR_CODES.NOT_FOUND);
      if (info.type !== 'file') throw fsError('不是普通文件：' + target.displayPath, ERROR_CODES.NOT_REGULAR_FILE);
      if (!sameVersion(prior.version, info.version)) throw fsError('文件在读取之后被改过，已拒绝补丁：' + target.displayPath, ERROR_CODES.STALE);
      return this.applyHunksToTarget(target, info, hunks);
    }
    ops = parsePatch(patchOrHunks);
    return this.applyPatchOps(ops, opts);
  }

  applyHunksToTarget(target, info, hunks) {
    const raw = fs.readFileSync(target.abs, 'utf8');
    const crlf = (raw.match(/\r\n/g) || []).length >= (raw.match(/\n/g) || []).length - (raw.match(/\r\n/g) || []).length;
    const before = crlf ? raw.replace(/\r\n/g, '\n') : raw;
    const result = applyHunks(before, hunks);
    if (!result.ok) {
      throw fsError('补丁第 ' + result.failure.hunkLineNumber + ' 行匹配失败（' + result.failure.stage + '）：' + target.displayPath, ERROR_CODES.PATCH_MISMATCH);
    }
    const after = crlf ? result.after.replace(/\n/g, '\r\n') : result.after;
    atomicWrite(target.abs, after, { expectCurrentVersion: info.version });
    const afterVersion = versionOf(target.abs);
    recordObservation(this.ownerKey, target.targetKey, { kind: 'present', version: afterVersion, type: 'file' });
    return { target, version: afterVersion, before: raw, after, hunks: hunks.length };
  }

  applyPatchOps(ops, opts = {}) {
    const results = [];
    for (const op of ops) {
      if (op.moveTo) {
        throw fsError('暂不支持 Move to：' + op.path, ERROR_CODES.PATCH_UNSUPPORTED);
      }
      if (op.kind === 'add') {
        const { target, info } = this.stat(op.path);
        if (info) throw fsError('Add File 目标已存在：' + target.displayPath, ERROR_CODES.ALREADY_EXISTS);
        const w = this.writeText(op.path, op.content, { expectedVersion: undefined });
        results.push({ kind: 'add', path: target.displayPath, version: w.version, bytes: Buffer.byteLength(op.content) });
      } else if (op.kind === 'delete') {
        const d = this.deleteFile(op.path, { expectedVersion: this.expectedFor(op.path, opts) });
        results.push({ kind: 'delete', path: d.target.displayPath, version: null });
      } else if (op.kind === 'update') {
        const target = this.resolve(op.path);
        const prior = this.requireObserved(target, '打补丁');
        const { info } = this.stat(target.abs);
        if (!info) throw fsError('Update File 目标不存在：' + target.displayPath, ERROR_CODES.NOT_FOUND);
        if (info.type !== 'file') throw fsError('不是普通文件：' + target.displayPath, ERROR_CODES.NOT_REGULAR_FILE);
        const expected = this.expectedFor(op.path, opts);
        if (expected != null ? !sameVersion(expected, info.version) : !sameVersion(prior.version, info.version)) {
          throw fsError('文件在读取之后被改过，已拒绝补丁：' + target.displayPath, ERROR_CODES.STALE);
        }
        const u = this.applyHunksToTarget(target, info, op.hunks);
        results.push({ kind: 'update', path: target.displayPath, version: u.version, hunks: op.hunks.length });
      } else {
        throw fsError('未知补丁操作：' + op.kind, ERROR_CODES.PATCH_UNSUPPORTED);
      }
    }
    return { operations: results };
  }

  expectedFor(input, opts) {
    if (!opts || !opts.expectedVersions) return undefined;
    const map = opts.expectedVersions;
    const target = this.resolve(input);
    return map[input] || map[target.displayPath] || map[target.abs] || undefined;
  }

  deleteFile(input, opts = {}) {
    const target = this.resolve(input);
    const prior = this.requireObserved(target, '删除');
    const { info } = this.stat(target.abs);
    if (!info) throw fsError('文件不存在：' + target.displayPath, ERROR_CODES.NOT_FOUND);
    if (info.type !== 'file') throw fsError('不是普通文件：' + target.displayPath, ERROR_CODES.NOT_REGULAR_FILE);
    const expected = opts.expectedVersion == null ? prior.version : opts.expectedVersion;
    if (!sameVersion(expected, info.version)) throw fsError('文件在读取之后被改过，已拒绝删除：' + target.displayPath, ERROR_CODES.STALE);
    let before = null;
    try { before = fs.readFileSync(target.abs, 'utf8'); } catch (_) {}
    // 删除前最后一刻再验一次，避免"校验完到 unlink 之间"被改。
    const current = versionOf(target.abs);
    if (!sameVersion(expected, current)) throw fsError('文件在删除前被改过：' + target.displayPath, ERROR_CODES.STALE);
    fs.unlinkSync(target.abs);
    recordObservation(this.ownerKey, target.targetKey, { kind: 'absent' });
    return { target, before };
  }

  list(input) {
    const target = this.resolve(input || '.');
    const st = fs.statSync(target.abs);
    if (!st.isDirectory()) throw fsError('不是目录：' + target.displayPath, ERROR_CODES.NOT_DIRECTORY);
    return fs.readdirSync(target.abs, { withFileTypes: true }).map((ent) => {
      const abs = path.join(target.abs, ent.name);
      let size;
      try { size = fs.statSync(abs).size; } catch (_) {}
      return { name: ent.name, type: ent.isDirectory() ? 'directory' : ent.isFile() ? 'file' : 'other', size, target: this.resolve(abs) };
    });
  }

  search(input, pattern, include) {
    const target = this.resolve(input || '.');
    if (!fs.statSync(target.abs).isDirectory()) throw fsError('不是目录：' + target.displayPath, ERROR_CODES.NOT_DIRECTORY);
    const src = String(pattern == null ? '' : pattern);
    if (!src) throw fsError('缺少 pattern', ERROR_CODES.INVALID_PATH);
    let re;
    try { re = new RegExp(src, 'i'); } catch (e) { throw fsError('正则不合法：' + e.message, ERROR_CODES.INVALID_PATH, e); }
    const inc = String(include || '');
    const incRe = inc ? globToRegExp(inc.includes('*') ? inc : '*.' + inc.replace(/^\./, '')) : null;
    const incBaseOnly = !!inc && !inc.includes('/');
    const files = [];
    let total = 0;
    let blocked = false;
    const walk = walkFiles(target.abs, SEARCH_MAX_FILES, (abs) => {
      const rel = relTo(this.workspaceRoot, abs);
      if (incRe && !incRe.test(incBaseOnly ? path.basename(rel) : rel)) return true;
      const text = readTextIfSmall(abs);
      if (text === null) return true;
      const lines = text.split(/\r?\n/);
      const matches = [];
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        matches.push({ lineNumber: i + 1, line: lines[i].slice(0, 500) });
        total += 1;
        if (total >= SEARCH_MAX_MATCHES) { blocked = true; break; }
      }
      if (matches.length) files.push({ path: rel, matches });
      return !blocked;
    });
    return { base: target.abs, files, total, truncated: !!(walk.truncated || blocked) };
  }

  glob(input, pattern) {
    const target = this.resolve(input || '.');
    if (!fs.statSync(target.abs).isDirectory()) throw fsError('不是目录：' + target.displayPath, ERROR_CODES.NOT_DIRECTORY);
    const src = String(pattern == null ? '' : pattern).trim();
    if (!src) throw fsError('缺少 pattern', ERROR_CODES.INVALID_PATH);
    const re = globToRegExp(src);
    const paths = [];
    let blocked = false;
    const walk = walkFiles(target.abs, SEARCH_MAX_FILES, (abs) => {
      const rel = relTo(target.abs, abs);
      if (!re.test(rel)) return true;
      paths.push(relTo(this.workspaceRoot, abs));
      if (paths.length >= SEARCH_MAX_PATHS) { blocked = true; return false; }
      return true;
    });
    return { base: target.abs, paths, truncated: !!(walk.truncated || blocked) };
  }
}

const cache = new Map();

function forContext(ctx) {
  const root = ctx && ctx.workspace && ctx.workspace.path;
  if (!root) throw fsError('没有活动工作区', ERROR_CODES.NOT_DIRECTORY);
  const ownerKey = (ctx && (ctx.sessionId || ctx.workspace.id || ctx.workspace.path)) || root;
  const allowOutside = ctx && ctx.permission === 'full';
  const key = root + '\0' + ownerKey + '\0' + (allowOutside ? '1' : '0');
  let inst = cache.get(key);
  if (!inst) {
    inst = new FileSystem({ workspaceRoot: root, ownerKey, allowOutside });
    cache.set(key, inst);
    // 缓存只为复用实例；observation 在独立表里，reset 不依赖实例。
    if (cache.size > 32) cache.delete(cache.keys().next().value);
  }
  return inst;
}

function resetForTests(opts = {}) {
  cache.clear();
  if (opts.ownerKey) clearObservations(opts.ownerKey);
  else if (opts.keepObservations !== true) observedByOwner.clear();
}

module.exports = {
  FileSystem,
  FsError,
  ERROR_CODES,
  PatchParseError,
  isFsError,
  fsError,
  forContext,
  parsePatch,
  applyHunks,
  versionOf,
  sameVersion,
  resolveTarget,
  clearObservations,
  resetForTests,
  MAX_READ,
  MAX_WRITE,
};
