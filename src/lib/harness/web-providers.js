'use strict';
/**
 * Web provider seam（D2-10）
 *
 * 现在 `web_search` / `web_fetch` 直接 require `online`，换一个搜索后端要改
 * 工具实现；而"工具实现"和"搜索后端"本来是两件事。这里把后端抽成 seam：
 * 工具只认 `search/fetch` 两个动作，具体是内置抓取、DeepSeek Search、Bing 还是
 * 企业内网，由注册表决定。
 *
 * 刻意不做的事：
 *  · 不把 provider 名字写进模型可见的工具名（模型不需要知道后端）；
 *  · 不在 seam 里做权限判断（那是 tool-policy，越权判断必须只有一处）；
 *  · provider 失败不自动换下一个：静默降级会让"搜不到"和"后端坏了"无法区分。
 */

const builtin = require('./web-builtin');

class WebProviderRegistry {
  constructor() {
    this.providers = new Map();
    this.defaultId = 'builtin';
    this.register(builtin, { replace: true });
  }

  register(provider, opts) {
    const p = provider || {};
    const id = String(p.id || '').trim();
    if (!id) throw new Error('web provider 需要 id');
    if (typeof p.search !== 'function' && typeof p.fetch !== 'function') {
      throw new Error('web provider 至少要提供 search 或 fetch');
    }
    if (this.providers.has(id) && !(opts && opts.replace)) throw new Error('web provider 已存在：' + id);
    this.providers.set(id, Object.assign({ id }, p));
    return this.get(id);
  }

  get(id) { return this.providers.get(String(id || this.defaultId)) || null; }

  list() {
    return Array.from(this.providers.values()).map((p) => ({
      id: p.id, label: String(p.label || p.id),
      search: typeof p.search === 'function', fetch: typeof p.fetch === 'function',
    }));
  }

  resolve(id) {
    const target = String(id || process.env.GENIE_WEB_PROVIDER || this.defaultId);
    const p = this.get(target);
    if (!p) throw Object.assign(new Error('没有这个 web provider：' + target), { code: 'WEB_PROVIDER_NOT_FOUND' });
    return p;
  }

  async search(opts) {
    const o = opts || {};
    const p = this.resolve(o.provider);
    if (typeof p.search !== 'function') throw Object.assign(new Error('provider 不支持 search：' + p.id), { code: 'WEB_PROVIDER_NO_SEARCH' });
    const r = await p.search(o);
    return Object.assign({ provider: p.id }, r || {});
  }

  async fetch(opts) {
    const o = opts || {};
    const p = this.resolve(o.provider);
    if (typeof p.fetch !== 'function') throw Object.assign(new Error('provider 不支持 fetch：' + p.id), { code: 'WEB_PROVIDER_NO_FETCH' });
    return p.fetch(o);
  }

  setDefault(id) {
    if (!this.get(id)) throw new Error('没有这个 web provider：' + id);
    this.defaultId = String(id);
    return this.defaultId;
  }

  reset() {
    this.providers.clear();
    this.defaultId = 'builtin';
    this.register(builtin, { replace: true });
  }
}

const singleton = new WebProviderRegistry();
singleton.WebProviderRegistry = WebProviderRegistry;

module.exports = singleton;
