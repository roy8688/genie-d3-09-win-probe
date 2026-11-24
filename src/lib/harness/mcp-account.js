'use strict';
/**
 * MCP 统一凭证存储（D3-02，2026-11-23）
 *
 * 为什么单独做一个 store，而不是让每个 server 配置里直接写 token：
 *   · 一个 MCP 可能同时要 env/header 两种凭证，散在配置里迟早出现“改了 header 忘了 env”；
 *   · 状态/诊断接口必须能展示“有没有凭证”，但绝不能把 token 打到日志里；
 *   · 刷新令牌要原子落盘（0600），不能出现写一半的 JSON 让下次启动整份凭证失效。
 *
 * 存储形状（单文件，所有 server 共用，不按 server 散落）：
 *   { version:1, servers:{ [name]:{ accessToken, refreshToken, expiresAt, tokenType, scope, values:{...}, updatedAt } } }
 * 配置里用 `${credential:KEY}` 引用 `values.KEY` 或 grant 的 accessToken。
 */
const fs = require('node:fs');
const path = require('node:path');
const paths = require('../paths');

function storePath() {
  return process.env.GENIE_MCP_CREDENTIALS || path.join(paths.config, 'mcp-credentials.json');
}

function emptyStore() { return { version: 1, servers: {} }; }

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.servers || typeof raw.servers !== 'object') return emptyStore();
    return { version: 1, servers: raw.servers };
  } catch (_) { return emptyStore(); }
}

function writeStore(store) {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (_) {}
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
  return file;
}

function get(name) {
  const s = readStore().servers[String(name || '')];
  return s ? JSON.parse(JSON.stringify(s)) : null;
}

function set(name, grant) {
  const key = String(name || '').trim();
  if (!key) throw Object.assign(new Error('缺少 MCP server 名'), { code: 'MCP_ACCOUNT_NAME_REQUIRED' });
  const store = readStore();
  const prev = store.servers[key] || {};
  store.servers[key] = Object.assign({}, prev, grant || {}, { updatedAt: Date.now() });
  writeStore(store);
  return get(key);
}

function clear(name) {
  const store = readStore();
  const existed = !!store.servers[String(name || '')];
  delete store.servers[String(name || '')];
  writeStore(store);
  return existed;
}

function valuesFor(name, config) {
  const grant = get(name) || {};
  const account = Object.assign({}, grant.values || {});
  if (grant.accessToken) account.accessToken = grant.accessToken;
  // 配置里显式给的静态值优先级最高；凭证文件只是“没写死时的来源”。
  for (const [k, v] of Object.entries((config && config.credentials) || {})) {
    if (typeof v === 'string') account[k] = v;
  }
  return account;
}

function resolveTemplate(value, name, config) {
  if (typeof value !== 'string') return value;
  const vals = valuesFor(name, config);
  return value.replace(/\$\{credential:([A-Za-z0-9_.-]+)\}/g, (m, key) => {
    if (Object.prototype.hasOwnProperty.call(vals, key)) return String(vals[key]);
    throw Object.assign(new Error('MCP 凭证缺失：' + key), { code: 'MCP_CREDENTIAL_MISSING' });
  });
}

function redact(text, name, config) {
  let s = String(text == null ? '' : text);
  const vals = valuesFor(name, config);
  for (const v of Object.values(vals)) {
    if (v && String(v).length >= 6) s = s.split(String(v)).join('[redacted]');
  }
  return s;
}

/** 返回可挂到请求上的 Authorization 头；过期的访问令牌先尝试 refresh。 */
async function authorization(name, config) {
  const grant = get(name);
  if (!grant || !grant.accessToken) return null;
  const now = Date.now();
  const expired = Number(grant.expiresAt || 0) > 0 && Number(grant.expiresAt) <= now + 30 * 1000;
  if (!expired) return 'Bearer ' + grant.accessToken;
  if (!grant.refreshToken || !(config && config.oauth && config.oauth.tokenUrl) || !config.oauth.clientId) {
    throw Object.assign(new Error('MCP 访问令牌已过期，且没有可用的 refreshToken/tokenUrl'), { code: 'MCP_AUTH_EXPIRED' });
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: grant.refreshToken, client_id: String(config.oauth.clientId),
  });
  const vals = valuesFor(name, config);
  if (vals.clientSecret) body.set('client_secret', String(vals.clientSecret));
  if (grant.scope && config.oauth.scope) body.set('scope', String(config.oauth.scope));
  const res = await fetch(config.oauth.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error('MCP token refresh 失败（HTTP ' + res.status + '）'), { code: 'MCP_AUTH_REFRESH_FAILED' });
  let data;
  try { data = JSON.parse(text); } catch (_) { throw Object.assign(new Error('MCP token refresh 返回非 JSON'), { code: 'MCP_AUTH_REFRESH_FAILED' }); }
  if (!data.access_token) throw Object.assign(new Error('MCP token refresh 没有返回 access_token'), { code: 'MCP_AUTH_REFRESH_FAILED' });
  const next = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || grant.refreshToken,
    tokenType: data.token_type || grant.tokenType || 'Bearer',
    scope: data.scope || grant.scope || '',
    expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : 0,
  };
  set(name, next);
  return (next.tokenType || 'Bearer') + ' ' + next.accessToken;
}

/** 诊断用：只给“有没有、何时过期”，不回传任何密文。 */
function snapshot(name) {
  const g = get(name);
  if (!g) return { configured: false };
  return {
    configured: true,
    hasAccessToken: !!g.accessToken,
    hasRefreshToken: !!g.refreshToken,
    expiresAt: Number(g.expiresAt || 0) || null,
    updatedAt: Number(g.updatedAt || 0) || null,
  };
}

module.exports = {
  storePath, get, set, clear, valuesFor, resolveTemplate, redact, authorization, snapshot,
};
