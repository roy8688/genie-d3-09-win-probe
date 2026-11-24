'use strict';
/**
 * 待办状态（对标 DeepSeek Harness `todo/tool-todo`）
 *
 * 模型面对"把 HMI 首页还原成设计稿"这种多步任务时，需要一个**自己维护的进度清单**，
 * 否则跑到第 5 步就忘了前 4 步做到哪。Harness 的做法：
 *  · 模型调 `todo_write` 提交**完整清单**（整表替换，不是增量补丁）；
 *  · 每次提交落一个 `todo/write` 快照到会话，UI 从事件渲染；
 *  · 新回合开始时清单清空（turn/start），回合结束保留（让用户看到最终状态）。
 *
 * 校验是 fail-loud 的（Harness 同款）：内容去空白后非空、不重复、
 * 除非部署声明允许并行，否则最多一个 in_progress。
 *
 * 与 Harness 的差异：Harness 把 todo 注册成 session projection（可回放）；
 * Genie 的会话日志是 append-only 事件流，这里同样以事件为真源，投影函数是纯函数，
 * 可在渲染时从事件重算——语义等价，没有引入第二份真源。
 */

const STATUSES = ['pending', 'in_progress', 'completed'];

/** 参数校验错误（与工具参数错误同类，回喂模型让它自己改）。 */
class TodoArgsError extends Error {
  constructor(errors) {
    const list = Array.isArray(errors) ? errors : [String(errors)];
    super(list.join('; '));
    this.name = 'TodoArgsError';
    this.errors = list;
  }
}

/**
 * 把模型提交的原始清单规范化 + 校验。
 * @param {Array} raw [{content, status}]
 * @param {boolean} allowParallel 是否允许多个 in_progress 并存
 * @returns {Array<{content:string,status:string}>}
 * @throws {TodoArgsError}
 */
function toTodoList(raw, allowParallel) {
  if (!Array.isArray(raw)) throw new TodoArgsError('todos 必须是数组');
  const todos = [];
  const seen = new Set();
  let active = 0;
  const errors = [];
  raw.forEach((item, i) => {
    const content = String((item && item.content) != null ? item.content : '').trim();
    const status = String((item && item.status) || '');
    if (!content) { errors.push('todos[' + i + '].content 不能为空'); return; }
    if (seen.has(content)) { errors.push('todos[' + i + '].content 与前面的项重复：' + JSON.stringify(content)); return; }
    if (!STATUSES.includes(status)) { errors.push('todos[' + i + '].status 必须是 pending / in_progress / completed，收到 ' + JSON.stringify(status)); return; }
    seen.add(content);
    if (status === 'in_progress') active += 1;
    todos.push({ content: content, status: status });
  });
  if (errors.length) throw new TodoArgsError(errors);
  if (!allowParallel && active > 1) {
    throw new TodoArgsError('最多只能有一项处于 in_progress（收到 ' + active + ' 项）');
  }
  return todos;
}

/** 统计各状态数量。 */
function counts(todos) {
  const c = { pending: 0, inProgress: 0, completed: 0 };
  for (const t of (todos || [])) {
    if (t.status === 'pending') c.pending += 1;
    else if (t.status === 'in_progress') c.inProgress += 1;
    else if (t.status === 'completed') c.completed += 1;
  }
  return c;
}

/**
 * 会话投影（纯函数）：给定当前状态与一条事件，返回新状态。
 * 事件形状：{type:'turn/start'} | {type:'todo/write', data:{todos}}
 * @returns {Array|null}
 */
function project(state, event) {
  const e = event || {};
  if (e.type === 'todo/write') {
    const list = (e.data && e.data.todos) || [];
    return list.map((t) => ({ content: t.content, status: t.status }));
  }
  if (e.type === 'turn/start') return null;
  return state === undefined ? null : state;
}

/** 从整段事件流重算最新待办清单。 */
function projectAll(events) {
  let state = null;
  for (const e of (events || [])) state = project(state, e);
  return state;
}

/** 渲染一句给模型看的确认文案（Harness 同款口吻）。 */
function renderSummary(todos) {
  const c = counts(todos);
  return '待办已更新：' + c.pending + ' 项待做、' + c.inProgress + ' 项进行中、' + c.completed + ' 项已完成。';
}

module.exports = {
  STATUSES, TodoArgsError,
  toTodoList, counts, project, projectAll, renderSummary,
};
