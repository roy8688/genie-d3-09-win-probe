'use strict';
/**
 * 工具注册表（P0-2，2026-11-21）
 *
 * 官方 core/tools 的核心不是“一张工具表”，而是：
 *   registry → scope（这个 Agent 能看见什么）→ guarded pipeline（能不能执行）→ executor。
 *
 * 这里补 registry + scope；guarded pipeline 在 tool-pipeline 里已有，只是此前没接主链。
 * 本模块只负责“有哪些工具、当前作用域看得见哪些、调用落到哪个执行适配器”，
 * 不负责权限审批（那是 tool-policy 的事），避免把“看见”和“允许”又混成一处。
 */

const AgentTools = require('./agent-tools');
const policy = require('./tool-policy');
const AgentRegistry = require('./agent-registry');

function hydrate(name, spec, ctx) {
  const all = AgentTools.ALL_SPECS[name] || spec || {};
  const risk = all.risk || AgentTools.riskOf(name);
  const scope = all.scope || (all.local ? 'local' : (String(name).startsWith('fs_') ? 'workspace' : 'figma'));
  return Object.assign({}, all, {
    name, risk, scope,
    description: all.description || '',
    parameters: all.parameters || { type: 'object', properties: {} },
    // D2-12：交互口径在装配时算一次，UI/审批/执行共用同一格矩阵。
    interaction: policy.interactionFor({ name, risk }, ctx || {}).decision,
  });
}

class ToolRegistry {
  constructor(specs, agent) {
    this.specs = new Map();
    this.agent = agent || null;
    for (const s of specs || []) if (s && s.name) this.specs.set(s.name, s);
  }

  static create(ctx) {
    const c = ctx || {};
    // D2-14：preflight 一次 Agent scope。工具面在“可见”阶段就裁掉，
    // 而不是先给模型看、调用时再拒绝（后者会诱发重试）。
    const resolved = AgentRegistry.resolve(c);
    const agent = resolved.ok ? resolved.agent : null;
    if (agent) c.agentScope = resolved.scope;
    // Agent 可以比会话更窄：workspace 策略在这里真正进入权限判定，
    // 不是只挂在 scope 快照上给人看。
    const workspace = agent && agent.workspace !== 'inherit'
      ? Object.assign({}, c.workspace || {}, { mode: agent.workspace })
      : c.workspace;
    const scopeCtx = Object.assign({}, c, { workspace });
    const out = [];
    for (const name of Object.keys(AgentTools.ALL_SPECS)) {
      const spec = hydrate(name, AgentTools.ALL_SPECS[name], Object.assign({}, scopeCtx, { preset: agent ? agent.id : c.preset }));
      // P1：子智能体不能再无限套娃。达到深度上限时，工具表里直接没有它，
      // 而不是“先给模型看、调用时再拒绝”（后者会诱发模型反复重试）。
      if (name === 'spawn_subagent' && Number(scopeCtx.subagentDepth || 0) >= Number(scopeCtx.maxSubagentDepth == null ? 2 : ctx.maxSubagentDepth)) continue;
      if (agent && !resolved.allowsTool(name)) continue;
      if (policy.visible(spec, Object.assign({}, scopeCtx, { preset: agent ? agent.id : c.preset }))) out.push(spec);
    }
    return new ToolRegistry(out, agent);
  }

  names() { return Array.from(this.specs.keys()); }
  has(name) { return this.specs.has(String(name || '')); }
  spec(name) { return this.specs.get(String(name || '')) || null; }

  definitions() {
    return this.names().map((name) => {
      const s = this.specs.get(name);
      return {
        type: 'function',
        function: {
          name,
          description: s.description,
          parameters: JSON.parse(JSON.stringify(s.parameters || { type: 'object', properties: {} })),
        },
      };
    });
  }

  /** 返回当前作用域的只读快照，供 UI/诊断显示“到底给了模型哪些工具”。 */
  snapshot() {
    return this.names().map((name) => {
      const s = this.specs.get(name);
      return {
        name, risk: s.risk, scope: s.scope, description: s.description,
        local: !!s.local,
        // 工具卡要能直接画出"这一步要不要审批"，不必再自己推 risk。
        approval: s.interaction || (['write', 'exec'].includes(s.risk) ? 'ask' : 'never'),
        hasSchema: !!(s.parameters && s.parameters.properties),
      };
    });
  }

  /**
   * 执行一个已通过策略的工具调用。
   * deps 透传给 AgentTools：{dispatchTool, onTodo, askUser, native}
   */
  async execute(call, deps) {
    const name = String((call && call.name) || '');
    const spec = this.spec(name);
    if (!spec) {
      return { ok: false, content: '当前作用域不开放工具：' + name, command: null, code: 'TOOL_NOT_IN_SCOPE' };
    }
    return AgentTools.execute({ id: call && call.id, name, args: call && call.args }, deps || {});
  }
}

function create(ctx) { return ToolRegistry.create(ctx); }

module.exports = { ToolRegistry, create, hydrate };
