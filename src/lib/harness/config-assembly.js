'use strict';
/**
 * Harness M4：profile + bundle + patch 多层装配（对标 DSH `profile + bundle + YAML patch`）
 *
 * 为什么要有这一层：
 *   M3 把插件注册表做成了真服务容器（consume 能拿到 impl），但"哪些插件存在、
 *   谁覆盖谁"仍写死在 builtins() 里。DSH 的做法是：base bundle 给出默认条目，
 *   profile / home / CLI patch 依次覆盖，最终 `dsh --dump-config` 打印整棵树，
 *   每行都能回答"它从哪来、被哪层改过"。本模块复刻这套语义，用 JSON 代替 YAML
 *   （项目约定：配置一律 JSON，不新增 YAML 依赖）。
 *
 * 精确语义（对齐 DSH vendor/include/src/patch.ts:105-182）：
 *   · 配置树 = 顶层**数组**，每个条目以 `id` 为唯一键；
 *   · 合并 = 按 id 建索引，patch 里出现的字段**整体替换**目标同名字段（不做深合并）；
 *   · `insert: [...]` = 追加新条目（不按 id 去重，但已有 id 会 warn 并跳过）；
 *   · 未知 id / name 断言不符 = warn 跳过，**不中断启动**（DSH 同理）；
 *   · 层顺序（后者胜）：base bundle → profile patch → home patch → argv --patch。
 *
 * 零回归承诺：没有任何 patch 文件时，compose() 输出的 entries 与传入的 base
 * 逐字段一致（只多两个内部标注字段），activateAll 行为与 M3 完全相同。
 */

const fs = require('node:fs');
const path = require('node:path');

// 内部标注字段：不参与 id 索引语义，只用于 dump 的来源解释。
const META = new Set(['_source', '_patchedBy']);

/** 从 JSON 文件读一个 patch 层。缺失 = 返回 null（该层不存在）；格式错 = 抛错（显式失败）。 */
function loadPatchFile(file, label) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw new Error(`patch 层 ${label} 读不了：${e.message}`);
  }
  let doc;
  try { doc = JSON.parse(text); }
  catch (e) { throw new Error(`patch 层 ${label} 不是合法 JSON：${e.message}`); }
  if (!Array.isArray(doc)) throw new Error(`patch 层 ${label} 顶层必须是数组（禁用请用 []）`);
  for (let i = 0; i < doc.length; i++) {
    if (!doc[i] || typeof doc[i] !== 'object' || Array.isArray(doc[i])) {
      throw new Error(`patch 层 ${label} 第 ${i + 1} 项必须是对象`);
    }
  }
  return { name: label, source: file, patches: doc };
}

/** argv 里的 --patch=<path>，按出现顺序；也接受 --patch <path>。 */
function overlayFiles(argv) {
  const out = [];
  const a = argv || [];
  for (let i = 0; i < a.length; i++) {
    const s = String(a[i]);
    if (s.startsWith('--patch=')) {
      const f = s.slice('--patch='.length).trim();
      if (f) out.push(f);
    } else if (s === '--patch' && i + 1 < a.length) {
      const f = String(a[++i]).trim();
      if (f) out.push(f);
    }
  }
  return out;
}

/** profile 层文件：<config>/profiles/<name>.patch.json（可选） */
function profilePatchFile(configDir, profileName, env) {
  const e = env || process.env;
  const override = e.GENIE_PROFILE_PATCH_FILE;
  if (override) return override;
  if (!profileName) return null;
  return path.join(configDir, 'profiles', String(profileName) + '.patch.json');
}

/** home 层文件：<home>/cordis.patch.json（可选）。home 由调用方注入，避免本模块依赖 runtime。 */
function homePatchFile(homeDir, env) {
  const e = env || process.env;
  const override = e.GENIE_HOME_PATCH_FILE;
  if (override) return override;
  if (!homeDir) return null;
  return path.join(homeDir, 'cordis.patch.json');
}

/**
 * 合并核心：base 条目数组 + 若干 patch 层 → 最终条目数组。
 * 每层返回一个新数组；base 不被修改。
 *
 * @param {Array} base 基础条目（习惯上是 plugin-registry.builtins()）
 * @param {Array<{name,source,patches}>} layers patch 层，按顺序后者胜
 * @param {(msg:string)=>void} warn 诊断回调（不传则收集到返回值的 warnings）
 * @returns {{entries:Array, warnings:string[]}}
 */
function applyPatches(base, layers, warn) {
  const warnings = [];
  const say = typeof warn === 'function' ? warn : (m) => warnings.push(m);
  const baseName = (layers && layers[0] && layers[0].name) || 'bundle';
  const entries = (base || []).map((e) => ({
    ...structuredClone(e), _source: baseName, _patchedBy: [],
  }));
  const index = new Map();
  for (const e of entries) if (e && e.id) index.set(e.id, e);

  for (const layer of layers || []) {
    if (!layer || !Array.isArray(layer.patches)) continue;
    const tag = layer.name || layer.source || 'patch';
    for (const p of layer.patches) {
      // insert：追加新条目。带 id 的 insert 必须是对象数组；已有 id 不覆盖，warn 跳过。
      if (Array.isArray(p.insert)) {
        for (const add of p.insert) {
          if (!add || !add.id) { say(`patch[${tag}]: insert 条目缺 id，已跳过`); continue; }
          if (index.has(add.id)) { say(`patch[${tag}]: insert 的 ${add.id} 已存在，已跳过`); continue; }
          const entry = { ...structuredClone(add), _source: tag, _patchedBy: [] };
          entries.push(entry);
          index.set(entry.id, entry);
        }
        continue;
      }
      if (!p.id) { say(`patch[${tag}]: 条目缺 id，已跳过`); continue; }
      const target = index.get(p.id);
      if (!target) { say(`patch[${tag}]: entry ${p.id} not found，已跳过`); continue; }
      // name 是断言守卫：不匹配就跳过，防止 patch 打到了改过名的插件上（DSH 同款）。
      if (p.name && target.name && p.name !== target.name) {
        say(`patch[${tag}]: ${p.id} 的 name 不符（期望 ${p.name}，实际 ${target.name}），已跳过`);
        continue;
      }
      // 整体替换：patch 里出现的字段覆盖目标同名字段；未出现的字段保留。
      // 不做深合并 —— 这是 DSH 的明确语义（config 子字段不会继承前层）。
      for (const [k, v] of Object.entries(p)) {
        if (k === 'id' || k === 'insert' || META.has(k)) continue;
        target[k] = structuredClone(v);
      }
      target._patchedBy.push(tag);
    }
  }
  return { entries, warnings };
}

/**
 * 装配入口：base bundle + profile + home + argv overlay → 可装载的 manifest 数组。
 *
 * @param {object} opts
 *   base       基础条目数组（必填，通常 plugin-registry.builtins()）
 *   configDir  配置目录（默认 paths.config）
 *   homeDir    用户数据目录（可选，home patch 所在）
 *   profile    档位名（dev/debug/prod）
 *   argv       命令行参数（--patch）
 *   env        环境变量覆盖（测试隔离用）
 *   warn       诊断回调
 * @returns {{entries, layers, warnings, profile, files}}
 */
function compose(opts) {
  const o = opts || {};
  const paths = require('../paths');
  const configDir = o.configDir || paths.config;
  const profile = o.profile || null;
  const env = o.env || process.env;
  const layers = [];
  const files = [];
  const warnings = [];
  const say = typeof o.warn === 'function' ? o.warn : (m) => warnings.push(m);

  // 第 0 层：base bundle（代码里的 builtins，随版本走，永远存在）
  layers.push({ name: 'bundle:genie-base', source: 'src/lib/plugin-registry.js#builtins', kind: 'bundle' });

  // 第 1 层：profile patch（随档位变）
  const pf = profilePatchFile(configDir, profile, env);
  const pl = pf ? loadPatchFile(pf, `profile:${profile || 'none'}`) : null;
  if (pl) {
    layers.push(pl);
    files.push(pf);
  }

  // 第 2 层：home patch（用户机器级覆盖）
  const hf = homePatchFile(o.homeDir == null ? homeDirFromEnv(env) : o.homeDir, env);
  const hl = hf ? loadPatchFile(hf, 'home') : null;
  if (hl) {
    layers.push(hl);
    files.push(hf);
  }

  // 第 3 层：argv --patch（可多个，按出现顺序）
  for (const f of overlayFiles(o.argv)) {
    const l = loadPatchFile(f, `overlay:${path.basename(f)}`);
    if (l) {
      layers.push(l);
      files.push(f);
    }
  }

  const merged = applyPatches(o.base || [], layers, say);
  return {
    entries: merged.entries,
    layers,
    warnings: merged.warnings,
    profile,
    files,
  };
}

function homeDirFromEnv(env) {
  const e = env || process.env;
  if (e.GENIE_HOME) return e.GENIE_HOME;
  try { return require('../../server/runtime').homeDir(); } catch (_) { return null; }
}

/**
 * 喂给注册表用的干净 manifest 数组：剥掉 _source/_patchedBy 标注字段。
 * activateAll → mount 拿到的是纯 manifest，不会被内部字段污染。
 */
function manifests(result) {
  return ((result && result.entries) || []).map((e) => {
    const clean = { ...e };
    for (const k of META) delete clean[k];
    return clean;
  });
}

/**
 * dump-config：输出最终合并树 + 来源标注（对标 `dsh --dump-config`）。
 * 输出是**最终树**（不是分层树），每行带 `_source` / `_patchedBy`，
 * 顶部 `layers` 说明叠加顺序，便于人肉回答"这个值是谁写的"。
 */
function dumpConfig(result) {
  const r = result || {};
  return {
    schemaVersion: 1,
    kind: 'harness-config',
    profile: r.profile || null,
    layers: (r.layers || []).map((l) => ({
      name: l.name,
      source: l.source || null,
      kind: l.kind || 'patch',
      patches: Array.isArray(l.patches) ? l.patches.length : 0,
    })),
    warnings: r.warnings || [],
    entries: r.entries || [],
    count: (r.entries || []).length,
  };
}

/** 人类可读文本（CLI 用）：顶部层注释 + JSON 树。 */
function dumpConfigText(result) {
  const d = dumpConfig(result);
  const lines = [
    '# Genie harness config (profile + bundle + patch)',
    '# 层顺序（后者胜）：',
    ...d.layers.map((l, i) => `#   ${i}. ${l.name}${l.source ? ' <- ' + l.source : ''}`),
    ...(d.warnings || []).map((w) => '# WARN: ' + w),
    '',
    JSON.stringify(d, null, 2),
  ];
  return lines.join('\n') + '\n';
}

module.exports = {
  loadPatchFile,
  overlayFiles,
  profilePatchFile,
  homePatchFile,
  applyPatches,
  compose,
  manifests,
  dumpConfig,
  dumpConfigText,
};
