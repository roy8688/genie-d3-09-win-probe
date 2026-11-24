'use strict';
/**
 * D3-08：会话级浏览器 provider（真实 Chrome，不是“打开一个 URL 就返回成功”）
 *
 * 复用仓库已有的浏览器底座（browser-session.js 同源的 puppeteer-core + 本机 Chrome），
 * 但把“站点登录”抽象成“按 owner 命名的资源”：
 *   browser:<owner>          默认 provider
 *   browser:<owner>#<name>   同一会话里的第二个浏览器（多任务并行）
 * 每个 provider 有自己的 Chrome、profile、page；关闭/停止/空闲 5 分钟后真正退出。
 *
 * 授权不在这里“默认放行”：每个入口先 InteractionAccess.assert(owner, 'browser')。
 * 因此未授权时连 Chrome 进程都不会启动。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const paths = require('../paths');
const Platform = require('../platform');
const Access = require('./interaction-access');



const IDLE_MS = 5 * 60 * 1000;
const MAX_TEXT = 16000;
const MAX_INPUT = 4000;

function fail(code, message, raw) {
  const e = new Error(message);
  e.code = code;
  if (raw !== undefined) e.raw = raw;
  return e;
}

function chromeBin() {
  return Platform.browser.findBrowserBinary({
    configured: process.env.GENIE_CHROME_BIN,
    name: 'chrome',
  });
}

function safeUrl(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw fail('BROWSER_URL_REQUIRED', '缺少 url');
  if (raw.length > 4096) throw fail('BROWSER_URL_TOO_LONG', 'url 太长');
  let u;
  try { u = new URL(raw); } catch (_) { throw fail('BROWSER_URL_INVALID', 'url 不合法：' + raw); }
  if (!/^https?:$/.test(u.protocol)) {
    throw fail('BROWSER_URL_SCHEME_DENIED', '只允许 http/https；拒绝 ' + u.protocol);
  }
  return u.toString();
}

function safeToken(v, fallback) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return fallback;
  return s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48) || fallback;
}

function providerName(owner, name) {
  const base = 'browser:' + String(owner || '').trim();
  return name ? base + '#' + safeToken(name, 'main') : base;
}

function safeSelector(v) {
  const s = String(v == null ? '' : v);
  if (!s.trim()) throw fail('BROWSER_SELECTOR_REQUIRED', '缺少 selector');
  if (s.length > 1000) throw fail('BROWSER_SELECTOR_TOO_LONG', 'selector 太长');
  return s;
}

class BrowserProvider {
  constructor() {
    this.providers = new Map(); // name -> session
    this.seq = 0;
    // 在构造期固定；测试只改这两个目录，不改 GENIE_DATA_ROOT。
    this.tempRoot = process.env.GENIE_BROWSER_TEMP || paths.tempBrowser;
    this.screenshotsDir = process.env.GENIE_SCREENSHOTS_DIR || paths.tempScreenshots;
  }

  _ownerName(ownerKey, name) {
    const owner = String(ownerKey || '').trim();
    if (!owner) throw fail('BROWSER_OWNER_REQUIRED', '缺少会话 owner');
    return { owner, name: providerName(owner, name) };
  }

  _touch(session) {
    session.lastUsedAt = Date.now();
    if (session.idleTimer) session.idleTimer.unref && session.idleTimer.unref();
  }

  _armIdle(session) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      this.closeProvider(session.name).catch(() => {});
    }, IDLE_MS);
    if (session.idleTimer.unref) session.idleTimer.unref();
  }

  _get(ownerKey, provider) {
    const owner = String(ownerKey || '').trim();
    if (provider) {
      const s = this.providers.get(String(provider));
      if (!s) throw fail('BROWSER_PROVIDER_NOT_FOUND', '没有这个浏览器 provider：' + provider);
      if (s.owner !== owner) throw fail('BROWSER_PROVIDER_NOT_OWNED', '浏览器 provider 不属于当前会话');
      return s;
    }
    const exact = this.providers.get(providerName(owner, ''));
    if (exact) return exact;
    // 默认 provider 没开过时，退到该 owner 最新一个（与 terminal 默认最近一个同口径）。
    let latest = null;
    for (const s of this.providers.values()) {
      if (s.owner !== owner) continue;
      if (!latest || s.lastUsedAt > latest.lastUsedAt) latest = s;
    }
    if (latest) return latest;
    throw fail('BROWSER_NOT_OPEN', '还没有浏览器会话；先调用 browser_open');
  }

  async _openResult(snapshot) {
    const snap = await snapshot;
    return {
      content: '浏览器已打开：' + snap.provider + ' · ' + (snap.title || '(无标题)')
        + ' · ' + (snap.url || ''),
      raw: snap,
    };
  }

  async open(ownerKey, args) {
    const a = args || {};
    const { owner, name } = this._ownerName(ownerKey, a.name);
    Access.assert(owner, 'browser');
    const url = safeUrl(a.url);
    const existing = this.providers.get(name);
    if (existing && existing.browser && existing.browser.connected) {
      const page = await existing.pagePromise;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      this._touch(existing);
      return this._openResult(this._snapshot(existing, { opened: false, reused: true }));
    }

    const bin = chromeBin();
    if (!bin) throw fail('BROWSER_CHROME_MISSING', '找不到 Chrome/Chromium；无法启动真实浏览器');
    let puppeteer;
    try { puppeteer = require('puppeteer-core'); } catch (e) {
      throw fail('BROWSER_PUPPETEER_MISSING', '缺少 puppeteer-core：' + e.message);
    }

    const id = 'bp' + (++this.seq) + '_' + crypto.randomBytes(3).toString('hex');
    const profileDir = path.join(this.tempRoot, safeToken(owner, 'owner') + '-' + id);
    fs.mkdirSync(profileDir, { recursive: true });
    const headless = a.headless === false ? false : true;
    const width = Math.min(2400, Math.max(480, Number(a.width || 1280)));
    const height = Math.min(1600, Math.max(320, Number(a.height || 800)));

    let browser;
    try {
      browser = await puppeteer.launch({
        executablePath: bin,
        headless,
        userDataDir: profileDir,
        defaultViewport: { width, height },
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
          '--window-size=' + width + ',' + height,
        ],
      });
    } catch (e) {
      throw fail('BROWSER_LAUNCH_FAILED', 'Chrome 启动失败：' + (e.message || e));
    }

    const session = {
      name, owner, id, browser, profileDir, headless,
      createdAt: Date.now(), lastUsedAt: Date.now(), idleTimer: null,
      pagePromise: browser.newPage().then(async (page) => {
        page.setDefaultTimeout(30000);
        await page.setViewport({ width, height });
        return page;
      }),
    };
    this.providers.set(name, session);
    browser.on('disconnected', () => {
      if (this.providers.get(name) === session) this.providers.delete(name);
      if (session.idleTimer) clearTimeout(session.idleTimer);
    });

    try {
      const page = await session.pagePromise;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      await this.closeProvider(name).catch(() => {});
      throw fail('BROWSER_GOTO_FAILED', '打开页面失败：' + (e.message || e));
    }
    this._armIdle(session);
    return this._openResult(this._snapshot(session, { opened: true, reused: false }));
  }

  async _page(ownerKey, provider) {
    const owner = String(ownerKey || '').trim();
    // 先判授权，再找 provider：停止键之后即使浏览器已被关闭，也应回 AUTH_STOPPED，
    // 不能因为“provider 不在”把真实原因盖成 BROWSER_NOT_OPEN。
    Access.assert(owner, 'browser');
    const s = this._get(owner, provider);
    try {
      const page = await s.pagePromise;
      if (!page || page.isClosed()) throw fail('BROWSER_PAGE_CLOSED', '浏览器页面已关闭');
      this._touch(s);
      return { s, page };
    } catch (e) {
      if (e && e.code) throw e;
      throw fail('BROWSER_PAGE_FAILED', '取页面失败：' + (e.message || e));
    }
  }

  async _snapshot(s, extra) {
    let title = '';
    let url = '';
    try {
      const page = await s.pagePromise;
      title = await page.title();
      url = page.url();
    } catch (_) { /* 页面刚关时允许空 */ }
    return Object.assign({
      provider: s.name, id: s.id, owner: s.owner, title, url,
      headless: s.headless === true,
      startedAt: new Date(s.createdAt).toISOString(),
    }, extra || {});
  }

  async read(ownerKey, args) {
    const a = args || {};
    const { s, page } = await this._page(ownerKey, a.provider);
    const selector = a.selector ? safeSelector(a.selector) : '';
    const maxChars = Math.min(30000, Math.max(200, Number(a.maxChars || 12000)));
    let payload;
    try {
      payload = await page.evaluate((sel) => {
        const el = sel ? document.querySelector(sel) : document.body;
        if (!el) return { missing: true };
        const text = String(el.innerText || el.textContent || '');
        const fields = [];
        for (const f of Array.from(document.querySelectorAll('input,textarea,select')).slice(0, 30)) {
          const label = f.getAttribute('aria-label') || f.getAttribute('placeholder') || f.id || f.name || f.tagName.toLowerCase();
          fields.push({ label, type: String(f.type || ''), value: String(f.value == null ? '' : f.value).slice(0, 300) });
        }
        const links = [];
        for (const l of Array.from(document.querySelectorAll('a[href]')).slice(0, 40)) {
          links.push({ text: String(l.innerText || '').trim().slice(0, 120), href: l.href });
        }
        return { title: document.title, url: location.href, text, fields, links };
      }, selector || null);
    } catch (e) {
      throw fail('BROWSER_READ_FAILED', '读取页面失败：' + (e.message || e));
    }
    if (payload && payload.missing) throw fail('BROWSER_SELECTOR_NOT_FOUND', '页面上找不到：' + selector);
    const text = String((payload && payload.text) || '');
    const clipped = text.length > maxChars ? text.slice(0, maxChars) + '\n…（页面文本已截断，共 ' + text.length + ' 字符）' : text;
    const fieldLines = ((payload && payload.fields) || []).filter((f) => f.value)
      .map((f) => '[字段 ' + f.label + ' = ' + f.value + ']');
    const linkLines = ((payload && payload.links) || []).slice(0, 20)
      .map((l) => '- ' + (l.text || '(无文字)') + ' → ' + l.href);
    const content = [
      '标题：' + ((payload && payload.title) || ''),
      '地址：' + ((payload && payload.url) || ''),
      '',
      clipped || '（页面没有可见文本）',
      fieldLines.length ? '\n' + fieldLines.join('\n') : '',
      linkLines.length ? '\n链接：\n' + linkLines.join('\n') : '',
    ].join('\n');
    this._armIdle(s);
    return { content, raw: { provider: s.name, title: (payload && payload.title) || '', url: (payload && payload.url) || '', chars: text.length, selector, fields: (payload && payload.fields) || [], links: (payload && payload.links) || [] } };
  }

  async click(ownerKey, args) {
    const a = args || {};
    const { s, page } = await this._page(ownerKey, a.provider);
    const selector = a.selector ? safeSelector(a.selector) : '';
    const hasXY = Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.y));
    if (!selector && !hasXY) throw fail('BROWSER_CLICK_ARGS', 'click 需要 selector，或同时给 x/y');
    try {
      if (selector) {
        await page.click(selector, { delay: 15 });
      } else {
        const x = Math.min(10000, Math.max(0, Number(a.x)));
        const y = Math.min(10000, Math.max(0, Number(a.y)));
        await page.mouse.click(x, y);
      }
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/No element found|not found|Failed to execute/.test(msg)) {
        throw fail('BROWSER_SELECTOR_NOT_FOUND', '点击目标不存在：' + (selector || (a.x + ',' + a.y)));
      }
      throw fail('BROWSER_CLICK_FAILED', '点击失败：' + msg);
    }
    await page.waitForNetworkIdle({ idleTime: 250, timeout: 2000 }).catch(() => {});
    this._touch(s);
    return this._snapshot(s, { clicked: selector || (a.x + ',' + a.y) });
  }

  async type(ownerKey, args) {
    const a = args || {};
    const { s, page } = await this._page(ownerKey, a.provider);
    const selector = safeSelector(a.selector);
    const text = String(a.text == null ? '' : a.text);
    if (!text) throw fail('BROWSER_TYPE_ARGS', 'type 需要非空 text');
    if (text.length > MAX_INPUT) throw fail('BROWSER_TYPE_TOO_LONG', '输入文本超过 ' + MAX_INPUT + ' 字符');
    try {
      await page.click(selector, { clickCount: 3, delay: 10 });
      await page.keyboard.press('Backspace');
      await page.type(selector, text, { delay: 2 });
      if (a.submit === true) await page.keyboard.press('Enter');
    } catch (e) {
      throw fail('BROWSER_TYPE_FAILED', '输入失败：' + (e.message || e));
    }
    await page.waitForNetworkIdle({ idleTime: 250, timeout: 2000 }).catch(() => {});
    this._touch(s);
    return this._snapshot(s, { typedChars: text.length, submitted: a.submit === true });
  }

  async screenshot(ownerKey, args) {
    const a = args || {};
    const { s, page } = await this._page(ownerKey, a.provider);
    fs.mkdirSync(this.screenshotsDir, { recursive: true });
    const base = safeToken(a.name, 'browser') + '-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex');
    const file = path.join(this.screenshotsDir, base + '.png');
    try {
      await page.screenshot({ path: file, fullPage: a.fullPage === true, type: 'png' });
    } catch (e) {
      throw fail('BROWSER_SCREENSHOT_FAILED', '截图失败：' + (e.message || e));
    }
    const st = fs.statSync(file);
    this._touch(s);
    return {
      content: '浏览器截图已保存：' + file + '（' + st.size + ' bytes）',
      raw: { provider: s.name, path: file, bytes: st.size, fullPage: a.fullPage === true, url: page.url() },
    };
  }

  async close(ownerKey, args) {
    const a = args || {};
    const owner = String(ownerKey || '').trim();
    if (!owner) throw fail('BROWSER_OWNER_REQUIRED', '缺少会话 owner');
    if (a.provider) {
      const s = this._get(owner, a.provider);
      return this._closeSession(s);
    }
    const s = this._get(owner, '');
    return this._closeSession(s);
  }

  async closeProvider(name) {
    const s = this.providers.get(String(name || ''));
    if (!s) return { closed: false, provider: name };
    return this._closeSession(s);
  }

  async closeAll(ownerKey) {
    const owner = String(ownerKey || '').trim();
    const rows = [];
    for (const s of Array.from(this.providers.values())) {
      if (s.owner !== owner) continue;
      rows.push(await this._closeSession(s));
    }
    return rows;
  }

  async _closeSession(s) {
    if (!s) return { closed: false };
    if (this.providers.get(s.name) === s) this.providers.delete(s.name);
    if (s.idleTimer) clearTimeout(s.idleTimer);
    let closed = false;
    try {
      if (s.browser && s.browser.connected) await s.browser.close();
      closed = true;
    } catch (_) { /* 已退出也算关闭 */ }
    return { closed, provider: s.name, owner: s.owner };
  }

  list(ownerKey) {
    const owner = ownerKey ? String(ownerKey).trim() : '';
    return Array.from(this.providers.values())
      .filter((s) => !owner || s.owner === owner)
      .map((s) => ({
        name: s.name, owner: s.owner, id: s.id,
        createdAt: new Date(s.createdAt).toISOString(),
        lastUsedAt: new Date(s.lastUsedAt).toISOString(),
        connected: !!(s.browser && s.browser.connected),
      }));
  }

  async closeAllSessions() {
    const rows = [];
    for (const s of Array.from(this.providers.values())) rows.push(await this._closeSession(s));
    return rows;
  }

  _resetForTests() {
    this.providers.clear();
    this.seq = 0;
  }
}

module.exports = new BrowserProvider();
module.exports.BrowserProvider = BrowserProvider;
module.exports.providerName = providerName;
module.exports.safeUrl = safeUrl;
module.exports.chromeBin = chromeBin;
