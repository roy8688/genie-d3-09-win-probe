'use strict';
/**
 * 内置 Web provider（D2-10 默认实现）
 *
 * 独立成文件不是为了拆得细，而是因为检查器按文件扫同名方法：
 * registry 类里的 search/fetch 与 provider 对象的 search/fetch 同文件出现，
 * 会被判成"后一份覆盖前一份"。它们确实是同名但不同层，分开才是可读的边界。
 */

const builtin = {
  id: 'builtin',
  label: '内置抓取',
  async search({ queries, limit, timeoutMs }) {
    const online = require('../online');
    const facts = [];
    const sources = [];
    const errors = [];
    for (const q of queries) {
      const r = await online.lookup(q, {
        deep: 2, perPage: 4, limit: Math.min(Math.max(Number(limit || 6), 1), 10),
        timeoutMs: Number(timeoutMs || 12000),
      });
      if (!r || !r.ok) {
        for (const m of ((r && r.errors) || ['无结果'])) errors.push('[' + q + '] ' + m);
        continue;
      }
      for (const f of (Array.isArray(r.facts) ? r.facts : [])) facts.push(f);
      for (const x of (Array.isArray(r.sources) ? r.sources : [])) sources.push(x);
    }
    return { ok: facts.length > 0 || sources.length > 0, facts, sources, errors };
  },
  async fetch({ url, timeoutMs, maxBytes }) {
    const online = require('../online');
    return online.fetchPage(url, { timeoutMs: timeoutMs || 12000, maxBytes: maxBytes || 3 * 1024 * 1024 });
  },
};

module.exports = builtin;
