'use strict';
/**
 * D3-10 平台适配层入口（2026-11-24）
 *
 * 业务代码只从这里取平台能力：
 *   Platform.paths / process / shell / browser / office / apps / wps / dialogs
 * 测试可向每个函数注入 `{ platform, env, exists, execFileSync }`，
 * 因此三平台行为能在同一台机器上被真实断言。
 */

module.exports = {
  paths: require('./paths'),
  process: require('./process'),
  shell: require('./shell'),
  browser: require('./browser'),
  office: require('./office'),
  apps: require('./apps'),
  wps: require('./wps'),
  dialogs: require('./dialogs'),
  gui: require('./gui'),
  fonts: require('./fonts'),
};
