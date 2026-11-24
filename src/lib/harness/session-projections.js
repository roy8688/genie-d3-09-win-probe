/**
 * D1-02 / D1-03 Session projections + cache（2026-11-23）
 *
 * 事件日志是唯一真源；投影只读事件，不另建日志。
 * 每个投影注册 `{ type, init, apply, snapshot }`，缓存只存“最后 seq + hash + snapshot”。
 * 冷启动命中断点后只重放尾部；缓存缺失/损坏从 0 重建，绝不让会话打不开。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const CACHE_SCHEMA = 1;

function clone(v) {
  try { return JSON.parse(JSON.stringify(v)); } catch (_) { return v; }
}

function emptyGoal() { return { text: '', status: 'active', updatedAt: 0 }; }
function emptyPlan() { return { title: '', items: [], status: 'active', updatedAt: 0 }; }
function emptyCompaction() {
  return { applied: false, summary: '', beforeChars: 0, afterChars: 0, droppedCount: 0, seq: 0, updatedAt: 0 };
}
function emptyStats() {
  return {
    turns: 0, steps: 0, tools: 0, toolErrors: 0,
    promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHit: 0,
    lastTurnMs: 0, totalTurnMs: 0, startedAt: 0, updatedAt: 0,
  };
}

const DEFAULT_PROJECTIONS = [
  {
    type: 'messages',
    init: () => [],
    apply(list, ev) {
      if (ev.type === 'session/cleared') return [];
      if (ev.type === 'message/patched') {
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i] && list[i].role === ev.role) {
            if (ev.meta && typeof ev.meta === 'object') Object.assign(list[i], clone(ev.meta));
            break;
          }
        }
        return list;
      }
      if (ev.type !== 'user/message' && ev.type !== 'assistant/message' && ev.type !== 'system/message') return list;
      const role = ev.type.split('/')[0];
      const msg = { role, content: String(ev.content == null ? '' : ev.content) };
      if (ev.ts) msg.ts = ev.ts;
      if (ev.meta && typeof ev.meta === 'object') {
        for (const k of ['via', 'status', 'error', 'attachments', 'synthetic']) {
          if (ev.meta[k] !== undefined) msg[k] = clone(ev.meta[k]);
        }
      }
      list.push(msg);
      return list;
    },
    snapshot: (v) => v,
  },
  {
    type: 'settings',
    init: () => ({}) ,
    apply(state, ev) {
      if (ev.type === 'session/settings' && ev.settings && typeof ev.settings === 'object') {
        return clone(ev.settings);
      }
      return state;
    },
    snapshot: (v) => v,
  },
  {
    type: 'title',
    init: () => '',
    apply(state, ev) {
      if (ev.type === 'session/title' || ev.type === 'session/created' || ev.type === 'session/forked') {
        return String(ev.title || state || '');
      }
      return state;
    },
    snapshot: (v) => v || '',
  },
  {
    type: 'goal',
    init: emptyGoal,
    apply(state, ev) {
      if (ev.type !== 'session/goal') return state;
      return {
        text: String(ev.text || ''),
        status: String(ev.status || 'active'),
        updatedAt: Number(ev.ts || 0),
      };
    },
    snapshot: (v) => v,
  },
  {
    type: 'plan',
    init: emptyPlan,
    apply(state, ev) {
      if (ev.type !== 'session/plan') return state;
      return {
        title: String(ev.title || ''),
        status: String(ev.status || 'active'),
        items: Array.isArray(ev.items) ? ev.items.map((x, i) => ({
          id: String((x && x.id) || ('p' + (i + 1))),
          text: String((x && x.text) || ''),
          status: String((x && x.status) || 'pending'),
        })) : [],
        updatedAt: Number(ev.ts || 0),
      };
    },
    snapshot: (v) => v,
  },
  {
    type: 'todo',
    init: () => [],
    apply(state, ev) {
      if (ev.type === 'turn/start') return [];
      if (ev.type !== 'todo/write') return state;
      const raw = (ev.data && Array.isArray(ev.data.todos)) ? ev.data.todos
        : (Array.isArray(ev.todos) ? ev.todos : []);
      return raw.map((x, i) => ({
        content: String((x && x.content) || ''),
        status: String((x && x.status) || 'pending'),
        id: String((x && x.id) || ('t' + (i + 1))),
      })).filter((x) => x.content);
    },
    snapshot: (v) => v,
  },
  {
    type: 'queue',
    init: () => [],
    apply(state, ev) {
      if (ev.type === 'session/cleared') return [];
      return state;
    },
    snapshot: (v) => v,
  },
  {
    type: 'subagent',
    init: () => ({ active: [], done: [] }),
    apply(state, ev) {
      if (ev.type === 'subagent/start') {
        const item = {
          childId: String(ev.childId || ''), title: String(ev.title || ''),
          depth: Number(ev.depth || 0), parentSessionId: String(ev.parentSessionId || ''),
          startedAt: Number(ev.ts || 0),
        };
        return { active: state.active.concat([item]), done: state.done };
      }
      if (ev.type === 'subagent/end') {
        const childId = String(ev.childId || '');
        const found = state.active.find((x) => x.childId === childId) || {};
        return {
          active: state.active.filter((x) => x.childId !== childId),
          done: state.done.concat([Object.assign({}, found, {
            childId, status: String(ev.status || 'done'), ok: ev.ok !== false,
            chars: Number(ev.chars || 0), endedAt: Number(ev.ts || 0),
          })]),
        };
      }
      return state;
    },
    snapshot: (v) => v,
  },
  {
    type: 'stats',
    init: emptyStats,
    apply(state, ev) {
      const s = Object.assign({}, state);
      s.updatedAt = Number(ev.ts || s.updatedAt);
      if (ev.type === 'turn/start') {
        s.turns += 1;
        if (!s.startedAt) s.startedAt = Number(ev.ts || 0);
      } else if (ev.type === 'step/start') {
        s.steps += 1;
      } else if (ev.type === 'tool/call') {
        s.tools += 1;
      } else if (ev.type === 'tool/result' && ev.ok === false) {
        s.toolErrors += 1;
      } else if (ev.type === 'turn/end') {
        s.lastTurnMs = Number(ev.totalMs || 0);
        s.totalTurnMs += s.lastTurnMs;
        const u = ev.usage && typeof ev.usage === 'object' ? ev.usage : null;
        if (u) {
          s.promptTokens += Number(u.prompt || 0);
          s.completionTokens += Number(u.completion || 0);
          s.totalTokens += Number(u.total || 0);
          s.cacheHit += Number(u.cacheHit || 0);
        }
      }
      return s;
    },
    snapshot: (v) => v,
  },
  {
    type: 'outline',
    init: () => [],
    apply(state, ev) {
      if (ev.type === 'turn/start') {
        return state.concat([{
          seq: Number(ev.seq || 0), msgId: String(ev.msgId || ''),
          ts: Number(ev.ts || 0), textChars: Number(ev.textChars || 0),
          reason: 'incomplete', totalMs: null, tools: 0, steps: 0,
        }]);
      }
      if (!state.length) return state;
      if (ev.type === 'step/start') {
        const last = Object.assign({}, state[state.length - 1]);
        last.steps = Number(last.steps || 0) + 1;
        return state.slice(0, -1).concat([last]);
      }
      if (ev.type === 'tool/call') {
        const last = Object.assign({}, state[state.length - 1]);
        last.tools = Number(last.tools || 0) + 1;
        return state.slice(0, -1).concat([last]);
      }
      if (ev.type === 'turn/end') {
        const last = Object.assign({}, state[state.length - 1]);
        last.reason = String(ev.reason || 'incomplete');
        last.totalMs = ev.totalMs == null ? null : Number(ev.totalMs);
        return state.slice(0, -1).concat([last]);
      }
      return state;
    },
    snapshot: (v) => v,
  },
  {
    type: 'workingDir',
    init: () => '',
    apply(state, ev) {
      if (ev.type === 'session/working-dir') return String(ev.path || state || '');
      if (ev.type === 'request/header') return String(ev.workspacePath || ev.workingDir || state || '');
      return state;
    },
    snapshot: (v) => v || '',
  },
  {
    type: 'pendingInteraction',
    init: () => null,
    apply(state, ev) {
      if (ev.type === 'interaction/request') {
        return { id: String(ev.id || ''), kind: String(ev.kind || ''), at: Number(ev.ts || 0) };
      }
      if (ev.type === 'interaction/response' || ev.type === 'session/cleared' || ev.type === 'turn/end') return null;
      return state;
    },
    snapshot: (v) => v,
  },
  {
    type: 'compaction',
    init: emptyCompaction,
    apply(state, ev) {
      if (ev.type !== 'session/compaction') return state;
      return {
        applied: !!((ev.meta && ev.meta.applied) || ev.applied),
        summary: String(ev.summary || ev.summaryPreview || ''),
        beforeChars: Number(ev.beforeChars || 0),
        afterChars: Number(ev.afterChars || 0),
        droppedCount: Number(ev.droppedCount || 0),
        seq: Number(ev.seq || 0),
        updatedAt: Number(ev.ts || 0),
      };
    },
    snapshot: (v) => v,
  },
  {
    type: 'formatVersion',
    init: () => 0,
    apply(state, ev) {
      if (ev.type === 'session/format') return Math.max(Number(state || 0), Number(ev.version || 0));
      return state;
    },
    snapshot: (v) => Number(v || 0),
  },
];

class ProjectionRegistry {
  constructor() { this.map = new Map(); }

  register(p) {
    if (!p || !p.type || typeof p.apply !== 'function') throw new Error('投影必须有 type 与 apply');
    if (this.map.has(p.type)) throw new Error('投影重复注册：' + p.type);
    this.map.set(p.type, Object.assign({
      init: () => null,
      snapshot: (v) => v,
    }, p));
    return this;
  }

  types() { return Array.from(this.map.keys()); }

  init() {
    const state = {};
    for (const [type, p] of this.map) state[type] = clone(p.init());
    return state;
  }

  apply(state, ev) {
    const next = state || this.init();
    for (const [type, p] of this.map) {
      try { next[type] = p.apply(next[type], ev, next); } catch (_) { /* 单个投影失败不拖垮会话 */ }
    }
    return next;
  }

  snapshot(state) {
    const out = {};
    for (const [type, p] of this.map) {
      try { out[type] = clone(p.snapshot(state ? state[type] : null)); } catch (_) { out[type] = null; }
    }
    return out;
  }
}

function createRegistry(list) {
  const r = new ProjectionRegistry();
  for (const p of (list || DEFAULT_PROJECTIONS)) r.register(p);
  return r;
}

const defaultRegistry = createRegistry();

/**
 * 重放事件得到投影。
 * @param {Array} events
 * @param {{registry?:ProjectionRegistry, initial?:object}} [opts]
 */
function projectEvents(events, opts) {
  const o = opts || {};
  const registry = o.registry || defaultRegistry;
  let state = o.initial && typeof o.initial === 'object' ? clone(o.initial) : registry.init();
  let seq = Number(o.startSeq || 0);
  let hash = String(o.startHash || '');
  for (const ev of (Array.isArray(events) ? events : [])) {
    state = registry.apply(state, ev);
    seq = Number(ev.seq || seq);
    hash = String(ev.hash || hash);
  }
  return { snapshot: registry.snapshot(state), state, seq, hash };
}

function cacheFileFor(log, opts) {
  if (opts && opts.cacheFile) return String(opts.cacheFile);
  if (process.env.GENIE_PROJECTION_CACHE_DIR) {
    return path.join(process.env.GENIE_PROJECTION_CACHE_DIR, path.basename(log.file) + '.projection.json');
  }
  return log.file + '.projection.json';
}

function readCache(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || j.schema !== CACHE_SCHEMA || !Number.isFinite(Number(j.seq)) || !j.snapshot) return null;
    return j;
  } catch (_) { return null; }
}

function writeCache(file, seq, hash, snapshot) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ schema: CACHE_SCHEMA, seq, hash, snapshot }), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (_) { return false; }
}

/**
 * 读投影：命中缓存只重放尾部；缓存坏了从 0 重建。
 * @param {SessionLog} log
 */
function load(log, opts) {
  const o = opts || {};
  const events = log.events();
  const cacheFile = cacheFileFor(log, o);
  const cache = o.useCache === false ? null : readCache(cacheFile);
  let start = 0;
  let initial = null;
  let cacheHit = false;
  if (cache) {
    const seq = Number(cache.seq || 0);
    const hash = String(cache.hash || '');
    const tailHash = seq > 0 ? String((events[seq - 1] || {}).hash || '') : '';
    if (seq <= events.length && (seq === 0 ? hash === '' : hash && tailHash === hash)) {
      start = seq;
      initial = cache.snapshot;
      cacheHit = true;
    }
  }
  const r = projectEvents(events.slice(start), {
    registry: o.registry || defaultRegistry,
    initial,
    startSeq: start,
    startHash: start > 0 ? String((events[start - 1] || {}).hash || '') : '',
  });
  if (o.useCache !== false && o.writeCache !== false) writeCache(cacheFile, r.seq, r.hash, r.snapshot);
  return {
    snapshot: r.snapshot,
    seq: r.seq,
    hash: r.hash,
    replayed: events.length - start,
    cacheHit,
    cacheFile,
  };
}

function clearCache(log, opts) {
  try { fs.rmSync(cacheFileFor(log, opts), { force: true }); return true; } catch (_) { return false; }
}

module.exports = {
  CACHE_SCHEMA, DEFAULT_PROJECTIONS, ProjectionRegistry,
  createRegistry, defaultRegistry, clone,
  projectEvents, load, clearCache, cacheFileFor,
  emptyGoal, emptyPlan, emptyCompaction, emptyStats,
};
