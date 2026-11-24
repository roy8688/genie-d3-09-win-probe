'use strict';
/**
 * D3-08：浏览器 / 电脑操作的会话级授权（不是“工具自己说自己有权限”）
 *
 * 为什么单独一层：
 *   browser_* / computer_* 能看屏幕、点鼠标、敲键盘，属于“人授权后才可做”的动作。
 *   如果把授权写成模型参数里的一个布尔值，模型自己就能填 true —— 那等于没有授权。
 *   这里把授权放在宿主侧（UI / 本地 API 调 authorize），工具侧只按 ownerKey + scope
 *   查询；没有授权、授权过期、用户按了停止键，都返回结构化错误，且不会触达 Chrome / GUI。
 *
 * 审计只记摘要：输入文本不进日志（可能是密码），只记长度与 sha256 前 12 位。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const paths = require('../paths');

const SCOPES = new Set(['browser', 'computer']);
const DEFAULT_TTL = { browser: 10 * 60 * 1000, computer: 5 * 60 * 1000 };
// 路径在模块加载时固定：测试可以只重定向审计文件，不必把整个 GENIE_DATA_ROOT 改掉
// （改全局数据根会污染同一进程里的后续用例，D3-08 首轮全量已经踩过一次）。
let AUDIT_FILE = process.env.GENIE_INTERACTION_AUDIT_FILE
  || path.join(paths.brainMeta, 'interaction-audit.jsonl');

/** 测试接缝：全量回归里 relay 可能早已加载本模块，不能再靠 env 二次生效。 */
function setAuditFileForTests(file) {
  const f = String(file || '').trim();
  if (!f) throw new Error('setAuditFileForTests 需要文件路径');
  AUDIT_FILE = f;
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function now() { return Date.now(); }

function auditFile() {
  return AUDIT_FILE;
}

function sha12(v) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v)).digest('hex').slice(0, 12);
}

/** 审计参数摘要：保留可复核的操作对象，不保留正文。 */
function summarize(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    return { chars: value.length, sha12: sha12(value) };
  }
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (/^(text|content|password|secret|token|apiKey)$/i.test(k)) {
      out[k] = { chars: String(v == null ? '' : v).length, sha12: sha12(v) };
    } else if (typeof v === 'string' && v.length > 200) {
      out[k] = v.slice(0, 200) + '…';
    } else {
      out[k] = v;
    }
  }
  return out;
}

function audit(event) {
  const row = Object.assign({ ts: new Date().toISOString() }, event || {});
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(row) + '\n', { mode: 0o600 });
  } catch (_) {
    // 审计失败不阻断操作，但调用方拿到 audit:false；不能让“写日志失败”被当成成功。
    return false;
  }
  return true;
}

class InteractionAccess {
  constructor() {
    this.grants = new Map(); // owner -> grant
  }

  normalizeScopes(scopes) {
    const raw = Array.isArray(scopes) ? scopes : [scopes];
    const out = [];
    for (const s of raw) {
      const v = String(s || '').trim().toLowerCase();
      if (!SCOPES.has(v)) throw fail('AUTH_UNKNOWN_SCOPE', '未知授权范围：' + s);
      if (!out.includes(v)) out.push(v);
    }
    if (!out.length) throw fail('AUTH_SCOPE_REQUIRED', '至少需要一个授权范围（browser / computer）');
    return out;
  }

  /**
   * 由宿主（UI 按钮 / 本地 API）调用。confirm 必须显式为 true：
   * 不能靠“没传 confirm 就算同意”，否则任何脚本都能无感授权。
   */
  authorize(ownerKey, scopes, opts) {
    const owner = String(ownerKey || '').trim();
    if (!owner) throw fail('AUTH_OWNER_REQUIRED', '缺少会话 owner，不能授权');
    const o = opts || {};
    if (o.confirm !== true) throw fail('AUTH_CONFIRM_REQUIRED', '授权需要用户显式确认（confirm:true）');
    const grantScopes = this.normalizeScopes(scopes);
    // 同一 owner 的授权按 scope 合并：先点“浏览器”再点“电脑”应该两者都有，
    // 不能第二次把第一次覆盖掉。停止键才是清空入口。
    const prev = this.grants.get(owner);
    const mergedScopes = (prev && !prev.stopped && now() <= prev.expiresAt)
      ? Array.from(new Set(prev.scopes.concat(grantScopes)))
      : grantScopes.slice();
    const ttlMs = Math.min(60 * 60 * 1000, Math.max(30 * 1000, Number(o.ttlMs || 0) || 0))
      || Math.max(...mergedScopes.map((s) => DEFAULT_TTL[s]));
    const prevByScope = (prev && prev.expiresByScope) ? prev.expiresByScope : {};
    const expiresByScope = {};
    for (const s of mergedScopes) {
      // 已有 scope 保持自己的到期时间；新 scope 用本次 ttl —— 后面的授权不能缩短前面的。
      expiresByScope[s] = (prevByScope[s] && prevByScope[s] > now()) ? prevByScope[s] : (now() + ttlMs);
    }
    const grant = {
      id: 'auth_' + crypto.randomBytes(8).toString('hex'),
      owner,
      scopes: mergedScopes,
      expiresByScope,
      createdAt: now(),
      expiresAt: Math.max(...mergedScopes.map((s) => expiresByScope[s])),
      reason: String(o.reason || '').slice(0, 200),
      stopped: false,
      stopReason: '',
    };
    this.grants.set(owner, grant);
    audit({
      kind: 'interaction', action: 'grant', owner, grantId: grant.id,
      scopes: grant.scopes, expiresAt: new Date(grant.expiresAt).toISOString(),
      reason: grant.reason, ok: true,
    });
    return this.status(owner);
  }

  rawGrant(ownerKey) {
    return this.grants.get(String(ownerKey || '').trim()) || null;
  }

  /** 工具入口唯一判定：没有授权就抛结构化错误，调用方不得继续启动浏览器/GUI。 */
  assert(ownerKey, scope) {
    const owner = String(ownerKey || '').trim();
    if (!owner) throw fail('AUTH_OWNER_REQUIRED', '缺少会话 owner，未授权');
    const grant = this.rawGrant(owner);
    if (!grant) throw fail('AUTH_REQUIRED', '尚未授权；请先在运行面板点“授权浏览器/电脑操作”');
    if (grant.stopped) throw fail('AUTH_STOPPED', '用户已停止交互操作（' + (grant.stopReason || 'stop key') + '）');
    if (now() > grant.expiresAt) {
      this.grants.delete(owner);
      throw fail('AUTH_EXPIRED', '授权已过期；请重新授权');
    }
    const scopes = grant.scopes || [];
    if (!scopes.includes(String(scope || ''))) {
      throw fail('AUTH_SCOPE_DENIED', '当前授权不含 ' + scope + ' 范围');
    }
    const byScope = grant.expiresByScope || {};
    const scopeEnd = Number(byScope[String(scope || '')] || grant.expiresAt || 0);
    if (now() > scopeEnd) {
      throw fail('AUTH_EXPIRED', '「' + scope + '」授权已过期；请重新授权');
    }
    return grant;
  }

  /** 停止键：不等待、立即把 grant 置为 stopped，并给每个在跑动作一个 abort 信号。 */
  stop(ownerKey, reason) {
    const owner = String(ownerKey || '').trim();
    if (!owner) throw fail('AUTH_OWNER_REQUIRED', '缺少会话 owner');
    const grant = this.grants.get(owner);
    if (grant) {
      grant.stopped = true;
      grant.stopReason = String(reason || 'user stop');
      grant.expiresAt = Math.min(grant.expiresAt, now());
    }
    audit({
      kind: 'interaction', action: 'stop', owner,
      grantId: grant ? grant.id : '', reason: String(reason || 'user stop'), ok: true,
    });
    return this.status(owner);
  }

  /** 最新状态；给 UI 展示“哪一类、还剩几秒”。不返回任何可被模型复用的 secret。 */
  status(ownerKey) {
    const owner = String(ownerKey || '').trim();
    const grant = this.grants.get(owner) || null;
    if (!grant) return { owner, granted: false, stopped: false, scopes: [], scopeRemain: {}, remainMs: 0, grantId: '' };
    const byScope = grant.expiresByScope || {};
    const scopeRemain = {};
    const active = [];
    let maxRemain = 0;
    for (const s of grant.scopes || []) {
      const end = Number(byScope[s] || grant.expiresAt || 0);
      scopeRemain[s] = Math.max(0, end - now());
      if (!grant.stopped && scopeRemain[s] > 0) {
        active.push(s);
        maxRemain = Math.max(maxRemain, scopeRemain[s]);
      }
    }
    return {
      owner, granted: active.length > 0,
      stopped: !!grant.stopped,
      scopes: active,
      scopeRemain,
      remainMs: maxRemain,
      grantId: grant.stopped ? '' : grant.id,
      createdAt: new Date(grant.createdAt).toISOString(),
      expiresAt: new Date(grant.expiresAt).toISOString(),
      reason: grant.reason,
      stopReason: grant.stopReason,
    };
  }

  clear(ownerKey) {
    this.grants.delete(String(ownerKey || '').trim());
  }

  _resetForTests() {
    this.grants.clear();
  }
}

module.exports = new InteractionAccess();
module.exports.summarize = summarize;
module.exports.audit = audit;
module.exports.auditFile = auditFile;
module.exports.setAuditFileForTests = setAuditFileForTests;
module.exports.InteractionAccess = InteractionAccess;
