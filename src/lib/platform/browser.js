'use strict';
/**
 * D3-10 浏览器可执行探测（2026-11-24）
 *
 * 唯一入口：配置 → 环境变量 → PATH → 平台默认安装位。
 * 业务代码不许再写 `/Applications/Google Chrome.app/...`。
 * 找不到返回 ''，由调用方给出「未找到 Chrome」的中性提示，不静默跑空。
 */

const fs = require('node:fs');
const path = require('node:path');

function envOf(opts) { return (opts && opts.env) || process.env; }
function existsFn(opts) { return (opts && opts.exists) || fs.existsSync; }
function platformOf(opts) { return (opts && opts.platform) || process.platform; }
function homeOf(opts) { return (opts && opts.home) || envOf(opts).HOME || envOf(opts).USERPROFILE || require('node:os').homedir(); }

const MAC = {
  chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  chromium: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
  edge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  brave: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
};

const WIN_EXE = {
  chrome: ['Google\\Chrome\\Application\\chrome.exe'],
  chromium: ['Chromium\\Application\\chrome.exe'],
  edge: ['Microsoft\\Edge\\Application\\msedge.exe'],
  brave: ['BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
};

const LINUX = {
  chrome: ['google-chrome', 'google-chrome-stable'],
  chromium: ['chromium', 'chromium-browser'],
  edge: ['microsoft-edge', 'microsoft-edge-stable'],
  brave: ['brave-browser', 'brave'],
};

function windowsCandidates(kind, env, home, platform) {
  const out = [];
  const push = (p) => { if (p) out.push(p); };
  const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  for (const rel of (WIN_EXE[kind] || [])) {
    push(path.win32.join(programFiles, rel));
    push(path.win32.join(programFilesX86, rel));
    push(path.win32.join(local, rel));
  }
  return out;
}

function pathCandidates(names, env, platform) {
  const out = [];
  const sep = platform === 'win32' ? ';' : path.delimiter;
  const dirs = String(env.PATH || '').split(sep).filter(Boolean);
  for (const name of names) {
    if (path.isAbsolute(name)) { out.push(name); continue; }
    for (const d of dirs) out.push(path.join(d, name));
  }
  return out;
}

/** 返回该浏览器在该平台的候选路径（未做存在性过滤）。 */
function candidates(kind = 'chrome', opts = {}) {
  const platform = platformOf(opts);
  const env = envOf(opts);
  const home = homeOf(opts);
  if (platform === 'darwin') return (MAC[kind] || []).slice();
  if (platform === 'win32') return windowsCandidates(kind, env, home, platform);
  return pathCandidates(LINUX[kind] || [], env, platform);
}

function firstExisting(list, exists) {
  for (const p of list) {
    if (!p) continue;
    try { if (exists(p)) return p; } catch (_) { /* 下一个 */ }
  }
  return '';
}

/**
 * @param {{name?:'chrome'|'chromium'|'edge'|'brave', configured?:string, env?:object, platform?:string, exists?:Function}} opts
 * @returns {string} 可执行绝对路径；找不到为 ''
 */
function findBrowserBinary(opts = {}) {
  const env = envOf(opts);
  const exists = existsFn(opts);
  const configured = String(opts.configured || '').trim();
  if (configured && exists(configured)) return configured;
  const fromEnv = String(env.GENIE_CHROME_BIN || env.GENIE_BROWSER_BIN || '').trim();
  if (fromEnv && exists(fromEnv)) return fromEnv;

  const primary = opts.name || 'chrome';
  const order = [primary, 'chromium', 'edge', 'brave'].filter((x, i, a) => a.indexOf(x) === i);
  for (const kind of order) {
    const hit = firstExisting(candidates(kind, opts), exists);
    if (hit) return hit;
  }
  return '';
}

module.exports = { candidates, findBrowserBinary };
