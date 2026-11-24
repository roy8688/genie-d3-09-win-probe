'use strict';
/**
 * 通用 MCP Server 管理器（D3-02，2026-11-23）
 *
 * 一份配置（config/mcp.json）管理多台 server；每台 server 的生命周期、状态、能力列表
 * 和模型工具注册都从这里出。官方 mcp-manager 的完整语义（volatile 配置、OAuth 浏览器
 * 授权、探针流、on-demand 目录）不在这里假装都有：
 *   · 已做：stdio + Streamable HTTP、initialize/initialized、tools/resources/prompts、
 *           统一凭证、重连前清理、模型侧动态工具（mcp__<server>__<raw>）；
 *   · 未做：浏览器 OAuth 授权窗口（D3-07 UI）、on-demand 工具目录、探针并发取消。
 *
 * 动态工具命名和官方一致：`mcp__<serverName>__<rawName>`，超过 64 字符或含非法字符时
 * 追加 12 位身份哈希，防止两个不同 MCP 工具撞成同一个名字。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const paths = require('../paths');
const Client = require('./mcp-client');
const Account = require('./mcp-account');
const Resources = require('./mcp-resources');

const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_PUBLIC_NAME = 64;

let started = false;
let configs = new Map();
let records = new Map();
let publicToTool = new Map();
let loadError = null;

function configPath() {
  return process.env.GENIE_MCP_CONFIG || path.join(paths.config, 'mcp.json');
}

function rpcError(message, code) {
  const e = new Error(message);
  e.code = code || 'MCP_ERROR';
  return e;
}

function cleanString(v, fallback) {
  return typeof v === 'string' ? v : (fallback === undefined ? '' : fallback);
}

function validateServer(name, raw) {
  if (!SERVER_NAME_RE.test(String(name || ''))) {
    throw rpcError('MCP server 名不合法（只允许字母数字_-，1–32 字符）：' + name, 'MCP_CONFIG_INVALID');
  }
  if (!raw || typeof raw !== 'object') throw rpcError('MCP server 配置必须是对象：' + name, 'MCP_CONFIG_INVALID');
  const transport = cleanString(raw.transport);
  if (!['stdio', 'streamable-http'].includes(transport)) {
    throw rpcError('MCP server ' + name + ' 的 transport 只能是 stdio / streamable-http', 'MCP_CONFIG_INVALID');
  }
  if (transport === 'stdio') {
    if (!cleanString(raw.command).trim()) throw rpcError('MCP server ' + name + ' 缺少 command', 'MCP_CONFIG_INVALID');
    if (raw.args != null && !Array.isArray(raw.args)) throw rpcError('MCP server ' + name + ' 的 args 必须是数组', 'MCP_CONFIG_INVALID');
  } else {
    let u;
    try { u = new URL(cleanString(raw.url)); } catch (_) { throw rpcError('MCP server ' + name + ' 的 url 不合法', 'MCP_CONFIG_INVALID'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw rpcError('MCP server ' + name + ' 的 url 必须是 http/https', 'MCP_CONFIG_INVALID');
  }
  if (raw.env != null && (typeof raw.env !== 'object' || Array.isArray(raw.env))) throw rpcError('MCP server ' + name + ' 的 env 必须是对象', 'MCP_CONFIG_INVALID');
  if (raw.headers != null && (typeof raw.headers !== 'object' || Array.isArray(raw.headers))) throw rpcError('MCP server ' + name + ' 的 headers 必须是对象', 'MCP_CONFIG_INVALID');
  if (raw.risk != null && !['read', 'write', 'exec'].includes(raw.risk)) throw rpcError('MCP server ' + name + ' 的 risk 只能是 read/write/exec', 'MCP_CONFIG_INVALID');
  return Object.assign({}, raw, {
    transport,
    command: cleanString(raw.command),
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    env: raw.env && typeof raw.env === 'object' ? Object.assign({}, raw.env) : {},
    cwd: cleanString(raw.cwd),
    url: cleanString(raw.url),
    headers: raw.headers && typeof raw.headers === 'object' ? Object.assign({}, raw.headers) : {},
    enabled: raw.enabled !== false,
    risk: raw.risk || '',
    toolCallTimeoutMs: Math.min(600000, Math.max(1000, Number(raw.toolCallTimeoutMs) || 30000)),
    startupTimeoutMs: Math.min(600000, Math.max(1000, Number(raw.startupTimeoutMs) || 15000)),
    oauth: raw.oauth && typeof raw.oauth === 'object' ? Object.assign({}, raw.oauth) : null,
  });
}

function readConfig() {
  const file = configPath();
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return { servers: {}, file, error: null };
    return { servers: {}, file, error: '读取 MCP 配置失败：' + e.message };
  }
  if (!raw || typeof raw !== 'object') return { servers: {}, file, error: 'MCP 配置必须是对象' };
  const servers = raw.servers == null ? {} : raw.servers;
  if (typeof servers !== 'object' || Array.isArray(servers)) return { servers: {}, file, error: 'MCP 配置的 servers 必须是对象' };
  const out = {};
  for (const [name, entry] of Object.entries(servers)) out[name] = validateServer(name, entry);
  return { servers: out, file, error: null };
}

function publicToolName(serverName, rawName) {
  const joined = 'mcp__' + serverName + '__' + rawName;
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_');
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME) return normalized;
  const hash = crypto.createHash('sha256').update(serverName + '\0' + rawName).digest('hex').slice(0, 12);
  return normalized.slice(0, MAX_PUBLIC_NAME - hash.length - 1) + '_' + hash;
}

function safeSummary(name, config) {
  return {
    name,
    transport: config.transport,
    enabled: config.enabled !== false,
    risk: config.risk || '(按工具注解)',
    command: config.transport === 'stdio' ? path.basename(config.command || '') : '',
    argCount: config.args ? config.args.length : 0,
    url: config.transport === 'streamable-http' ? (() => {
      try { const u = new URL(config.url); return u.origin + u.pathname; } catch (_) { return ''; }
    })() : '',
  };
}

function unregisterTools(rec) {
  if (!rec || !rec.publicTools) return;
  let AgentTools = null;
  try { AgentTools = require('./agent-tools'); } catch (_) {}
  for (const publicName of rec.publicTools) {
    publicToTool.delete(publicName);
    if (AgentTools) {
      delete AgentTools.ALL_SPECS[publicName];
      AgentTools.LOCAL_TOOLS.delete(publicName);
    }
  }
  rec.publicTools = new Set();
}

function registerTools(rec) {
  const AgentTools = require('./agent-tools');
  unregisterTools(rec);
  const cfg = rec.config;
  for (const tool of rec.tools) {
    if (!tool || !tool.name) continue;
    const pub = publicToolName(rec.name, String(tool.name));
    const risk = cfg.risk || (tool.annotations && tool.annotations.readOnlyHint ? 'read' : 'write');
    const description = ('[MCP ' + rec.name + '] ' + String(tool.description || tool.title || tool.name)).slice(0, 500);
    const parameters = tool.inputSchema && typeof tool.inputSchema === 'object'
      ? JSON.parse(JSON.stringify(tool.inputSchema))
      : { type: 'object', properties: {} };
    if (!parameters.type) parameters.type = 'object';
    const spec = {
      local: true, dynamic: true, risk, mcp: { server: rec.name, rawName: String(tool.name) },
      description, parameters,
    };
    AgentTools.ALL_SPECS[pub] = spec;
    AgentTools.LOCAL_TOOLS.add(pub);
    rec.publicTools.add(pub);
    publicToTool.set(pub, { server: rec.name, rawName: String(tool.name), risk });
  }
  return Array.from(rec.publicTools);
}

function statusOf(name) {
  const rec = records.get(name);
  const cfg = configs.get(name);
  if (!rec && !cfg) return null;
  if (!rec) {
    return Object.assign(safeSummary(name, cfg), { state: cfg.enabled === false ? 'disabled' : 'idle', toolCount: 0, tools: [], resourceCount: 0, promptCount: 0, error: null });
  }
  const conn = rec.conn;
  let state = rec.state;
  if (state === 'connected' && conn && conn.closed) state = 'failed';
  return Object.assign(safeSummary(name, cfg || rec.config), {
    state,
    toolCount: rec.tools.length,
    tools: rec.tools.map((t) => String(t.name)).slice(0, 200),
    resourceCount: rec.resources.length,
    resourceTemplateCount: rec.resourceTemplates.length,
    promptCount: rec.prompts.length,
    serverInfo: rec.serverInfo || null,
    protocolVersion: rec.protocolVersion || null,
    credential: Account.snapshot(name),
    connectedAt: rec.connectedAt || null,
    error: rec.error ? Account.redact(rec.error, name, rec.config).slice(0, 800) : null,
  });
}

async function connectOne(name) {
  const cfg = configs.get(name);
  if (!cfg) throw rpcError('没有这个 MCP server：' + name, 'MCP_SERVER_NOT_FOUND');
  if (cfg.enabled === false) {
    records.set(name, { name, config: cfg, state: 'disabled', conn: null, tools: [], resources: [], resourceTemplates: [], prompts: [], publicTools: new Set(), error: null });
    return statusOf(name);
  }
  const prev = records.get(name);
  if (prev && prev.conn) {
    try { await prev.conn.close(); } catch (_) {}
  }
  unregisterTools(prev);
  const rec = { name, config: cfg, state: 'connecting', conn: null, tools: [], resources: [], resourceTemplates: [], prompts: [], publicTools: new Set(), error: null };
  records.set(name, rec);
  try {
    rec.conn = await Client.connect(name, cfg);
    rec.tools = await Client.listTools(rec.conn, cfg.toolCallTimeoutMs);
    rec.resources = await Client.listResources(rec.conn, cfg.toolCallTimeoutMs);
    rec.resourceTemplates = await Client.listResourceTemplates(rec.conn, cfg.toolCallTimeoutMs);
    rec.prompts = await Client.listPrompts(rec.conn, cfg.toolCallTimeoutMs);
    rec.serverInfo = rec.conn.serverInfo;
    rec.protocolVersion = rec.conn.protocolVersion;
    rec.tools.forEach((t) => { if (t && t.name && !t.inputSchema) t.inputSchema = { type: 'object', properties: {} }; });
    rec.state = 'connected';
    rec.connectedAt = Date.now();
    if (cfg.toolLoading !== 'off') registerTools(rec);
    return statusOf(name);
  } catch (e) {
    rec.state = 'failed';
    rec.tools = [];
    rec.error = Account.redact(String((e && e.message) || e), name, cfg);
    if (rec.conn) { try { await rec.conn.close(); } catch (_) {} rec.conn = null; }
    unregisterTools(rec);
    throw e;
  }
}

function ensure(name) {
  const cfg = configs.get(name);
  if (!cfg) throw rpcError('没有这个 MCP server：' + name, 'MCP_SERVER_NOT_FOUND');
  const rec = records.get(name);
  if (rec && rec.state === 'connected' && rec.conn && !rec.conn.closed) return rec;
  throw rpcError('MCP server 不可用：' + name + (rec && rec.error ? '（' + rec.error + '）' : ''), 'MCP_SERVER_UNAVAILABLE');
}

async function loadAndStart() {
  const r = readConfig();
  loadError = r.error;
  configs = new Map(Object.entries(r.servers));
  started = true;
  const results = [];
  for (const name of configs.keys()) {
    if (configs.get(name).enabled === false) { results.push(statusOf(name)); continue; }
    try { results.push(await connectOne(name)); }
    catch (_) { results.push(statusOf(name)); }
  }
  return { ok: !loadError, error: loadError, servers: results, configPath: r.file };
}

async function startEnabled() {
  if (started) return { ok: true, already: true, servers: status().servers };
  return loadAndStart();
}

async function reload() {
  for (const rec of records.values()) {
    unregisterTools(rec);
    if (rec.conn) { try { await rec.conn.close(); } catch (_) {} }
  }
  records = new Map();
  publicToTool = new Map();
  return loadAndStart();
}

function status() {
  const names = Array.from(new Set([...configs.keys(), ...records.keys()]));
  return {
    started,
    configPath: configPath(),
    loadError,
    servers: names.map(statusOf).filter(Boolean),
    registeredTools: publicToTool.size,
  };
}

function listTools(name) {
  const rec = records.get(String(name || ''));
  if (!rec) throw rpcError('没有这个 MCP server：' + name, 'MCP_SERVER_NOT_FOUND');
  return rec.tools.map((t) => ({ name: t.name, description: t.description || '', risk: configs.get(name).risk || (t.annotations && t.annotations.readOnlyHint ? 'read' : 'write'), inputSchema: t.inputSchema }));
}

async function callTool(name, rawName, args) {
  const rec = ensure(String(name || ''));
  if (!rec.tools.some((t) => t && t.name === String(rawName))) {
    throw rpcError('MCP server ' + name + ' 没有工具：' + rawName, 'MCP_TOOL_NOT_FOUND');
  }
  const result = await Client.callTool(rec.conn, String(rawName), args || {}, rec.config.toolCallTimeoutMs);
  const flat = Client.flattenResult(result, name, rec.config);
  return { ok: !flat.isError, content: flat.text || (flat.isError ? 'MCP 工具返回错误' : '（工具没有返回文本）'), raw: { content: flat.content, structuredContent: flat.structuredContent, isError: flat.isError, server: name, tool: rawName } };
}

async function executePublicTool(publicName, args) {
  const hit = publicToTool.get(String(publicName || ''));
  if (!hit) throw rpcError('MCP 工具不可用：' + publicName, 'MCP_TOOL_NOT_REGISTERED');
  return callTool(hit.server, hit.rawName, args);
}

async function listResources(name) {
  const rec = ensure(String(name || ''));
  return Resources.summarizeResources(rec.resources, rec.resourceTemplates);
}

async function readResource(name, uri) {
  const rec = ensure(String(name || ''));
  const result = await Client.readResource(rec.conn, String(uri || ''), rec.config.toolCallTimeoutMs);
  const normalized = Resources.contentText(result);
  return { contents: normalized.contents, text: Account.redact(normalized.text, name, rec.config) };
}

async function listPrompts(name) {
  const rec = ensure(String(name || ''));
  return rec.prompts;
}

async function getPrompt(name, promptName, args) {
  const rec = ensure(String(name || ''));
  if (!rec.prompts.some((p) => p && p.name === String(promptName))) throw rpcError('MCP server ' + name + ' 没有 prompt：' + promptName, 'MCP_PROMPT_NOT_FOUND');
  const result = await Client.getPrompt(rec.conn, String(promptName), args || {}, rec.config.toolCallTimeoutMs);
  const normalized = Resources.promptText(result);
  return { description: normalized.description, messages: normalized.messages, text: Account.redact(normalized.text, name, rec.config) };
}

async function shutdown() {
  for (const rec of records.values()) {
    unregisterTools(rec);
    if (rec.conn) { try { await rec.conn.close(); } catch (_) {} }
  }
  records = new Map();
  publicToTool = new Map();
  started = false;
}

/** 测试隔离：清空连接、配置和动态工具，不读磁盘之外的状态。 */
async function resetForTests() {
  await shutdown();
  configs = new Map();
  loadError = null;
}

module.exports = {
  configPath, readConfig, validateServer, publicToolName, safeSummary,
  startEnabled, reload, status, listTools, callTool, executePublicTool,
  listResources, readResource, listPrompts, getPrompt,
  shutdown, resetForTests,
  MAX_PUBLIC_NAME, SERVER_NAME_RE,
};
