/**
 * SessionEvent 日志内核（M1）—— 对标 DeepSeek Harness 的 core/session
 *
 * ═══════════ 为什么要有这一层 ═══════════
 * DSH 的铁律：「**模型可见即已记录**」——会话日志是唯一真源，模型上下文
 * 由 deriveMessages() 从日志**投影**出来，不另存一份。于是回放、fork、
 * 中断修复、轨迹 UI 都从同一份 append-only 日志派生，而不是各写一套。
 *
 * Genie 的 conversation.js 现在是「整块 JSON 覆盖写」：消息、标题、时间戳
 * 混在一个对象里，每次 add 都重写整个文件。它没有「事件」概念，所以：
 *  · 无法回答「这一轮发生了什么」（turn/step/工具调用全丢）
 *  · 无法 fork（只能复制整块）
 *  · 进程在写窗口崩溃 = 半截 JSON（历史自愈只能靠扫描补救）
 *
 * 这一层只做**日志与投影**，不碰业务：
 *  ① append(type, payload) —— 只追加，JSONL 一行一事件，带序号与哈希链；
 *  ② deriveMessages()      —— 投影出 OpenAI messages（含兜底过滤的钩子）；
 *  ③ repairInterrupted()   —— 崩溃时补 step/end + turn/end + tool/result；
 *  ④ fork(prefixCount)     —— 复制前缀到新会话，写清继承边界。
 *
 * 三条纪律（照抄 DSH，写在这里免得后来人绕开）：
 *  1. **绝不改写已提交事件**：已 append 的行一个字节都不改；要「撤销」就
 *     append 一个遮蔽事件（replace/clear），由投影层解释。
 *  2. **投影是纯函数**：deriveMessages 只读日志、不写日志、不改入参；
 *     纯尾部增量可缓存，但首版追求正确，缓存是后续优化。
 *  3. **崩溃可恢复**：每条事件带 seq 与 prevHash；读到半截尾行要能截掉，
 *     不因为最后一行坏了就丢掉整份历史。
 *
 * 落盘：<session-id>.events.jsonl（与 conversation.js 的 <id>.json 并存，
 * 后者降级为兼容物化视图；对外 API 完全不变）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** 事件类型白名单：写错名字宁可报错，也不要产生"投影时永远看不到"的幽灵事件。 */
const EVENT_TYPES = Object.freeze([
  'session/created',            // { title, mode }
  'session/title',              // { title }            —— 遮蔽旧标题
  'session/cleared',            // {}                   —— 遮蔽此前全部消息
  'user/message',               // { content, meta? }
  'assistant/message',          // { content, meta? }
  'assistant/attempt',          // { reason, content? } —— 失败/取消/重试，不进模型历史
  'system/message',             // { content, meta? }
  'message/patched',            // { role, meta }       —— 给最后一条同角色消息补结构元数据（msgId/toolEvents）
  'turn/start',                 // { msgId? }
  'step/start',                 // {}
  'tool/call',                  // { name, args?, callId }
  'tool/result',                // { callId, ok, content? }
  'step/end',                   // { reason? }
  'turn/end',                   // { reason }
  'session/forked',             // { sourceId, inheritedEventCount }
  'session/settings',           // { settings }         —— 会话级模型/工作区/权限/预设
  'request/header',             // { modelId, workspaceId, permission, preset, ... } —— 本轮请求信封
  'session/compaction',         // { beforeChars, afterChars, droppedCount, summaryChars } —— 压缩检查点
  'session/checkpoint',         // { kind, step?, at? } —— D1 检查点（模型请求前/恢复判断）
  'session/format',             // { version, from } —— format catalog 标记（只追加，不改历史）
  'session/working-dir',        // { path } —— 每轮工作目录（D1-10 投影）
  'tool/intent',                // { callId, name, sideEffect } —— 工具执行意图（与 tool/call 互补）
  'todo/write',                 // { data:{todos:[...]} } —— 待办投影（整表快照）
  'session/goal',               // { text, status } —— 本会话目标（DSH goals 的最小同构）
  'session/plan',               // { title, items:[{id,text,status}] } —— 本会话计划（DSH plan 的最小同构）
  'subagent/start',             // { childId, title, depth, parentSessionId }
  'subagent/end',               // { childId, status, ok, chars? }
  'deliverable/presented',      // { items:[{path,name,kind,bytes,title}], count } —— D2-03 交付事实
]);

/** 会进入模型历史的消息类事件 */
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message', 'system/message']);
/** 会遮蔽/清空此前消息的事件 */
const MASK_TYPES = new Set(['session/cleared']);

function emptyHash() { return '0'.repeat(16); }

/** FNV-1a 16 位：不是密码学哈希，只用来发现「尾行被截断/错位」，不用于安全。 */
function chainHash(prevHash, line) {
  let h = 0x811c9dc5;
  const s = String(prevHash || '') + line;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(-8) + h.toString(16).padStart(8, '0').slice(-8);
}

function nowTs() { return Date.now(); }

/**
 * 一个会话的事件日志。
 * @param {string} file  .events.jsonl 绝对路径
 */
class SessionLog {
  constructor(file) {
    if (!file) throw new Error('SessionLog 需要文件路径');
    this.file = file;
    this._events = null;   // 懒加载：第一次读时解析
  }

  exists() {
    try { return fs.existsSync(this.file); } catch (_) { return false; }
  }

  /** 读全部已提交事件。半截尾行会被丢弃，不抛错、不污染内存。 */
  events() {
    if (this._events) return this._events;
    const out = [];
    let raw = '';
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (_) { raw = ''; }
    const lines = raw.split('\n');
    let prevHash = emptyHash();
    let expectedSeq = 1;
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch (_) { break; }  // 半截尾行：截断，保留此前全部
      if (!ev || ev.seq !== expectedSeq || ev.prevHash !== prevHash) break; // 链断了：同样截断
      // 重算内容哈希：篡改 content/type 等字段会让它和存储值不等 → 从这里截断。
      // 只有「链连续」不够——prevHash 没变但内容被改，链看起来还是完整的（真会骗过只用 seq/prevHash 的读法）。
      const storedHash = ev.hash;
      const unsigned = Object.assign({}, ev);
      delete unsigned.hash;
      let recomputed;
      try { recomputed = chainHash(ev.prevHash, JSON.stringify(unsigned)); } catch (_) { break; }
      if (recomputed !== storedHash) break;
      out.push(ev);
      prevHash = ev.hash;
      expectedSeq += 1;
    }
    this._events = out;
    return out;
  }

  /** 重载（外部改了文件时显式调用；测试中重建 SessionLog 更常见）。 */
  reload() { this._events = null; return this.events(); }

  last() {
    const e = this.events();
    return e.length ? e[e.length - 1] : null;
  }

  /**
   * 追加一个事件。返回带 seq/hash/ts 的完整事件；调用方不该再改它。
   * @param {string} type EVENT_TYPES 之一
   * @param {object} [payload]
   */
  append(type, payload) {
    if (!EVENT_TYPES.includes(type)) throw new Error('未知事件类型：' + type);
    const list = this.events();
    const last = list.length ? list[list.length - 1] : null;
    const seq = (last && last.seq ? last.seq : 0) + 1;
    const prevHash = last && last.hash ? last.hash : emptyHash();
    const ev = Object.assign({ seq, type, ts: nowTs(), prevHash }, payload && typeof payload === 'object' ? payload : {});
    // hash 覆盖的是"除 hash 外"的稳定字段；payload 的键顺序由 Object.assign 决定，
    // 同一进程内稳定；跨进程续写只读已有行、按同样顺序 append，顺序一致。
    const line = JSON.stringify(ev);
    ev.hash = chainHash(prevHash, line);
    const outLine = JSON.stringify(ev) + '\n';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, outLine, 'utf8');
    } catch (e) {
      // 写失败不要让内存与磁盘分叉：丢弃缓存，下次读会从磁盘重新对齐
      this._events = null;
      throw e;
    }
    // 同步内存视图（不重读文件）
    list.push(ev);
    return ev;
  }

  /**
   * 投影出 OpenAI messages 格式。纯函数，不改日志、不改事件。
   *
   * 规则：
   *  · 只认 MESSAGE_TYPES；assistant/attempt 与 turn/* / step/* / tool/* 不进历史；
   *  · session/cleared 之前的所有消息被遮蔽；
   *  · meta 只在"不进模型历史"的字段里保留（如 via/status），由 opts.project 决定。
   */
  deriveMessages(opts) {
    const options = opts || {};
    const project = typeof options.project === 'function' ? options.project : defaultProject;
    let out = [];
    for (const ev of this.events()) {
      if (MASK_TYPES.has(ev.type)) { out = []; continue; }
      if (ev.type === 'message/patched') {
        // 结构元数据不是新消息：只补到最后一条同角色消息上。
        // 只改物化 JSON 而不写事件，重启后 _read 从日志投影就会把它丢掉（2026-11-23 实测）。
        const role = String(ev.role || '');
        for (let i = out.length - 1; i >= 0; i--) {
          if (out[i] && out[i].role === role) {
            if (ev.meta && typeof ev.meta === 'object') Object.assign(out[i], ev.meta);
            break;
          }
        }
        continue;
      }
      if (!MESSAGE_TYPES.has(ev.type)) continue;
      const role = ev.type.split('/')[0]; // user / assistant / system
      const msg = { role, content: String(ev.content == null ? '' : ev.content) };
      if (ev.ts) msg.ts = ev.ts;
      const extra = project(ev, msg);
      if (extra && typeof extra === 'object') Object.assign(msg, extra);
      out.push(msg);
    }
    return out;
  }

  /**
   * 会话级运行设置（模型/工作区/权限/预设）。
   *
   * 只读最后一个 `session/settings` 的快照，不逐条合并：每个事件都是
   * “我此刻的全量设置”，合并会让旧字段在新会话继承里悄悄复活。
   */
  settings() {
    let out = {};
    for (const ev of this.events()) {
      if (ev.type === 'session/settings' && ev.settings && typeof ev.settings === 'object') {
        out = Object.assign({}, ev.settings);
      }
    }
    return out;
  }

  /** 追加一条设置快照；调用方应传全量设置，不传就保持原样。 */
  appendSettings(settings) {
    return this.append('session/settings', { settings: Object.assign({}, settings || {}) });
  }

  /** 本轮真正下发的请求信封（诊断与回放用）。 */
  requestHeaders(limit) {
    const out = [];
    for (const ev of this.events()) {
      if (ev.type === 'request/header') out.push(ev);
    }
    return limit ? out.slice(-Number(limit)) : out;
  }

  /**
   * 当前标题（最后一次 session/title 或 session/created 生效）
   */
  title() {
    let t = '';
    for (const ev of this.events()) {
      if (ev.type === 'session/title' || ev.type === 'session/created') {
        t = String(ev.title || '');
      }
    }
    return t;
  }

  createdAt() {
    const first = this.events()[0];
    return first ? first.ts : 0;
  }

  updatedAt() {
    const last = this.events()[this.events().length - 1];
    return last ? last.ts : 0;
  }

  /**
   * 从既有 messages bootstrap 一份日志（迁移用，只做一次）。
   * 已存在日志时不覆盖——日志是真源，物化视图不能反向改写它。
   */
  bootstrap(messages, meta) {
    if (this.exists() && this.events().length) return false;
    const m = Array.isArray(messages) ? messages : [];
    this.append('session/created', { title: (meta && meta.title) || '新对话' });
    for (const msg of m) {
      const type = msg.role === 'assistant' ? 'assistant/message'
        : msg.role === 'system' ? 'system/message' : 'user/message';
      const payload = { content: String(msg.content || '') };
      if (msg.ts) payload.ts = msg.ts;
      if (msg.via) payload.meta = { via: msg.via };
      this.append(type, payload);
    }
    if (meta && meta.title && meta.title !== '新对话') this.append('session/title', { title: meta.title });
    return true;
  }

  /**
   * 崩溃恢复：给未闭合的 turn/step 补终态事件。
   * 与 DSH 的 interruptedTurnClosers 同构：补的是"这一轮其实被打断了"这个事实，
   * 不编造模型回答。
   */
  repairInterrupted(opts) {
    const reason = (opts && opts.reason) || 'interrupted';
    const es = this.events();
    let openTurn = null;
    let openStep = null;
    const pendingCalls = new Map();
    for (const ev of es) {
      if (ev.type === 'turn/start') { openTurn = ev; openStep = null; }
      else if (ev.type === 'step/start') { openStep = ev; }
      else if (ev.type === 'step/end') { openStep = null; }
      else if (ev.type === 'turn/end') { openTurn = null; openStep = null; }
      else if (ev.type === 'tool/call' && ev.callId) pendingCalls.set(ev.callId, ev);
      else if (ev.type === 'tool/intent' && ev.callId) pendingCalls.set(ev.callId, ev);
      else if (ev.type === 'tool/result' && ev.callId) pendingCalls.delete(ev.callId);
    }
    const added = [];
    for (const callId of pendingCalls.keys()) {
      added.push(this.append('tool/result', { callId, ok: false, content: '进程中断，工具结果缺失', meta: { synthetic: true } }));
    }
    if (openStep) added.push(this.append('step/end', { reason, meta: { synthetic: true } }));
    if (openTurn) added.push(this.append('turn/end', { reason, meta: { synthetic: true } }));
    return added;
  }

  /**
   * fork：复制前 inheritedEventCount 条事件到新日志，并写一条 session/forked 边界。
   * 共享前缀的哈希链因此完全一致（同样的事件、同样的顺序）。
   */
  fork(targetFile, inheritedEventCount, meta) {
    const es = this.events();
    const n = Number.isFinite(inheritedEventCount)
      ? Math.max(0, Math.min(es.length, Math.floor(inheritedEventCount)))
      : es.length;
    const target = new SessionLog(targetFile);
    if (target.exists() && target.events().length) throw new Error('fork 目标已有事件，拒绝覆盖');
    for (const ev of es.slice(0, n)) {
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.appendFileSync(targetFile, JSON.stringify(ev) + '\n', 'utf8');
    }
    target.reload();
    target.append('session/forked', {
      sourceId: (meta && meta.sourceId) || '',
      inheritedEventCount: n,
      title: (meta && meta.title) || '',
    });
    return target;
  }

  /** 追加一条检查点（模型请求前 / 恢复判断），调用方不要用它承载正文。 */
  checkpoint(kind, payload) {
    return this.append('session/checkpoint', Object.assign({
      kind: String(kind || 'checkpoint'),
      at: nowTs(),
    }, payload && typeof payload === 'object' ? payload : {}));
  }

  /** 工作目录变更才写事件；同一路径连续多轮不重复占日志。 */
  workingDir(dirPath) {
    const p = String(dirPath || '');
    if (!p) return null;
    const list = this.events();
    for (let i = list.length - 1; i >= 0; i--) {
      const ev = list[i];
      if (ev.type === 'session/working-dir' || ev.type === 'request/header') {
        const prev = String(ev.path || ev.workspacePath || '');
        if (prev === p) return null;
        break;
      }
    }
    return this.append('session/working-dir', { path: p });
  }
  /** 工具执行意图：在真正执行前落一条，崩溃后可与 tool/result 配对判断是否已执行。 */  toolIntent(callId, name, meta) {
    return this.append('tool/intent', Object.assign({
      callId: String(callId || ''),
      name: String(name || ''),
      sideEffect: meta && meta.sideEffect === true,
    }, meta && typeof meta === 'object' ? meta : {}));
  }

  /** 未闭合的工具意图/调用（没有对应 tool/result）。恢复器与诊断共用。 */
  pendingToolIntents() {
    const pending = new Map();
    for (const ev of this.events()) {
      if ((ev.type === 'tool/intent' || ev.type === 'tool/call') && ev.callId) {
        pending.set(ev.callId, ev);
      } else if (ev.type === 'tool/result' && ev.callId) {
        pending.delete(ev.callId);
      }
    }
    return Array.from(pending.values());
  }

  /** 轨迹（M2 用）：只取 turn/step/tool/attempt 事件，UI 画时间线。 */
  trace() {
    const TRACE = new Set(['turn/start', 'step/start', 'tool/call', 'tool/result',
      'step/end', 'turn/end', 'assistant/attempt', 'session/forked']);
    return this.events().filter((e) => TRACE.has(e.type));
  }
}

/** 默认投影：把非内容字段（via/status）作为元数据带出，不塞进 content。 */
function defaultProject(ev) {
  const meta = ev.meta && typeof ev.meta === 'object' ? ev.meta : null;
  if (!meta) return null;
  const out = {};
  for (const k of ['via', 'status', 'error', 'attachments', 'synthetic']) {
    if (meta[k] !== undefined) out[k] = meta[k];
  }
  return Object.keys(out).length ? out : null;
}

module.exports = {
  EVENT_TYPES, MESSAGE_TYPES, MASK_TYPES,
  chainHash, emptyHash,
  SessionLog,
};
