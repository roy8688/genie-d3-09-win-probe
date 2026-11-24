'use strict';
/**
 * 能力 seam（Harness M3，docs/57）—— 消费者从这里取 provider，不再直接 require
 *
 * DSH 的核心主张：Service Definition / Provider / Consumer 三个角色分开，
 * "换一个 provider 就换一个产品"，消费者不认识具体实现。
 *
 * Genie 的 API 层过去直接 `require('../../lib/knowledge-retriever')`，
 * 于是"换检索实现"要改每一处 require。这一层提供唯一入口：
 *
 *   const KR = Seams.get('knowledge', () => require('../../lib/knowledge-retriever'), ctx);
 *
 * 解析顺序：
 *   1. ctx._pluginRegistry（relay 启动时 activateAll 的注册表）里有实现 → 用它；
 *   2. 没有 → 用 fallback 直接 require（零回归：注册表没装配时行为与过去一字不差）。
 *
 * 为什么每次调用都重新解析、不缓存：
 *   缓存会让"运行中换 provider"失效——那正是 seam 存在的意义。取实现是 Map 查找，
 *   代价可忽略；require 的模块缓存本身就兜住了重复加载。
 */
'use strict';

/** 服务名 → 默认实现模块（相对本文件，src/lib）。fallback 与 builtins().entry 对齐。 */
const FALLBACKS = {
  schedule: () => require('../cron-jobs'),
  automation: () => require('../automations'),
  workspace: () => require('../workspaces'),
  knowledge: () => require('../knowledge-retriever'),
  deliverable: () => require('../artifacts'),
};

/**
 * 从注册表取一个服务的实现。
 *
 * @param {string} name 服务名
 * @param {Function} [fallback] 注册表没有时的实现工厂；不传则用内置 FALLBACKS
 * @param {object} [ctx] relay 上下文（取 ctx._pluginRegistry）
 * @returns {*} provider 实现（模块对象 / 服务实例）
 */
function get(name, fallback, ctx) {
  const reg = ctx && ctx._pluginRegistry;
  if (reg && typeof reg.consumeOptional === 'function') {
    const impl = reg.consumeOptional(name);
    if (impl) return impl;
  }
  const factory = typeof fallback === 'function'
    ? fallback
    : (FALLBACKS[name] || (() => { throw new Error(`未知服务 ${name}，且未提供 fallback`); }));
  return factory();
}

/** 当前注册表里是否真的装配了这个服务（供诊断 / dump，不影响 get 的 fallback）。 */
function provided(name, ctx) {
  const reg = ctx && ctx._pluginRegistry;
  return !!(reg && typeof reg.has === 'function' && reg.has(name));
}

module.exports = { get, provided, FALLBACKS };
