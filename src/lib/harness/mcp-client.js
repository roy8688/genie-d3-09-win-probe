'use strict';
/**
 * MCP 客户端传输层（D3-02，2026-11-23）
 *
 * 只做协议本身：JSON-RPC 2.0、initialize / initialized、tools/resources/prompts、
 * stdio 子进程与 Streamable HTTP（含 SSE 响应）。不引入 @modelcontextprotocol/client：
 * 项目当前没有这条依赖，为“列一次工具”加一整棵 SDK 依赖不划算。
 *
 * 结构上只允许一份 `request / notify / close`：stdio 与 HTTP 都继承 BaseConnection，
 * 各自只实现 `_send / _unwrap / _close`。上一版两个类各写一遍，机械护栏直接报
 * “同名方法定义了 2 次”——这类重复会让一个传输的修复在另一个传输里静默失效。
 *
 * 诚实边界：
 *   · stdio 走逐行 JSON-RPC；server 往 stdout 打日志会被当协议消息忽略并记入 badLines；
 *   · HTTP 只消费 POST 的响应体（JSON 或 text/event-stream），不额外开 GET SSE 长连接；
 *   · OAuth 只负责带 Bearer 与 refresh；浏览器授权流程留给 D3-07 的 UI，不假装已经能点。
 */
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const Account = require('./mcp-account');

const CLIENT_INFO = { name: 'genie', version: '0.1' };
const DEFAULT_PROTOCOL = '2025-06-18';
const DEFAULT_TIMEOUT = 30000;
const MAX_LIST_PAGES = 8;

function rpcError(message, code, data) {
  const e = new Error(message);
  e.code = code || 'MCP_RPC_ERROR';
  if (data !== undefined) e.data = data;
  return e;
}

function scrubEnv(base, extra) {
  const out = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (/TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|AUTH|COOKIE|CREDENTIAL/i.test(k)) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(extra || {})) out[k] = v;
  return out;
}

function parseSse(text) {
  const messages = [];
  for (const block of String(text || '').split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    if (!data) continue;
    try { messages.push(JSON.parse(data)); } catch (_) { /* 非 JSON 事件（心跳/endpoint）忽略 */ }
  }
  return messages;
}

class BaseConnection {
  constructor(name, config, kind) {
    this.name = name;
    this.config = config;
    this.kind = kind;
    this.nextId = 1;
    this.closed = false;
    this.capabilities = {};
    this.serverInfo = null;
    this.protocolVersion = null;
    this.badLines = 0;
    this.stderr = '';
    this.sessionId = null;
  }

  async request(method, params, timeoutMs) {
    if (this.closed) throw rpcError('MCP server 不可用', 'MCP_SERVER_UNAVAILABLE');
    const id = this.nextId++;
    const body = { jsonrpc: '2.0', id, method, params: params || {} };
    const msg = await this._send(body, Math.max(1000, Number(timeoutMs || DEFAULT_TIMEOUT)), method);
    return this._unwrap(msg, id, method);
  }

  async notify(method, params) {
    if (this.closed) throw rpcError('MCP server 不可用', 'MCP_SERVER_UNAVAILABLE');
    // JSON-RPC 通知没有 id，也不能等响应：上一版给了 id 却不等，结果每条初始化
    // 通知都挂满 30 秒超时（fixture 不回 notification，这是合法行为）。
    return this.kind === 'stdio'
      ? this._notifyStdio(method, params)
      : this._notifyHttp(method, params);
  }

  async _notifyStdio(method, params) {
    if (!this.child) await this._spawn();
    if (this.closed || !this.child || !this.child.stdin.writable) throw rpcError('MCP server 不可用', 'MCP_SERVER_UNAVAILABLE');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
    return { ok: true };
  }

  async _notifyHttp(method, params) {
    await this._sendHttp({ jsonrpc: '2.0', method, params: params || {} }, DEFAULT_TIMEOUT);
    return { ok: true };
  }

  async close() {
    this.closed = true;
    return this.kind === 'stdio' ? this._closeStdio() : this._closeHttp();
  }

  async _send(body, timeoutMs, method) {
    return this.kind === 'stdio'
      ? this._sendStdio(body, timeoutMs, method)
      : this._sendHttp(body, timeoutMs);
  }

  _unwrap(msg, id, method) {
    const hit = Array.isArray(msg) ? msg.find((m) => m && m.id === id) : (msg && msg.id === id ? msg : null);
    if (!hit) throw rpcError(method + ' 没有返回匹配 id 的响应', 'MCP_BAD_RESPONSE');
    if (hit.error) throw rpcError(method + '：' + (hit.error.message || 'server error'), 'MCP_RPC_ERROR', hit.error);
    return hit.result == null ? {} : hit.result;
  }
}

class StdioConnection extends BaseConnection {
  constructor(name, config) {
    super(name, config, 'stdio');
    this.child = null;
    this.pending = new Map();
  }

  async _spawn() {
    const c = this.config;
    const env = scrubEnv(process.env, {});
    for (const [k, v] of Object.entries(c.env || {})) env[k] = Account.resolveTemplate(v, this.name, c);
    const child = spawn(c.command, Array.isArray(c.args) ? c.args : [], {
      cwd: c.cwd || process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child = child;
    child.on('error', (e) => this._failAll(rpcError('MCP stdio 启动失败：' + e.message, 'MCP_SPAWN_FAILED')));
    child.on('exit', (code, signal) => {
      this.closed = true;
      this._failAll(rpcError('MCP server 已退出（code=' + code + '）', 'MCP_SERVER_EXITED'));
    });
    child.stderr.on('data', (d) => { this.stderr = (this.stderr + String(d || '')).slice(-8192); });
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this._onLine(line));
  }

  _onLine(line) {
    const t = String(line || '').trim();
    if (!t) return;
    let msg;
    try { msg = JSON.parse(t); } catch (_) { this.badLines++; return; }
    if (msg && msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  }

  _failAll(error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }

  async _sendStdio(body, timeoutMs, method) {
    if (!this.child) await this._spawn();
    if (this.closed || !this.child || !this.child.stdin.writable) {
      throw rpcError('MCP server 不可用', 'MCP_SERVER_UNAVAILABLE');
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(body.id);
        reject(rpcError(method + ' 超时（' + timeoutMs + 'ms）', 'MCP_TIMEOUT'));
      }, timeoutMs);
      timer.unref();
      this.pending.set(body.id, { resolve, reject, timer, method });
      try { this.child.stdin.write(JSON.stringify(body) + '\n'); }
      catch (e) { clearTimeout(timer); this.pending.delete(body.id); reject(e); }
    });
  }

  async _closeStdio() {
    this._failAll(rpcError('MCP 连接已关闭', 'MCP_CONNECTION_CLOSED'));
    if (!this.child) return { ok: true };
    const child = this.child;
    this.child = null;
    try { child.stdin.end(); } catch (_) {}
    try { child.kill('SIGTERM'); } catch (_) {}
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(); }, 800);
      timer.unref();
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    return { ok: true };
  }
}

class HttpConnection extends BaseConnection {
  constructor(name, config) {
    super(name, config, 'streamable-http');
  }

  async _headers() {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    for (const [k, v] of Object.entries(this.config.headers || {})) headers[k] = Account.resolveTemplate(v, this.name, this.config);
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
    const auth = hasAuth ? null : await Account.authorization(this.name, this.config);
    if (auth) headers.Authorization = auth;
    return headers;
  }

  async _sendHttp(body, timeoutMs) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref();
    try {
      const res = await fetch(this.config.url, { method: 'POST', headers: await this._headers(), body: JSON.stringify(body), signal: ac.signal });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      const text = await res.text();
      if (!res.ok) throw rpcError('MCP HTTP ' + res.status + '：' + Account.redact(text.slice(0, 300), this.name, this.config), 'MCP_HTTP_ERROR');
      if (!text.trim()) return null;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('text/event-stream')) {
        const msgs = parseSse(text);
        return msgs.length ? msgs : null;
      }
      try { return JSON.parse(text); } catch (_) { this.badLines++; return null; }
    } catch (e) {
      if (e && e.name === 'AbortError') throw rpcError('MCP HTTP 超时（' + timeoutMs + 'ms）', 'MCP_TIMEOUT');
      throw e;
    } finally { clearTimeout(timer); }
  }

  async _closeHttp() {
    try {
      if (this.sessionId) await fetch(this.config.url, { method: 'DELETE', headers: await this._headers() });
    } catch (_) {}
    return { ok: true };
  }
}

async function initialize(conn, config) {
  const timeout = Number(config.startupTimeoutMs || config.toolCallTimeoutMs || DEFAULT_TIMEOUT);
  const init = await conn.request('initialize', {
    protocolVersion: config.protocolVersion || DEFAULT_PROTOCOL,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  }, timeout);
  conn.capabilities = (init && init.capabilities) || {};
  conn.serverInfo = (init && init.serverInfo) || null;
  conn.protocolVersion = (init && init.protocolVersion) || config.protocolVersion || DEFAULT_PROTOCOL;
  try { await conn.notify('notifications/initialized', {}); } catch (_) { /* 通知失败不影响能力可用 */ }
  return init;
}

async function listAll(conn, method, key, opts) {
  const o = opts || {};
  const out = [];
  let cursor;
  for (let i = 0; i < MAX_LIST_PAGES; i++) {
    const r = await conn.request(method, cursor ? { cursor } : {}, o.timeoutMs || DEFAULT_TIMEOUT);
    const list = (r && Array.isArray(r[key])) ? r[key] : [];
    out.push(...list);
    cursor = r && r.nextCursor;
    if (!cursor) break;
  }
  return out;
}

async function connect(name, config) {
  if (!config || !config.transport) throw rpcError('MCP server 缺少 transport', 'MCP_CONFIG_INVALID');
  const conn = config.transport === 'stdio' ? new StdioConnection(name, config) : new HttpConnection(name, config);
  await initialize(conn, config);
  return conn;
}

async function listTools(conn, timeoutMs) {
  if (!conn.capabilities || !conn.capabilities.tools) return [];
  return listAll(conn, 'tools/list', 'tools', { timeoutMs });
}

async function listResources(conn, timeoutMs) {
  if (!conn.capabilities || !conn.capabilities.resources) return [];
  return listAll(conn, 'resources/list', 'resources', { timeoutMs });
}

async function listResourceTemplates(conn, timeoutMs) {
  if (!conn.capabilities || !conn.capabilities.resources) return [];
  return listAll(conn, 'resources/templates/list', 'resourceTemplates', { timeoutMs });
}

async function listPrompts(conn, timeoutMs) {
  if (!conn.capabilities || !conn.capabilities.prompts) return [];
  return listAll(conn, 'prompts/list', 'prompts', { timeoutMs });
}

async function callTool(conn, name, args, timeoutMs) {
  if (!conn.capabilities || !conn.capabilities.tools) throw rpcError('这个 MCP server 没有声明 tools 能力', 'MCP_NO_TOOLS');
  return conn.request('tools/call', { name, arguments: args || {} }, timeoutMs);
}

async function readResource(conn, uri, timeoutMs) {
  if (!conn.capabilities || !conn.capabilities.resources) throw rpcError('这个 MCP server 没有声明 resources 能力', 'MCP_NO_RESOURCES');
  return conn.request('resources/read', { uri }, timeoutMs);
}

async function getPrompt(conn, name, args, timeoutMs) {
  if (!conn.capabilities || !conn.capabilities.prompts) throw rpcError('这个 MCP server 没有声明 prompts 能力', 'MCP_NO_PROMPTS');
  return conn.request('prompts/get', { name, arguments: args || {} }, timeoutMs);
}

/** 把 MCP content[] 归一成模型可读文本；图片/资源块保留原始结构。 */
function flattenResult(result, serverName, config) {
  const r = result || {};
  const content = Array.isArray(r.content) ? r.content : [];
  const texts = [];
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'text') texts.push(String(b.text || ''));
    else if (b.type === 'image') texts.push('[图片 ' + (b.mimeType || 'image') + ']');
    else if (b.type === 'resource') {
      const res = b.resource || {};
      texts.push(String(res.text == null ? ('[资源 ' + (res.uri || '') + ']') : res.text));
    } else if (b.type === 'resource_link') texts.push('[资源链接 ' + (b.uri || '') + ']');
  }
  let text = texts.join('\n');
  if (r.structuredContent !== undefined) {
    try { text += (text ? '\n' : '') + JSON.stringify(r.structuredContent); } catch (_) {}
  }
  text = Account.redact(text, serverName, config);
  return { text, isError: !!r.isError, content, structuredContent: r.structuredContent };
}

module.exports = {
  BaseConnection, StdioConnection, HttpConnection, connect, initialize,
  listTools, listResources, listResourceTemplates, listPrompts,
  callTool, readResource, getPrompt, flattenResult,
  scrubEnv, parseSse,
  DEFAULT_TIMEOUT,
};
