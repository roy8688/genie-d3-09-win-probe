'use strict';
/**
 * Agent Loop 内核（S2，对标 DeepSeek Harness `core/agent-loop`）
 *
 * 真正的 turn → step* → tool* 循环：模型不是"被调用一次出文本"，
 * 而是可以输出 tool_calls；执行工具后把结果以 role:'tool' 回喂模型，
 * 模型再基于结果继续，直到给出纯文本终态或步数耗尽。
 *
 * 这是 agent loop 与旧 relay 的根本区别：旧路径"规则选工具 → 模板描述结果"，
 * 工具结果从不回流模型。这里反过来：**模型决定调什么、结果喂回模型**。
 *
 * 设计约束：
 *  · 纯逻辑、零 require relay —— 用注入的 model / executeTool，独立可测；
 *  · model 返回结构与 cloud-llm.chat 一致：{ok, content, toolCalls:[{id, type, function:{name,arguments}}]}；
 *  · 不碰真实网络、不碰会话存储，调用方负责把 messages 落盘；
 *  · trace 可选：传入 TurnTrace.start() 的句柄则写 step/tool 结构事件。
 */

/**
 * 可并发白名单：只放"不写共享状态"的调用。
 *
 * 为什么不按 risk === 'read' 判断：`session_query` 带只读风险，但它会 sync 索引、
 * 写 SQLite；`present_files` 只读文件，但会写交付登记册。按 risk 判会把这些
 * 放进并发池，制造"看日志说只读、实际两份写"的隐性竞态。白名单显式列最稳。
 */
const READ_ONLY_TOOL = /^(fs_read|fs_list|grep|glob|web_search|web_fetch|skill_list|skill_read|read_image|workspace_info|get_document_info|list_pages|scan_nodes|audit_layout|audit_spacing|check_naming|job_list|job_output|job_wait|schedule_list|lsp)$/;

function isReadOnlyTool(name) {
  return READ_ONLY_TOOL.test(String(name || ''));
}

/** 把模型返回的 tool_calls 解析成 {id,name,args}；arguments 可能是 JSON 字符串或对象。 */
function normalizeCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((tc, i) => {
    const name = (tc.function && tc.function.name) || tc.name || '';
    let args = (tc.function && tc.function.arguments) != null ? tc.function.arguments : (tc.args != null ? tc.args : {});
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { args = { _raw: args.slice(0, 2000) }; }
    }
    if (!args || typeof args !== 'object') args = {};
    return { id: String(tc.id || ('call_' + i)), name: String(name), args };
  });
}

/** 构造一次模型请求的消息数组（深拷贝，避免污染调用方）。 */
function buildMessages(messages, toolMsgList) {
  const out = (Array.isArray(messages) ? messages : []).map((m) => ({ ...m }));
  for (const tm of (toolMsgList || [])) out.push({ ...tm });
  return out;
}

/**
 * 跑一轮 agent loop。
 *
 * @param {object} deps
 * @param {function} deps.model        async ({messages, step}) => {ok, content, toolCalls, error?}
 * @param {function} deps.executeTool  async ({id, name, args, step}) => {ok, content|error}
 * @param {Array}    deps.messages     初始消息（含 system/user）
 * @param {Array}    deps.tools        传给模型的工具定义（OpenAI function 格式）
 * @param {number}   [deps.maxSteps=6] 最多几轮模型请求（防死循环）
 * @param {number}   [deps.maxParallel=3] 同一轮里只读工具的最大并发数（写类仍串行）
 * @param {object}   [deps.signal]     AbortSignal，取消时抛错
 * @param {object}   [deps.trace]      TurnTrace 句柄（可选，写 step/tool 事件）
 * @param {function} [deps.onStep]     ({step, kind, ...}) => void 观测回调
 * @param {object}   [deps.hooks]      S6 策略注入（内核保持纯逻辑，策略全在外面组装）：
 *   · hooks.beforeTool({step,name,args}) => {ok, error?, code?}   执行前守卫（先读后写等）
 *   · hooks.afterTool({step,name,args,ok,content}) => string|null   执行后观测（重复调用提醒）
 *   · hooks.augmentMessages(msgs, {step}) => msgs                构造请求时改造（裁剪/时间注入）
 * @returns {Promise<{ok, content, steps, toolRounds, aborted?, error?, messages}>}
 */
async function run(deps) {
  const o = deps || {};
  const model = o.model;
  const executeTool = o.executeTool;
  if (typeof model !== 'function') throw new Error('agent-loop.run 需要 model 函数');
  if (typeof executeTool !== 'function') throw new Error('agent-loop.run 需要 executeTool 函数');

  const maxSteps = Math.max(1, Math.min(20, Number(o.maxSteps) || 6));
  const tools = Array.isArray(o.tools) ? o.tools : [];
  const hooks = o.hooks && typeof o.hooks === 'object' ? o.hooks : {};
  const toolMsgs = [];       // 本轮累积的 role:tool 结果，逐轮回喂
  const assistantCalls = []; // 每轮的 assistant tool_calls 消息（回喂时配对 tool_call_id）
  let finalText = '';
  let steps = 0;
  let toolRounds = 0;

  const aborted = () => !!(o.signal && o.signal.aborted);
  const checkAbort = () => {
    if (aborted()) { const e = new Error('agent loop aborted'); e.name = 'AbortError'; throw e; }
  };

  try {
    for (let i = 1; i <= maxSteps; i++) {
      checkAbort();
      steps = i;
      if (o.trace && typeof o.trace.nextStep === 'function') o.trace.nextStep();

      // 构造本次请求的消息：基础历史 + 已累积的工具结果 → 交给策略层改造（裁剪/时间注入）
      let msgs = buildMessages(o.messages, toolMsgs);
      if (typeof hooks.augmentMessages === 'function') {
        try { msgs = hooks.augmentMessages(msgs, { step: i }) || msgs; }
        catch { /* 策略层异常绝不拖垮主循环：退回未改造的消息 */ }
      }
      if (o.onStep) o.onStep({ step: i, kind: 'model-request', messages: msgs.length });

      const res = await model({ messages: msgs, step: i, tools });
      checkAbort();

      if (!res || !res.ok) {
        return { ok: false, content: '', steps, toolRounds, error: (res && res.error) || 'model failed',
          messages: msgs };
      }

      const calls = normalizeCalls(res.toolCalls);
      const text = typeof res.content === 'string' ? res.content : '';

      // 没有工具调用 → 文本终态，循环结束。
      if (!calls.length) {
        finalText = text;
        if (o.onStep) o.onStep({ step: i, kind: 'final', content: text });
        return { ok: true, content: text, steps, toolRounds, messages: msgs };
      }

      // 有工具调用：把 assistant 的 tool_calls 加进历史（ OpenAI 要求 tool 消息紧跟其后）
      assistantCalls.push({
        role: 'assistant',
        content: text || '',
        tool_calls: calls.map((c) => ({
          id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      });
      toolMsgs.push(assistantCalls[assistantCalls.length - 1]);

      // 工具执行：**默认有界并发**，但只并发"互不写同一份状态"的读类工具。
      //
      // 官方 Harness 的并发不是为了快，而是为了不让"查文件 A"等"查文件 B"：
      // 三个只读调用串行，用户看到的是 3 倍延迟。但把写类也并发会制造
      // "两个 fs_write 同时通过先读后写守卫"这种竞态——所以并发范围收窄到白名单，
      // 其余仍按模型给出的顺序串行。结果**永远按调用顺序回喂**，tool_call_id 配对不变。
      const maxParallel = Math.max(1, Math.min(6, Number(o.maxParallel || 3)));
      const canParallel = calls.length > 1 && maxParallel > 1 && calls.every((c) => isReadOnlyTool(c.name));
      const reminders = [];
      const slots = new Array(calls.length);

      const prepare = (c, idx) => {
        // 执行前守卫（先读后写等）：拒绝的调用不真正执行，但结果照样回喂模型。
        // 守卫**串行执行**：它可能改状态（例如标记"这次 fs_write 已读过"），并发调它等于自己制造竞态。
        let gateDenied = null;
        if (typeof hooks.beforeTool === 'function') {
          try {
            const verdict = hooks.beforeTool({ step: i, name: c.name, args: c.args });
            if (verdict && verdict.ok === false) gateDenied = verdict;
          } catch { /* 守卫异常不阻止执行，按放行处理 */ }
        }
        let traceId = '';
        if (o.trace && typeof o.trace.noteTool === 'function') {
          traceId = o.trace.noteTool(c.name, c.args);
        }
        return { c, idx, gateDenied, traceId };
      };

      const finish = (slot, out) => {
        const { c, idx, traceId } = slot;
        const ok = !!(out && out.ok !== false);
        // 失败时优先回喂工具自己给的说明（例如参数校验不通过的细节），
        // 没有说明才退化成通用错误——否则模型只看到"未知错误"，无法自我纠正。
        const content = ok
          ? (out && out.content != null ? String(out.content) : '')
          : (out && out.content
            ? String(out.content)
            : ('工具执行失败：' + ((out && out.error) || '未知错误') + ((out && out.code) ? '（' + out.code + '）' : '')));
        if (traceId && typeof o.trace.toolResult === 'function') o.trace.toolResult(traceId, ok, content, out && out.meta);
        const toolMsg = { role: 'tool', tool_call_id: c.id, content };
        if (out && Array.isArray(out.images) && out.images.length) {
          toolMsg.images = out.images.map((x) => (typeof x === 'string' ? x : x && x.data)).filter(Boolean);
          if (out.contentBlocks) toolMsg.contentBlocks = out.contentBlocks;
        }
        slots[idx] = toolMsg;
        if (typeof hooks.afterTool === 'function') {
          try {
            const r = hooks.afterTool({ step: i, name: c.name, args: c.args, ok, content });
            if (r) reminders.push({ idx, text: String(r) });
          } catch { /* 观测异常不影响执行 */ }
        }
        if (o.onStep) o.onStep({ step: i, kind: 'tool', name: c.name, ok });
      };

      const execOne = async (slot) => {
        if (slot.gateDenied) return { ok: false, error: slot.gateDenied.message || slot.gateDenied.error || '调用被策略拒绝', code: slot.gateDenied.code };
        try {
          return await executeTool({ id: slot.c.id, name: slot.c.name, args: slot.c.args, step: i });
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      };

      const prepared = calls.map((c, idx) => prepare(c, idx));
      if (canParallel) {
        // 小滚动池：同时最多 maxParallel 个，完成一个补一个；返回顺序由 slots 下标决定。
        let cursor = 0;
        const worker = async () => {
          while (cursor < prepared.length) {
            checkAbort();
            const slot = prepared[cursor++];
            const out = await execOne(slot);
            finish(slot, out);
          }
        };
        await Promise.all(Array.from({ length: Math.min(maxParallel, prepared.length) }, () => worker()));
      } else {
        for (const slot of prepared) {
          checkAbort();
          const out = await execOne(slot);
          finish(slot, out);
        }
      }

      for (const m of slots) if (m) toolMsgs.push(m);
      // 提醒以 user 消息形态追加在所有 tool 结果之后（合法且不破坏配对）
      for (const r of reminders.sort((a, b) => a.idx - b.idx)) toolMsgs.push({ role: 'user', content: '【系统提醒】' + r.text });
      toolRounds += 1;
    }

    // 步数耗尽：把最后一轮的文本作为结果（可能为空），如实报告 steps。
    return { ok: true, content: finalText, steps, toolRounds, exhausted: true,
      messages: buildMessages(o.messages, toolMsgs) };
  } catch (e) {
    const isAbort = e && e.name === 'AbortError' || /abort/i.test(String((e && e.message) || ''));
    return { ok: false, content: finalText, steps, toolRounds,
      aborted: isAbort, error: String((e && e.message) || e), messages: buildMessages(o.messages, toolMsgs) };
  }
}

module.exports = { run, normalizeCalls, buildMessages, isReadOnlyTool };
