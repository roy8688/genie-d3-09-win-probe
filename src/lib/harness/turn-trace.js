'use strict';
/**
 * TurnTrace —— turn/step 执行轨迹（Harness M2，docs/57）
 *
 * 对标 DSH core/agent-loop 的 turn → step* 语义：
 *   turn = 一次用户消息到最终回复；step = 一次模型请求 + 它的工具调用。
 *
 * 设计取舍（重要，改之前先读）：
 * 1. **只包裹，不改业务分支。** relay 的 _handleUserMessageInner 有二十多条 return，
 *    逐条埋 turn/end 是给自己埋雷（TurnClock 已经踩过这个坑并给出正解）。
 *    本模块只提供 wrap(send) 观测 + finish() 兜底，由 handleUserMessage 外层调用。
 * 2. **只记结构，不记内容。** user/message 与 assistant/message 由 M1 的
 *    Conversation.add 写进同一日志；这里只写 turn/* / step/* / tool/* /
 *    assistant/attempt，它们不进 deriveMessages 投影，绝不重复污染模型历史。
 * 3. **真实闭合，不编造回答。** 中断/失败走 assistant/attempt（reason=aborted/
 *    error），绝不用「假装说完了」的方式构造 assistant/message。
 * 4. **并发安全。** 单用户 App 也可能 WS 并发来消息。用 AsyncLocalStorage 绑定
 *    当前 turn，_dispatchToPlugin 直接 current() 取，不层层传参；每次 append
 *    都新建 SessionLog 读最新文件，避免长持有实例缓存导致 seq/hash 链断裂
 *    （同一进程内同步 fs 读写，无 await 交错，read→append 原子）。
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const { SessionLog } = require('./session-log');

const store = new AsyncLocalStorage();

/** 占位气泡不当「首字」，与 turn-clock.js 保持同一判据。 */
const PLACEHOLDER = /^(思考中|生成中|正在|稍等|正在思考|快速作答)/;

/** 取当前异步上下文里的 turn trace；不在 turn 内返回 null。 */
function current() {
  return store.getStore() || null;
}

/**
 * 工具行的一行摘要（DSH ui-tool ToolRow 的 summary）。
 *
 * 轨迹只存结构，不存全文：这里从参数里取**一个**最像"用户看懂发生了什么"的字段，
 * 截断到 160 字。取不到就退回第一个标量值。绝不 JSON 整包塞进日志。
 */
function toolSummary(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  const pick = (keys) => {
    for (const k of keys) {
      const v = a[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  const byName = {
    shell_exec: ['command', 'cmd', 'script'],
    bash: ['command', 'cmd'],
    fs_read: ['path', 'file', 'target'],
    fs_write: ['path', 'file', 'target'],
    fs_list: ['path', 'dir', 'root'],
    web_search: ['query', 'q'],
    web_fetch: ['url'],
    skill_read: ['name', 'skill'],
    spawn_subagent: ['title', 'task', 'prompt'],
    todo_write: ['title', 'task'],
    ask_user_question: ['question', 'title'],
  };
  let s = pick(byName[String(name || '')] || []);
  if (!s) {
    for (const k of Object.keys(a)) {
      const v = a[k];
      if (typeof v === 'string' && v.trim()) { s = v.trim(); break; }
      if (typeof v === 'number' || typeof v === 'boolean') { s = String(v); break; }
    }
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
}

/**
 * 工具是否有副作用：只用于检查点标记，不参与权限判定（权限仍走 tool-policy）。
 * 读类工具即使标错也不改行为；这里宁可多标 write，恢复时更保守。
 */
function isSideEffectTool(name) {
  const n = String(name || '');
  if (!n) return false;
  if (/^(read_|fs_read|fs_list|list_|get_|grep|glob|web_search|web_fetch|search_|skill_read|skill_list|read_image|ask_user_question|todo_write)/i.test(n)) return false;
  return true;
}

/**
 * 创建一条 turn 轨迹，并立即写 turn/start。
 *
 * @param {object} deps
 * @param {string} deps.file       事件日志路径（调用方固定 sessionId 后给出）
 * @param {string} [deps.msgId]    气泡去重 id，轨迹按它对齐
 * @param {string} [deps.sessionId] 会话 id（防串台：入口固定后不再变）
 * @param {string} [deps.text]     用户原话（仅记长度，不记全文，避免日志膨胀）
 */
function start(deps) {
  const o = deps || {};
  const file = String(o.file || '');
  if (!file) throw new Error('TurnTrace.start 需要日志文件路径');

  const t0 = Date.now();
  const state = {
    msgId: String(o.msgId || ''),
    sessionId: String(o.sessionId || ''),
    textChars: typeof o.text === 'string' ? o.text.length : 0,
    turnOpen: false,
    stepOpen: false,
    step: 0,
    tools: 0,
    reason: 'incomplete',
    finished: false,
    usage: { prompt: 0, completion: 0, total: 0, cacheHit: 0, calls: 0 },
  };

  // 每次新建 SessionLog：长持有实例的 _events 会陈旧（M1 的 add 用另一个实例
  // 追加 user/assistant 消息），续写旧实例会算错 seq/prevHash → 哈希链断裂。
  function emit(type, payload) {
    try { return new SessionLog(file).append(type, payload); } catch (_) { return null; }
  }

  state.turnOpen = true;
  emit('turn/start', { msgId: state.msgId, sessionId: state.sessionId, textChars: state.textChars });

  /** 惰性开 step：第一个真实文本 / 第一次工具调用才算一步，占位气泡不算。 */
  function beginStep() {
    if (state.stepOpen || !state.turnOpen || state.finished) return;
    state.step += 1;
    state.stepOpen = true;
    emit('step/start', { step: state.step, msgId: state.msgId });
  }

  /** S2（agent loop）：多步循环——闭合当前 step 并开下一个。惰性：没开过就不强开。 */
  function nextStep() {
    if (!state.turnOpen || state.finished) return state.step;
    if (state.stepOpen) {
      emit('step/end', { step: state.step, reason: 'continue' });
      state.stepOpen = false;
    }
    beginStep();
    return state.step;
  }

  function noteTool(name, args) {
    beginStep();
    state.tools += 1;
    const callId = 't' + state.step + '-' + state.tools;
    const argBytes = (() => { try { return JSON.stringify(args || {}).length; } catch (_) { return 0; } })();
    emit('tool/call', {
      callId,
      name: String(name || 'unknown'),
      // args 可能含大段画布数据：键名 + 体积 + 一行摘要，不塞全文。
      args: args && typeof args === 'object'
        ? { keys: Object.keys(args).slice(0, 20), bytes: argBytes, summary: toolSummary(name, args) }
        : {},
      // groupTurns 只放行白名单字段；参数键名必须单独列一份，
      // 否则详情卡永远显示「键（无）」（2026-11-23 真机截图抓到）。
      argKeys: args && typeof args === 'object' ? Object.keys(args).slice(0, 20) : [],
      summary: toolSummary(name, args),
    });
    // D1-04：tool/call 是“模型要调它”，tool/intent 是“执行器即将真跑”。
    // 只记结构元数据；崩溃后与 tool/result 配对判断是否已执行。
    emit('tool/intent', {
      callId,
      name: String(name || 'unknown'),
      sideEffect: isSideEffectTool(name),
    });
    return callId;
  }

  /**
   * 记一次模型调用的真实 usage（2026-11-22 对齐 DSH 底部统计）。
   * 只有 provider 回了 usage 才记；没有就不记，绝不用字数估算冒充 token。
   * cacheHit 兼容三种字段：DeepSeek prompt_cache_hit_tokens、OpenAI
   * cached_tokens、prompt_tokens_details.cached_tokens。
   */
  function noteUsage(u) {
    if (!u || typeof u !== 'object') return;
    const prompt = Number(u.prompt_tokens || 0) || 0;
    const completion = Number(u.completion_tokens || 0) || 0;
    const total = Number(u.total_tokens || 0) || (prompt + completion);
    const cache = Number(u.prompt_cache_hit_tokens || 0) || Number(u.cached_tokens || 0)
      || Number((u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0) || 0;
    if (!prompt && !completion && !total) return;
    state.usage.prompt += prompt;
    state.usage.completion += completion;
    state.usage.total += total;
    state.usage.cacheHit += cache;
    state.usage.calls += 1;
  }

  /**
   * @param {string} callId
   * @param {boolean} ok
   * @param {string} [text] 失败=错误说明；成功=工具正文（只留 1600 字预览）
   */
  function toolResult(callId, ok, text, meta) {
    const body = String(text == null ? '' : text);
    let safeMeta = null;
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      try {
        const s = JSON.stringify(meta);
        // 事件日志是 append-only 真源，不能因为一张卡片把它撑大。超过 4KB 的
        // meta 直接丢弃结构（正文预览仍在），宁可不画卡，也不让日志变成附件仓库。
        if (s.length <= 4000) safeMeta = JSON.parse(s);
      } catch (_) { safeMeta = null; }
    }
    emit('tool/result', {
      callId: String(callId || ''),
      ok: !!ok,
      // 详情卡只展示"看过什么"，不承担二次取证：超长正文截断，不落全文。
      preview: body.slice(0, 1600),
      truncated: body.length > 1600,
      bytes: body.length,
      content: ok ? '' : body.slice(0, 500),
      meta: safeMeta || undefined,
    });
  }

  /** 包 send：观测用户可见事件，判定 turn 的终态 reason。异常绝不影响发消息。 */
  function wrap(send) {
    if (typeof send !== 'function') return send;
    return function tracedSend(ev) {
      try {
        if (ev && (ev.type === 'chat_msg' || ev.type === 'chat_update')) {
          const t = typeof ev.text === 'string' ? ev.text : '';
          if (t && !PLACEHOLDER.test(t)) beginStep();
          const st = ev.status;
          if (st === 'done') {
            state.reason = 'complete';
          } else if ((st === 'stopped' || st === 'aborted') && state.reason === 'incomplete') {
            state.reason = 'aborted';
            emit('assistant/attempt', { reason: 'aborted', content: t.slice(0, 200) });
          } else if (st === 'error' && state.reason === 'incomplete') {
            state.reason = 'error';
            emit('assistant/attempt', { reason: 'error', content: t.slice(0, 200) });
          }
        }
      } catch (_) { /* 观测失败绝不影响主链路 */ }
      return send(ev);
    };
  }

  /** finally 兜底闭合：无论走哪条 return，turn/step 一定有终态。幂等。 */
  function finish() {
    if (state.finished) return Object.assign({}, state);
    state.finished = true;
    if (state.stepOpen) {
      emit('step/end', { step: state.step, reason: state.reason });
      state.stepOpen = false;
    }
    if (state.turnOpen) {
      const wallSec = Math.max(0.001, (Date.now() - t0) / 1000);
      emit('turn/end', {
        reason: state.reason,
        msgId: state.msgId,
        totalMs: Date.now() - t0,
        tools: state.tools,
        // 只有真的拿到 usage 才写：前端据此判断“这一轮有没有 token 账”，
        // 缺字段显示“—”，不许拿字符数倒推成 token。
        usage: state.usage.calls ? Object.assign({}, state.usage, {
          tokPerSec: +(state.usage.completion / wallSec).toFixed(1),
        }) : null,
      });
      state.turnOpen = false;
    }
    return Object.assign({}, state);
  }

  return { state, wrap, beginStep, nextStep, noteTool, toolResult, noteUsage, finish };
}

/** 在 trace 上下文里执行 fn（AsyncLocalStorage 会沿 Promise 链传播）。 */
function run(trace, fn) {
  return store.run(trace, fn);
}

/**
 * 把事件按 turn 分组（轨迹查询 API 与测试共用，纯函数）。
 * @param {Array} events SessionLog.events() 或 trace() 的结果
 * @returns {Array<{msgId,ts,reason,totalMs,events}>}
 */
function groupTurns(events) {
  const out = [];
  let cur = null;
  for (const e of Array.isArray(events) ? events : []) {
    if (e.type === 'turn/start') {
      cur = { seq: e.seq, msgId: e.msgId || '', ts: e.ts, reason: 'incomplete', totalMs: null, events: [] };
      out.push(cur);
    }
    if (!cur) continue;
    cur.events.push({
      seq: e.seq, type: e.type, ts: e.ts,
      // 内容事件给摘要，结构事件只给关键字段，避免把整段回答塞进轨迹 API。
      content: typeof e.content === 'string' ? e.content.slice(0, 300) : undefined,
      reason: e.reason, step: e.step, name: e.name, callId: e.callId,
      ok: e.ok,
      // ui-tool：一行摘要 + 结果预览。只带这三个字段，不放开 args/content 原文。
      summary: typeof e.summary === 'string' ? e.summary.slice(0, 200) : undefined,
      argKeys: Array.isArray(e.argKeys) ? e.argKeys.map((x) => String(x)).slice(0, 20) : undefined,
      preview: typeof e.preview === 'string' ? e.preview.slice(0, 1600) : undefined,
      bytes: Number.isFinite(Number(e.bytes)) ? Number(e.bytes) : undefined,
      truncated: e.truncated === true || undefined,
    });
    if (e.type === 'turn/end') {
      cur.reason = e.reason || 'incomplete';
      cur.totalMs = e.totalMs == null ? null : e.totalMs;
      cur = null;
    }
  }
  return out;
}

module.exports = { start, run, current, groupTurns, toolSummary, PLACEHOLDER };
