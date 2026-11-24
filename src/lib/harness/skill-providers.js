'use strict';
/**
 * Skill provider registry（D2-11）
 *
 * 技能发现以前是一段写死的目录列表：仓库 skills / 用户 ~/.genie/skills / 工作区
 * `.skills`。这在"只有本地目录"时够用，但一旦有企业技能包、远程订阅、插件自带
 * 技能，就得改 loader。这里把"技能从哪来"变成可注册的 provider，loader 只负责
 * "读 SKILL.md 并解析"。
 *
 * 优先级语义不变：roots 数组后面的覆盖前面的。provider 只追加根，
 * 不改变同名覆盖规则（覆盖事实仍由 loader 记进 `shadowed`，不静默丢弃）。
 */

const path = require('path');
const os = require('os');

function builtinRoots(o) {
  const opts = o || {};
  const skills = opts.skillsDir || process.env.GENIE_SKILLS_DIR || path.join(__dirname, '..', '..', '..', 'skills');
  const ws = opts.workspacePath || process.env.GENIE_WORKSPACE || '';
  const home = opts.homeDir || process.env.GENIE_HOME || path.join(os.homedir(), '.genie');
  const out = [{ kind: 'builtin', dir: path.resolve(skills), optional: false }];
  out.push({ kind: 'user', dir: path.join(home, 'skills'), optional: true });
  if (ws) {
    out.push({ kind: 'workspace', dir: path.join(ws, '.genie', 'skills'), optional: true });
    out.push({ kind: 'workspace', dir: path.join(ws, '.skills'), optional: true });
  }
  return out;
}

const BUILTIN = {
  id: 'builtin', label: '内置目录', order: 0,
  roots: builtinRoots,
};

class SkillProviderRegistry {
  constructor() {
    this.providers = new Map();
    this.register(BUILTIN, { replace: true });
  }

  register(provider, opts) {
    const p = provider || {};
    const id = String(p.id || '').trim();
    if (!id) throw new Error('skill provider 需要 id');
    if (typeof p.roots !== 'function') throw new Error('skill provider 必须提供 roots(opts)：' + id);
    if (this.providers.has(id) && !(opts && opts.replace)) throw new Error('skill provider 已存在：' + id);
    this.providers.set(id, Object.assign({ id, order: Number(p.order || 0) }, p));
    return this.get(id);
  }

  get(id) { return this.providers.get(String(id || '')) || null; }

  list() {
    return Array.from(this.providers.values()).sort((a, b) => a.order - b.order)
      .map((p) => ({ id: p.id, label: String(p.label || p.id), order: p.order }));
  }

  /** 所有 provider 的根，按 order 升序拼接；同一个 dir 只保留第一次出现。 */
  roots(opts) {
    const o = opts || {};
    const all = [];
    const seen = new Set();
    this.lastErrors = [];
    for (const p of Array.from(this.providers.values()).sort((a, b) => a.order - b.order)) {
      let roots = [];
      try { roots = p.roots(o) || []; } catch (e) {
        // provider 坏掉不能把整个技能系统拖垮；也不能塞一个空 dir 进根列表
        // （path.resolve('') 会变成 cwd，等于把整个项目当技能目录扫）。
        this.lastErrors = (this.lastErrors || []).concat([{ provider: p.id, error: e.message || String(e) }]);
        continue;
      }
      for (const r of roots) {
        if (!r || !r.dir) continue;
        const abs = path.resolve(r.dir);
        if (seen.has(abs)) continue;
        seen.add(abs);
        all.push(Object.assign({}, r, { dir: abs, provider: p.id }));
      }
    }
    return all;
  }

  reset() {
    this.providers.clear();
    this.register(BUILTIN, { replace: true });
  }
}

const singleton = new SkillProviderRegistry();
singleton.SkillProviderRegistry = SkillProviderRegistry;
singleton.builtinRoots = builtinRoots;

module.exports = singleton;
