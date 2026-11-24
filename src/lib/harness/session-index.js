'use strict';
/**
 * 会话全文索引（D2-07）
 *
 * 目标只有一个：**"上次那个决定"要能定位到原话**，而不是按标题猜。
 *
 * 为什么用 SQLite FTS5：
 *  · 会话是 append-only 事件日志，规模会一直长；每次提问都全目录 `grep` 是 O(全部历史)。
 *  · FTS5 自带 bm25 排序与高亮片段，不需要自己写打分。
 *  · Node 22 自带 `node:sqlite`，不引第三方依赖——"零依赖"是这个项目的硬约束。
 *
 * 中文用 `trigram` 分词：unicode61 会把整段中文当成一个词，搜"决定"永远搜不到
 * "这个决定先不做"；trigram 按三字滑窗建索引，子串才命中。
 * 两字查询低于三元组下限，走 LIKE 兜底，不假装 FTS 什么都能搜。
 *
 * 索引里**只存消息文本与元信息**，不复制附件、不存整份事件。重建随时可做，
 * 所以它可以被安全删掉——这是"派生数据"和"真源"的分界。
 */

const fs = require('node:fs');
const path = require('node:path');
const paths = require('../paths');
const { SessionLog } = require('./session-log');
const SessionProjections = require('./session-projections');

let DatabaseSync = null;
let sqliteError = '';
try {
  // node:sqlite 在部分 Node 版本会打 ExperimentalWarning；只影响 stderr，不影响结果。
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  sqliteError = e && e.message ? e.message : String(e);
}

const dirFile = () => process.env.GENIE_CONVERSATIONS_DIR || path.join(paths.brainMeta, 'conversations');
const dbFile = () => process.env.GENIE_SESSION_DB || path.join(paths.brainMeta, 'sessions.db');

let _db = null;
let _dbPath = '';
let _fts = false;

function openDb() {
  if (!DatabaseSync) throw Object.assign(new Error('当前 Node 不支持 node:sqlite：' + sqliteError), { code: 'SQLITE_UNAVAILABLE' });
  const f = dbFile();
  if (_db && _dbPath === f) return _db;
  try { if (_db) _db.close(); } catch (_) {}
  fs.mkdirSync(path.dirname(f), { recursive: true });
  _db = new DatabaseSync(f);
  _db.exec('PRAGMA journal_mode = WAL;');
  _db.exec('PRAGMA synchronous = NORMAL;');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0,
      mtime_ms INTEGER NOT NULL DEFAULT 0,
      msg_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  try {
    _db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(
        session_id UNINDEXED,
        msg_id UNINDEXED,
        role UNINDEXED,
        ts UNINDEXED,
        title,
        content,
        tokenize='trigram'
      );
    `);
    _fts = true;
  } catch (e) {
    // 某些构建不带 trigram。退回普通表 + LIKE，功能降级但要能查。
    _fts = false;
    _db.exec(`
      CREATE TABLE IF NOT EXISTS messages_plain (
        session_id TEXT, msg_id TEXT, role TEXT, ts INTEGER, title TEXT, content TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_plain_session ON messages_plain(session_id);
    `);
  }
  _dbPath = f;
  return _db;
}

function eventFiles() {
  const dir = dirFile();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.events.jsonl')).map((f) => path.join(dir, f));
}

function sessionIdOf(file) {
  return path.basename(file).replace(/\.events\.jsonl$/, '');
}

function fileMtime(file) {
  try { return Math.round(fs.statSync(file).mtimeMs); } catch (_) { return 0; }
}

function messageText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content.map((b) => (b && typeof b === 'object' ? (b.text || b.content || '') : String(b || ''))).join('\n');
  }
  if (m.content == null) return '';
  try { return JSON.stringify(m.content); } catch (_) { return String(m.content); }
}

function indexSession(sessionId, opts) {
  const o = opts || {};
  const db = openDb();
  const id = String(sessionId || '');
  if (!id) throw new Error('缺少 sessionId');
  const file = path.join(dirFile(), id + '.events.jsonl');
  const meta = db.prepare('SELECT mtime_ms, msg_count FROM sessions WHERE session_id = ?').get(id);
  const mtime = fileMtime(file);
  if (!o.force && meta && Number(meta.mtime_ms) === mtime) {
    return { sessionId: id, indexed: false, messages: Number(meta.msg_count || 0), cached: true };
  }
  const log = new SessionLog(file);
  if (!log.exists()) return { sessionId: id, indexed: false, missing: true, messages: 0 };
  const snap = SessionProjections.load(log, { useCache: false }).snapshot;
  const messages = Array.isArray(snap.messages) ? snap.messages : [];
  const title = String(snap.title || log.title() || '');
  const updated = messages.reduce((mx, m) => Math.max(mx, Number(m && m.ts || 0)), log.updatedAt() || 0);

  db.exec('BEGIN');
  try {
    if (_fts) db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    else db.prepare('DELETE FROM messages_plain WHERE session_id = ?').run(id);
    const stmt = _fts
      ? db.prepare('INSERT INTO messages(session_id,msg_id,role,ts,title,content) VALUES (?,?,?,?,?,?)')
      : db.prepare('INSERT INTO messages_plain(session_id,msg_id,role,ts,title,content) VALUES (?,?,?,?,?,?)');
    let n = 0;
    for (const m of messages) {
      const text = messageText(m).trim();
      if (!text) continue;
      stmt.run(id, String(m.msgId || ''), String(m.role || ''), Number(m.ts || 0), title, text);
      n += 1;
    }
    db.prepare(`INSERT INTO sessions(session_id,title,updated_at,mtime_ms,msg_count)
      VALUES (?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at,
      mtime_ms=excluded.mtime_ms, msg_count=excluded.msg_count`).run(id, title, updated, mtime, n);
    db.exec('COMMIT');
    return { sessionId: id, indexed: true, messages: n, title, mtime };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

/**
 * 扫描目录，增量索引。
 * 只索引 mtime 变过的会话；已删除的会话从索引里清掉（否则会永远搜到不存在的文件）。
 */
function sync(opts) {
  const o = opts || {};
  const db = openDb();
  const files = eventFiles();
  const seen = new Set(files.map(sessionIdOf));
  let indexed = 0;
  let skipped = 0;
  const errors = [];
  for (const f of files) {
    try {
      const r = indexSession(sessionIdOf(f), o);
      if (r.indexed) indexed += 1; else skipped += 1;
    } catch (e) {
      errors.push({ file: f, error: e.message || String(e) });
    }
  }
  const rows = db.prepare('SELECT session_id FROM sessions').all();
  for (const row of rows) {
    if (seen.has(row.session_id)) continue;
    db.exec('BEGIN');
    try {
      if (_fts) db.prepare('DELETE FROM messages WHERE session_id = ?').run(row.session_id);
      else db.prepare('DELETE FROM messages_plain WHERE session_id = ?').run(row.session_id);
      db.prepare('DELETE FROM sessions WHERE session_id = ?').run(row.session_id);
      db.exec('COMMIT');
    } catch (_) { try { db.exec('ROLLBACK'); } catch (_) {} }
  }
  return { ok: errors.length === 0, files: files.length, indexed, skipped, errors, fts: _fts };
}

function termsOf(q) {
  const text = String(q || '').replace(/["'“”‘’]/g, ' ').trim();
  const parts = text.split(/\s+/).filter(Boolean);
  const terms = [];
  for (const p of parts) {
    if (p.length >= 3) terms.push(p);
    // 长中文句子里没有空格：两字窗口不够 trigram，但 3~8 字滑窗能命中短语。
    if (/^[\u4e00-\u9fff]{4,}$/.test(p)) {
      for (let i = 0; i + 6 <= p.length; i += 3) terms.push(p.slice(i, i + 6));
    }
  }
  return terms.length ? terms : [text];
}

function snippetAround(content, terms, width) {
  const text = String(content || '');
  const w = width || 180;
  let hit = -1;
  for (const t of terms) {
    const i = text.indexOf(t);
    if (i >= 0 && (hit < 0 || i < hit)) hit = i;
  }
  if (hit < 0) return text.slice(0, w) + (text.length > w ? '…' : '');
  const start = Math.max(0, hit - Math.floor(w / 3));
  const end = Math.min(text.length, start + w);
  return (start ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

function search(query, opts) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: '缺少 query', hits: [] };
  const o = opts || {};
  const limit = Math.min(Math.max(Number(o.limit || 8), 1), 20);
  sync({ force: false });
  const db = openDb();
  const terms = termsOf(q);
  let rows = [];

  if (_fts) {
    // 短语优先：整句能命中时排序最准。
    const phrase = '"' + q.replace(/"/g, '""') + '"';
    try {
      rows = db.prepare(`SELECT session_id,msg_id,role,ts,title,content,bm25(messages) AS score
        FROM messages WHERE messages MATCH ? ORDER BY bm25(messages) LIMIT ?`).all(phrase, limit);
    } catch (_) { rows = []; }
    if (!rows.length) {
      const or = terms.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' OR ');
      try {
        rows = db.prepare(`SELECT session_id,msg_id,role,ts,title,content,bm25(messages) AS score
          FROM messages WHERE messages MATCH ? ORDER BY bm25(messages) LIMIT ?`).all(or, limit);
      } catch (_) { rows = []; }
    }
    if (!rows.length) {
      const like = '%' + q + '%';
      rows = db.prepare(`SELECT session_id,msg_id,role,ts,title,content,0 AS score
        FROM messages WHERE content LIKE ? ORDER BY ts DESC LIMIT ?`).all(like, limit);
    }
  } else {
    const like = '%' + q + '%';
    rows = db.prepare(`SELECT session_id,msg_id,role,ts,title,content,0 AS score
      FROM messages_plain WHERE content LIKE ? ORDER BY ts DESC LIMIT ?`).all(like, limit);
  }

  const hits = rows.map((r) => ({
    sessionId: r.session_id,
    msgId: r.msg_id || '',
    role: r.role || '',
    ts: Number(r.ts || 0),
    title: r.title || '',
    snippet: snippetAround(r.content, terms),
    score: Number(r.score || 0),
  }));
  return {
    ok: true, query: q, hits, terms,
    engine: _fts ? 'sqlite-fts5-trigram' : 'sqlite-like', limit,
    note: _fts ? '' : '当前 SQLite 构建没有 trigram，已降级为 LIKE（两字词也能查，但排序较弱）',
  };
}

function stats() {
  const db = openDb();
  const s = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(msg_count),0) AS m FROM sessions').get();
  return { sessions: Number(s.n || 0), messages: Number(s.m || 0), fts: _fts, db: dbFile(), dir: dirFile() };
}

/** 会话列表（按最近更新倒序）。可按标题过滤，但这不是全文检索——那是 search()。 */
function listSessions(opts) {
  const o = opts || {};
  sync({ force: false });
  const db = openDb();
  const limit = Math.min(Math.max(Number(o.limit || 20), 1), 50);
  let rows = db.prepare('SELECT session_id,title,updated_at,msg_count FROM sessions ORDER BY updated_at DESC LIMIT ?').all(limit);
  if (o.query) {
    const q = String(o.query).toLowerCase();
    rows = rows.filter((r) => String(r.title || '').toLowerCase().includes(q));
  }
  return {
    ok: true,
    sessions: rows.map((r) => ({
      sessionId: r.session_id,
      title: r.title || '',
      updatedAt: Number(r.updated_at || 0),
      messages: Number(r.msg_count || 0),
    })),
  };
}

/** 读一个会话的消息（尾部），用于在检索命中后回到原话上下文。 */
function readSession(sessionId, opts) {
  const o = opts || {};
  const id = String(sessionId || '').trim();
  if (!id) return { ok: false, error: '缺少 sessionId' };
  const file = path.join(dirFile(), id + '.events.jsonl');
  const log = new SessionLog(file);
  if (!log.exists()) return { ok: false, error: '没有这个会话：' + id };
  const snap = SessionProjections.load(log, { useCache: false }).snapshot;
  const all = Array.isArray(snap.messages) ? snap.messages : [];
  const limit = Math.min(Math.max(Number(o.limit || 20), 2), 100);
  const tail = all.slice(-limit);
  return {
    ok: true,
    sessionId: id,
    title: String(snap.title || ''),
    total: all.length,
    messages: tail.map((m) => ({
      role: String(m.role || ''),
      ts: Number(m.ts || 0),
      content: messageText(m).slice(0, 2000),
    })),
  };
}

function close() {
  if (_db) { try { _db.close(); } catch (_) {} }
  _db = null;
  _dbPath = '';
}

function reset() {
  close();
  try { fs.rmSync(dbFile(), { force: true }); } catch (_) {}
  try { fs.rmSync(dbFile() + '-wal', { force: true }); } catch (_) {}
  try { fs.rmSync(dbFile() + '-shm', { force: true }); } catch (_) {}
}

module.exports = {
  indexSession, sync, search, listSessions, readSession, stats, close, reset, dbFile, dirFile,
  get fts() { return _fts; },
  _termsOf: termsOf,
};
