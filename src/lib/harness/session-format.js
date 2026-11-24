/**
 * D1-01 Session format catalog（2026-11-23）
 *
 * 只做两件事：识别格式、把旧格式升级到新格式。**不改写已提交事件**：
 *  · 旧物化 JSON（v0/v1）：原子写 + .bak，失败不覆盖；
 *  · 事件日志（v2/v3/v4）：只追加 `session/format` 标记，历史一个字节不动。
 *
 * v0  messages 数组，无 settings
 * v1  messages + settings（兼容物化视图）
 * v2  append-only events.jsonl（seq/hash 链）
 * v3  v2 + session/compaction（压缩检查点）
 * v4  v3 + session/checkpoint / tool/intent（D1 检查点）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { SessionLog } = require('./session-log');

const VERSIONS = Object.freeze([0, 1, 2, 3, 4]);
const LATEST = 4;

function parseEvents(raw) {
  const out = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { break; }
  }
  return out;
}

/** 从事件能力推版本；有 session/format 标记时以标记为准。 */
function detectEvents(events) {
  const list = Array.isArray(events) ? events : [];
  let marked = -1;
  for (const ev of list) {
    if (ev && ev.type === 'session/format' && Number.isFinite(Number(ev.version))) {
      marked = Math.max(marked, Number(ev.version));
    }
  }
  if (marked >= 0) return Math.min(LATEST, marked);
  if (list.some((e) => e && (e.type === 'session/checkpoint' || e.type === 'tool/intent'))) return 4;
  if (list.some((e) => e && e.type === 'session/compaction')) return 3;
  return list.length ? 2 : 0;
}

/** 读取 JSON，容忍 BOM；坏文件返回 null。 */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return null; }
}

/** 从物化 JSON 推版本。 */
function detectJson(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.messages)) return 0;
  const n = Number(doc.schemaVersion);
  if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  return doc.settings && typeof doc.settings === 'object' ? 1 : 0;
}

/** 识别一个文件（.jsonl 事件日志 / .json 物化视图）。 */
function detectFile(file) {
  const p = String(file || '');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    if (/\.jsonl$/i.test(p)) {
      const events = parseEvents(raw);
      return { kind: 'events', version: detectEvents(events), events };
    }
    const doc = JSON.parse(raw.replace(/^\uFEFF/, ''));
    return { kind: 'json', version: detectJson(doc), doc };
  } catch (e) {
    return { kind: 'missing', version: null, error: e.message };
  }
}

function backup(file) {
  const bak = file + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
  try { fs.copyFileSync(file, bak); } catch (_) { return ''; }
  return bak;
}

/** v0 → v1：补 settings / schemaVersion。纯函数，返回新对象。 */
function migrateJsonV0toV1(doc) {
  const d = Object.assign({}, doc || {});
  d.messages = Array.isArray(d.messages) ? d.messages : [];
  d.settings = (d.settings && typeof d.settings === 'object') ? d.settings : {};
  d.schemaVersion = 1;
  return d;
}

/** 物化 JSON 原子写：先 .bak 再 tmp+rename；失败不碰原文件。 */
function writeJsonAtomic(file, doc) {
  const bak = backup(file);
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return { backup: bak };
}

/**
 * 事件日志升级：只追加版本标记，历史不动。幂等。
 * @returns {{changed:boolean, from:number, to:number, event:object|null}}
 */
function upgradeEventLog(log, target) {
  const logObj = typeof log === 'string' ? new SessionLog(log) : log;
  const to = Math.max(0, Math.min(LATEST, Number.isFinite(Number(target)) ? Number(target) : LATEST));
  const from = detectEvents(logObj.events());
  if (from >= to) return { changed: false, from, to, event: null };
  const event = logObj.append('session/format', { version: to, from });
  return { changed: true, from, to, event };
}

/**
 * 升级一个会话文件到目标版本。
 * @param {string} file
 * @param {number} [target]
 */
function migrateFile(file, target) {
  const to = Math.max(0, Math.min(LATEST, Number.isFinite(Number(target)) ? Number(target) : LATEST));
  const info = detectFile(file);
  if (info.kind === 'missing') return { ok: false, from: null, to, error: info.error };
  if (info.kind === 'json') {
    if (info.version >= Math.min(1, to)) return { ok: true, changed: false, from: info.version, to: info.version };
    const next = migrateJsonV0toV1(info.doc);
    const w = writeJsonAtomic(file, next);
    return { ok: true, changed: true, from: info.version, to: next.schemaVersion, backup: w.backup };
  }
  const log = new SessionLog(file);
  const r = upgradeEventLog(log, to);
  return Object.assign({ ok: true }, r);
}

module.exports = {
  VERSIONS, LATEST,
  parseEvents, detectEvents, detectJson, detectFile, readJson,
  migrateJsonV0toV1, writeJsonAtomic, backup,
  upgradeEventLog, migrateFile,
};
