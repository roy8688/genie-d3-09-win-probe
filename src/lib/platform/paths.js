'use strict';
/**
 * D3-10 平台路径单一入口（2026-11-24）
 *
 * 三平台的数据根/日志根/运行时根只在这里算；业务代码不许再写
 * `~/Library/Application Support/Genie` 或 `~/Library/Logs/Genie`。
 *
 * 口径：
 *   macOS  data: ~/Library/Application Support/Genie
 *   Windows data: %APPDATA%\Genie（缺省 ~/AppData/Roaming/Genie）
 *   Linux  data: $XDG_DATA_HOME/genie（缺省 ~/.local/share/genie）
 *
 *   日志各走系统惯例：macOS `~/Library/Logs/Genie`；Windows `<data>/logs`；
 *   Linux `$XDG_STATE_HOME/genie/logs`（缺省 ~/.local/state/genie/logs）。
 *
 *   runtime.json / runtime.lock：macOS/Windows 放数据根；Linux 放 state 根，
 *   与 D0-07 已落地的 `~/.local/state/genie` 保持一致（状态不是数据）。
 *
 * 所有函数接受 `{ platform, env }` 注入，测试可在不启动三台机器的前提下验证三种结果。
 */

const os = require('node:os');
const path = require('node:path');

const APP_DIR = 'Genie';
const LINUX_DIR = 'genie';

function platformOf(opts) {
  return (opts && opts.platform) || process.platform;
}

function envOf(opts) {
  return (opts && opts.env) || process.env;
}

function homeOf(opts) {
  const env = envOf(opts);
  return (opts && opts.home) || env.HOME || env.USERPROFILE || os.homedir();
}

function nonEmpty(value) {
  const s = value == null ? '' : String(value).trim();
  return s ? path.resolve(s) : '';
}

/** 数据根：会写用户长期内容（brain/config/references/models）。 */
function dataRoot(opts) {
  const env = envOf(opts);
  // GENIE_DATA_ROOT 是测试/隔离的最高优先；GENIE_HOME 是安装态注入的数据根。
  const explicit = nonEmpty(env.GENIE_DATA_ROOT) || nonEmpty(env.GENIE_HOME);
  if (explicit) return explicit;

  const platform = platformOf(opts);
  const home = homeOf(opts);
  if (platform === 'win32') {
    const appData = nonEmpty(env.APPDATA) || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, APP_DIR);
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_DIR);
  }
  const xdgData = nonEmpty(env.XDG_DATA_HOME) || path.join(home, '.local', 'share');
  return path.join(xdgData, LINUX_DIR);
}

/** Linux 状态根；macOS/Windows 直接用数据根。 */
function stateRoot(opts) {
  const explicit = nonEmpty(envOf(opts).GENIE_RUNTIME_HOME);
  if (explicit) return explicit;
  const platform = platformOf(opts);
  if (platform !== 'linux') return dataRoot(opts);
  const home = homeOf(opts);
  const xdgState = nonEmpty(envOf(opts).XDG_STATE_HOME) || path.join(home, '.local', 'state');
  return path.join(xdgState, LINUX_DIR);
}

/**
 * 运行时根（只在 Linux 与数据根分离）。
 * 兼容旧的 GENIE_RUNTIME_HOME / GENIE_HOME 语义：GENIE_RUNTIME_HOME 只挪锁与 runtime.json。
 */
function runtimeRoot(opts) {
  const env = envOf(opts);
  const explicit = nonEmpty(env.GENIE_RUNTIME_HOME);
  if (explicit) return explicit;
  // 兼容 D0-07：GENIE_HOME 是数据目录语义，旧行为里它也顺带作为运行时根。
  const dataHome = nonEmpty(env.GENIE_HOME);
  if (dataHome) return dataHome;
  return stateRoot(opts);
}

/** 日志根：macOS 走 ~/Library/Logs，其余走各自数据/状态根下的 logs。 */
function logRoot(opts) {
  const explicit = nonEmpty(envOf(opts).GENIE_LOG_DIR);
  if (explicit) return explicit;
  const platform = platformOf(opts);
  if (platform === 'darwin') return path.join(homeOf(opts), 'Library', 'Logs', APP_DIR);
  return path.join(stateRoot(opts), 'logs');
}

function runtimeFile(opts) {
  return path.join(runtimeRoot(opts), 'runtime.json');
}

function lockFile(opts) {
  return path.join(runtimeRoot(opts), 'runtime.lock');
}

function configRoot(opts) {
  return path.join(dataRoot(opts), 'config');
}

function describe(opts) {
  return {
    platform: platformOf(opts),
    dataRoot: dataRoot(opts),
    stateRoot: stateRoot(opts),
    runtimeRoot: runtimeRoot(opts),
    logRoot: logRoot(opts),
    runtimeFile: runtimeFile(opts),
    lockFile: lockFile(opts),
  };
}

module.exports = {
  APP_DIR,
  LINUX_DIR,
  dataRoot,
  stateRoot,
  runtimeRoot,
  logRoot,
  runtimeFile,
  lockFile,
  configRoot,
  describe,
};
