'use strict';
/**
 * D3-10 WPS 加载项目录与打开方式（2026-11-24）
 *
 * 现状必须说清楚，不许把“看起来支持”写成“支持”：
 *   macOS  : 加载项目录已知，实时写入链路保持现状；
 *   Windows: WPS 的 jsaddons 目录未在本机 Windows 实测，暂不声明支持实时写入；
 *   Linux  : 官方无等价加载项，明确降级为本地 docx + 系统默认程序打开。
 */

const fs = require('node:fs');
const path = require('node:path');
const Apps = require('./apps');

function envOf(opts) { return (opts && opts.env) || process.env; }
function platformOf(opts) { return (opts && opts.platform) || process.platform; }
function homeOf(opts) { return (opts && opts.home) || envOf(opts).HOME || envOf(opts).USERPROFILE || require('node:os').homedir(); }
function existsFn(opts) { return (opts && opts.exists) || fs.existsSync; }

function candidates(opts = {}) {
  const platform = platformOf(opts);
  const env = envOf(opts);
  const home = homeOf(opts);
  if (platform === 'darwin') {
    return [path.join(home, 'Library', 'Containers', 'com.kingsoft.wpsoffice.mac', 'Data', '.kingsoft', 'wps', 'jsaddons')];
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.win32.join(appData, 'kingsoft', 'wps', 'jsaddons'),
      path.win32.join(appData, 'Kingsoft', 'WPS Office', 'jsaddons'),
      path.win32.join(local, 'Kingsoft', 'WPS Office', 'jsaddons'),
    ];
  }
  return [
    path.join(home, '.local', 'share', 'Kingsoft', 'wps', 'jsaddons'),
    path.join(home, '.config', 'Kingsoft', 'wps', 'jsaddons'),
  ];
}

/**
 * @returns {{path:string, known:boolean, candidates:string[], platform:string}}
 * known=false 表示该平台目录还没实测，调用方必须走中性降级，不能自动装加载项。
 */
function addonDir(opts = {}) {
  const platform = platformOf(opts);
  const exists = existsFn(opts);
  const list = candidates(opts);
  if (platform === 'darwin') {
    return { platform, path: list[0], known: true, candidates: list };
  }
  for (const p of list) {
    try { if (exists(p)) return { platform, path: p, known: true, candidates: list }; } catch (_) {}
  }
  return { platform, path: '', known: false, candidates: list };
}

/** 实时写入（WPS 加载项轮询）只在 macOS 已实测；其他平台明确不支持。 */
function liveWriteSupported(opts = {}) {
  const platform = platformOf(opts);
  if (platform !== 'darwin') {
    return { supported: false, reason: platform === 'win32'
      ? 'Windows WPS COM/jsaddons 尚未实测'
      : 'Linux 无 WPS 官方加载项等价能力' };
  }
  const dir = addonDir(opts);
  return { supported: dir.known, reason: dir.known ? '' : 'macOS WPS 加载项目录不存在' };
}

function openWithWps(filePath, opts = {}) {
  return Apps.openWithWps(filePath, opts);
}

module.exports = { candidates, addonDir, liveWriteSupported, openWithWps };
