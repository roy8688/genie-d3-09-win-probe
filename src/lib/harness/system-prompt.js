'use strict';
/**
 * 系统提示装配器（P0-3）—— 对标 DSH `core/system-prompt`
 *
 * DSH 的系统提示不是一根字符串，而是一个**注册表 + 协作式流水线**：
 *   · 每个贡献方注册 section（order + 作用域 + 文本）；
 *   · agent 作用域的同名 section 遮蔽全局项；
 *   · 变量在每次 assemble 时解析，未知变量**直接失败**，不发送坏提示；
 *   · 工具 schema 与提示文本一起装配，`toolOrder` 只决定顺序、不改语义；
 *   · 一个 `complete:true` section 可以整体接管提示（多份则失败）。
 *
 * Genie 以前把这些人格、场景、知识、能力清单直接拼成一根字符串，结果是：
 *   · 顺序写死在 `_chatSystemPrompt` 的数组里，新增一段只能插到“看起来合适”的位置；
 *   · 工作区 / 权限 / 工具清单只能追加在末尾，模型经常看不到；
 *   · 没有变量校验，模型偶尔会收到字面 `{{workspace}}`；
 *   · 工具定义与提示文本分开装配，顺序由 Object.keys 决定，无法稳定。
 *
 * 本模块只做装配，不拥有业务事实：文本由调用方给，工具由 registry 给。
 * 纯逻辑、零 relay 依赖，独立可测。
 */

const UNLISTED = '<unlisted-tools>';
const VAR_RE = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function normScope(s) { return String(s || 'global').trim() || 'global'; }
function normName(n) {
  const name = String(n || '').trim();
  if (!name) throw new Error('system-prompt: section 缺少 name');
  return name;
}
function normalizeOrder(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('system-prompt: section.order 必须是有限数字');
  return n;
}

class SystemPrompt {
  constructor(opts) {
    const o = opts || {};
    this.includeHarnessIdentity = o.includeHarnessIdentity !== false;
    this.includeRuntimeContext = o.includeRuntimeContext !== false;
    this.personaPrefix = String(o.personaPrefix || '');
    this.personaSuffix = String(o.personaSuffix || '');
    this.toolOrder = Array.isArray(o.toolOrder) ? o.toolOrder.map(String) : null;
    this._sections = new Map();   // key = scope + '\u0000' + name
    this._variables = new Map();  // key = scope + '\u0000' + name
    this._contexts = new Map();   // 动态运行时上下文（可选，可作为 user 快照）
  }

  _key(scope, name) { return normScope(scope) + '\u0000' + normName(name); }

  /**
   * 注册一个提示段。
   * @param {object} input
   *   name, order, text|()=>text, scope='global', interpolate=true,
   *   complete=false, required=false
   */
  section(input) {
    const i = input || {};
    const name = normName(i.name);
    const scope = normScope(i.scope);
    const item = {
      name,
      order: normalizeOrder(i.order == null ? 0 : i.order),
      text: i.text == null ? '' : i.text,
      scope,
      interpolate: i.interpolate !== false,
      complete: !!i.complete,
      required: !!i.required,
    };
    this._sections.set(this._key(scope, name), item);
    return this;
  }

  /** 注册变量。value 可以是函数（assemble 时求值）或静态值。 */
  variable(name, value, opts) {
    const n = String(name || '').trim();
    if (!/^[A-Za-z_][\w.-]*$/.test(n)) throw new Error('system-prompt: 变量名非法：' + name);
    const scope = normScope((opts && opts.scope) || 'global');
    this._variables.set(scope + '\u0000' + n, { name: n, scope, value });
    return this;
  }

  /** 动态运行时上下文：与 section 分开，官方把它作为带来源的 user 快照。 */
  context(name, text, opts) {
    const n = normName(name);
    const scope = normScope((opts && opts.scope) || 'global');
    this._contexts.set(scope + '\u0000' + n, {
      name: n, scope, order: normalizeOrder((opts && opts.order) || 0),
      text, required: !!(opts && opts.required),
    });
    return this;
  }

  removeSection(name, scope) {
    this._sections.delete(this._key(scope || 'global', name));
    return this;
  }

  /** 当前作用域可见的 section（同名时 scope 覆盖 global）。 */
  sections(scope) {
    const s = normScope(scope);
    const out = new Map();
    for (const [key, item] of this._sections.entries()) {
      if (item.scope === 'global' || item.scope === s) out.set(item.name, item);
    }
    return Array.from(out.values()).sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
  }

  _varsFor(scope) {
    const s = normScope(scope);
    const out = new Map();
    for (const [key, item] of this._variables.entries()) {
      if (item.scope === 'global' || item.scope === s) out.set(item.name, item);
    }
    return out;
  }

  /** 渲染一段：未知/无值变量 → 抛错；`interpolate:false` 原样返回。 */
  _render(text, scope, ctx) {
    const raw = typeof text === 'function' ? text(ctx) : text;
    let out = String(raw == null ? '' : raw);
    const opens = (out.match(/\{\{/g) || []).length;
    const closes = (out.match(/\}\}/g) || []).length;
    if (opens !== closes) throw new Error('system-prompt: 未闭合的变量引用');
    const vars = this._varsFor(scope);
    out = out.replace(VAR_RE, (whole, name) => {
      const item = vars.get(name);
      if (!item) throw new Error('system-prompt: 未知变量 {{' + name + '}}');
      let value;
      try { value = typeof item.value === 'function' ? item.value(ctx) : item.value; }
      catch (e) { throw new Error('system-prompt: 变量 {{' + name + '}} 求值失败：' + e.message); }
      if (value == null || value === '') {
        throw new Error('system-prompt: 变量 {{' + name + '}} 没有值');
      }
      return String(value);
    });
    // 插值后仍残留 `{{` 说明变量名非法或嵌套，不能把坏提示发给模型。
    if (out.includes('{{')) throw new Error('system-prompt: 变量插值后仍残留 {{…}}');
    return out;
  }

  /**
   * 装配。返回 { system, tools, sections, context }。
   * @param {object} input { scope, tools, variables, model, provider, suppressContext }
   */
  assemble(input) {
    const i = input || {};
    const scope = normScope(i.scope);
    const ctx = Object.assign({}, i.variables || {}, {
      model: i.model == null ? '' : i.model,
      provider: i.provider == null ? '' : i.provider,
    });
    const list = this.sections(scope);
    const rendered = [];
    let complete = null;
    for (const s of list) {
      if (s.complete) {
        if (complete) throw new Error('system-prompt: 存在多个 complete section：' + complete.name + ' / ' + s.name);
        complete = s;
      }
    }
    const chosen = complete ? [complete] : list;
    for (const s of chosen) {
      const text = s.interpolate ? this._render(s.text, scope, ctx) : String(
        typeof s.text === 'function' ? s.text(ctx) : s.text == null ? '' : s.text
      );
      if (text.trim()) rendered.push({ name: s.name, order: s.order, text: text.trim() });
    }
    let system = rendered.map((s) => s.text).join('\n\n');
    if (this.includeHarnessIdentity && !complete && !rendered.some((s) => s.name === 'harness:identity')) {
      // 与 DSH 的固定开场白同义，但保留 Genie 自己的名字，避免模型自称 DeepSeek。
      system = system.trim()
        ? '你是 Genie，一个可调用工具完成任务的桌面 Agent。\n\n' + system
        : '你是 Genie，一个可调用工具完成任务的桌面 Agent。';
    }
    if (!system.trim()) system = '';

    let tools = Array.isArray(i.tools) ? i.tools.slice() : [];
    if (this.toolOrder) tools = orderTools(tools, this.toolOrder);

    const dynamic = [];
    if (this.includeRuntimeContext && !i.suppressContext) {
      for (const [key, c] of this._contexts.entries()) {
        if (c.scope !== 'global' && c.scope !== scope) continue;
        const text = c.text == null ? '' : String(c.text);
        if (text.trim()) dynamic.push({ name: c.name, order: c.order, text: text.trim() });
      }
      dynamic.sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : 1));
    }

    return {
      system,
      tools,
      sections: rendered,
      context: dynamic,
      complete: complete ? complete.name : null,
    };
  }
}

/**
 * 按 DSH `toolOrder` 规则排序：必须恰好一个 `<unlisted-tools>` 占位，
 * 显式列出的名字必须都存在；未列出的工具落在占位处，保持原注册顺序。
 */
function orderTools(tools, order) {
  const list = Array.isArray(tools) ? tools.slice() : [];
  const names = list.map((t) => String((t && t.function && t.function.name) || (t && t.name) || ''));
  const spec = Array.isArray(order) ? order.map(String) : [];
  const markers = spec.filter((n) => n === UNLISTED).length;
  if (markers !== 1) throw new Error('system-prompt: toolOrder 必须恰好包含一个 ' + UNLISTED);
  if (new Set(spec).size !== spec.length) throw new Error('system-prompt: toolOrder 存在重复项');
  for (const n of spec) {
    if (n === UNLISTED) continue;
    if (!names.includes(n)) throw new Error('system-prompt: toolOrder 引用了未注册工具：' + n);
  }
  const byName = new Map();
  for (const t of list) {
    byName.set(String((t && t.function && t.function.name) || (t && t.name) || ''), t);
  }
  const out = [];
  for (const n of spec) {
    if (n === UNLISTED) {
      for (const name of names) {
        if (!spec.includes(name)) out.push(byName.get(name));
      }
    } else {
      out.push(byName.get(n));
    }
  }
  return out;
}

function create(opts) { return new SystemPrompt(opts); }

module.exports = { SystemPrompt, create, orderTools, UNLISTED };
