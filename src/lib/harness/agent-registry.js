'use strict';
/**
 * Agent registry（D2-14，2026-11-23）
 *
 * 以前“预设”只出现在两个地方：
 *   1. `ui-settings.PRESETS` 给设置页显示一段文案；
 *   2. `tool-policy.presetAllows()` 对 `minimal` 做一次工具白名单。
 * 也就是说 standard / ptc / cordis 实际只是同一个 Agent 换了描述。
 *
 * 这里把 Agent 变成一个**可注册的定义**：
 *   - 能力：模型角色、工作区策略、是否允许子智能体；
 *   - 工具集：`*` / 显式白名单 / 显式禁用；
 *   - initiator scope：同一个 Agent，用户发起、子智能体发起、定时任务发起
 *     看到的工具面不同。
 *
 * 约束：
 *   - **不改模型客户端**：`modelRole` 只是传给既有 `_pickBrainForRole` 的角色名。
 *   - **不替代权限**：工具是否可执行仍由 `tool-policy` 判；这里只决定“看不看得见”。
 *   - **未注册的 preset 不静默变 standard**：`resolve()` 明确返回
 *     `AGENT_NOT_FOUND`，调用方可以回退，但必须自己决定回退。
 */

const policy = require('./tool-policy');

/** initiator 的三种来源。 */
const INITIATORS = ['user', 'subagent', 'cron'];

/**
 * 内置 Agent 定义。
 * `tools: '*'` 表示交给 tool-policy 的权限/预设规则继续裁剪；
 * 显式数组用于“这个 Agent 天生只用这些工具”的语义。
 */
const BUILTIN = {
  standard: {
    id: 'standard', name: '标准模式', order: 1, modelRole: 'brain',
    workspace: 'inherit', tools: '*', description: '处理代码、文件和资料的通用 Agent',
  },
  ptc: {
    id: 'ptc', name: 'PTC 模式', order: 2, modelRole: 'brain',
    workspace: 'inherit', tools: '*', description: '先收集工具结果再统一计算；执行器未接入',
  },
  minimal: {
    id: 'minimal', name: '极简模式', order: 3, modelRole: 'brain',
    workspace: 'inherit',
    tools: ['fs_list', 'fs_read', 'shell_exec', 'skill_list', 'skill_read',
      'workspace_info', 'todo_write', 'ask_user_question'],
    description: '只给最小工具面，用于测试和对照',
  },
  cordis: {
    id: 'cordis', name: '创造模式', order: 4, modelRole: 'brain',
    workspace: 'inherit', tools: '*', description: '描述插件需求；动态插件运行时未接入',
  },
};

/** initiator 对工具面的硬裁剪。这些不是权限判断，是“没有通道就不该看见”。 */
const INITIATOR_DENY = {
  user: new Set(),
  // 子智能体不能再套娃；也没有独立审批通道，提问工具一律不可见。
  subagent: new Set(['spawn_subagent', 'ask_user_question']),
  // 定时任务没有交互通道，也不应该静默改用户工作区。
  cron: new Set(['spawn_subagent', 'ask_user_question']),
};

const _defs = new Map();

function isKnownInitiator(v) {
  return INITIATORS.includes(v);
}

function normalizeTools(tools) {
  if (tools === '*') return '*';
  if (!Array.isArray(tools)) return [];
  return tools.map((x) => String(x)).filter(Boolean);
}

function register(def) {
  const d = def || {};
  const id = String(d.id || '').trim();
  if (!id) throw Object.assign(new Error('Agent 定义缺少 id'), { code: 'AGENT_ID_REQUIRED' });
  const normalized = {
    id,
    name: String(d.name || id),
    order: Number(d.order) || 99,
    description: String(d.description || ''),
    modelRole: String(d.modelRole || 'brain'),
    workspace: String(d.workspace || 'inherit'),
    tools: normalizeTools(d.tools === undefined ? '*' : d.tools),
    builtin: !!d.builtin,
    // 能力位：留给 D4/D7 接 Office/插件运行时。现在只是声明，不假装已执行。
    capabilities: Array.isArray(d.capabilities) ? d.capabilities.slice() : [],
  };
  _defs.set(id, normalized);
  return normalized;
}

function get(id) {
  return _defs.get(String(id || '')) || null;
}

function list() {
  return Array.from(_defs.values()).sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
}

function unregister(id) {
  return _defs.delete(String(id || ''));
}

function reset() {
  _defs.clear();
  for (const d of Object.values(BUILTIN)) register(Object.assign({ builtin: true }, d));
}

/**
 * 解析本轮真正的 Agent scope。
 * @param {object} ctx { preset, initiator, permission, workspace, interactive, subagentDepth, maxSubagentDepth }
 * @returns {{ok:boolean, code?:string, agent?:object, scope?:object}}
 */
function resolve(ctx) {
  const c = ctx || {};
  const preset = String(c.preset || 'standard');
  const agent = get(preset);
  if (!agent) return { ok: false, code: 'AGENT_NOT_FOUND', preset };
  const initiator = isKnownInitiator(c.initiator) ? c.initiator : 'user';
  const depth = Number(c.subagentDepth || 0);
  const maxDepth = Number(c.maxSubagentDepth == null ? 2 : c.maxSubagentDepth);
  const interactive = c.interactive === undefined ? initiator === 'user' : !!c.interactive;
  const deny = INITIATOR_DENY[initiator] || new Set();
  const scope = {
    agentId: agent.id,
    preset: agent.id,
    initiator,
    modelRole: agent.modelRole,
    workspace: agent.workspace,
    permission: policy.normalizePermission(c.permission, 'workspace-write'),
    interactive,
    // 子智能体达到深度上限时，“还能不能再派”必须在这里就判死；
    // 只靠 tool-policy 的 maxSubagentDepth 会让模型先看见再被拒。
    canSpawn: !deny.has('spawn_subagent') && depth < maxDepth,
    canAsk: !deny.has('ask_user_question') && interactive,
    deny: Array.from(deny),
    tools: agent.tools,
  };
  return { ok: true, agent, scope, allowsTool: (name) => allowsTool(agent, scope, name) };
}

function allowsTool(agent, scope, name) {
  const n = String(name || '');
  if (!n) return false;
  if (scope && scope.deny && scope.deny.includes(n)) return false;
  if (n === 'spawn_subagent' && scope && !scope.canSpawn) return false;
  if (n === 'ask_user_question' && scope && !scope.canAsk) return false;
  if (agent && agent.tools !== '*' && Array.isArray(agent.tools) && !agent.tools.includes(n)) return false;
  return policy.presetAllows(agent.id, n);
}

function snapshot() {
  return list();
}

reset();

module.exports = {
  INITIATORS, BUILTIN, INITIATOR_DENY,
  register, get, list, unregister, reset, resolve, allowsTool, snapshot,
};
