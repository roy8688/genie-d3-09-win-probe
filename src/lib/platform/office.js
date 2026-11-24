'use strict';
/**
 * D3-10 Office / Ollama 可执行探测（2026-11-24）
 *
 * LibreOffice 与 Ollama 的安装位三平台不同，业务代码不许各写一份。
 * 口径与浏览器一致：显式配置 → PATH → 平台默认位。找不到返回 ''。
 */

const fs = require('node:fs');
const path = require('node:path');

function envOf(opts) { return (opts && opts.env) || process.env; }
function existsFn(opts) { return (opts && opts.exists) || fs.existsSync; }
function platformOf(opts) { return (opts && opts.platform) || process.platform; }
function homeOf(opts) { return (opts && opts.home) || envOf(opts).HOME || envOf(opts).USERPROFILE || require('node:os').homedir(); }

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

function firstExisting(list, exists) {
  for (const p of list) {
    if (!p) continue;
    try { if (exists(p)) return p; } catch (_) { /* 下一个 */ }
  }
  return '';
}

function sofficeCandidates(opts = {}) {
  const platform = platformOf(opts);
  const env = envOf(opts);
  const home = homeOf(opts);
  if (platform === 'darwin') {
    return ['/Applications/LibreOffice.app/Contents/MacOS/soffice'].concat(pathCandidates(['soffice'], env, platform));
  }
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    return [
      path.win32.join(programFiles, 'LibreOffice', 'program', 'soffice.exe'),
      path.win32.join(programFilesX86, 'LibreOffice', 'program', 'soffice.exe'),
      path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'Programs', 'LibreOffice', 'program', 'soffice.exe'),
    ].concat(pathCandidates(['soffice.exe', 'soffice'], env, platform));
  }
  return ['/usr/bin/soffice', '/usr/lib/libreoffice/program/soffice', '/usr/local/bin/soffice']
    .concat(pathCandidates(['soffice', 'libreoffice'], env, platform));
}

function findSoffice(opts = {}) {
  const configured = String(opts.configured || '').trim();
  if (configured && existsFn(opts)(configured)) return configured;
  const env = envOf(opts);
  const fromEnv = String(env.GENIE_SOFFICE_PATH || '').trim();
  if (fromEnv && existsFn(opts)(fromEnv)) return fromEnv;
  return firstExisting(sofficeCandidates(opts), existsFn(opts));
}

/** 本机 Ollama 可执行；内嵌引擎由 embedded-assets 先行，不在这里重复搬模型。 */
function findOllama(opts = {}) {
  const env = envOf(opts);
  const exists = existsFn(opts);
  const platform = platformOf(opts);
  const home = homeOf(opts);
  const configured = String(opts.configured || env.GENIE_OLLAMA_BIN || '').trim();
  if (configured && exists(configured)) return configured;
  const list = [];
  if (platform === 'darwin') {
    list.push(path.join(home, '.local', 'bin', 'ollama'));
    list.push('/opt/homebrew/bin/ollama', '/usr/local/bin/ollama');
    list.push('/Applications/Ollama.app/Contents/Resources/ollama');
  } else if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    list.push(path.win32.join(local, 'Programs', 'Ollama', 'ollama.exe'));
    list.push(path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'Ollama', 'ollama.exe'));
  } else {
    list.push(path.join(home, '.local', 'bin', 'ollama'));
    list.push('/usr/local/bin/ollama', '/usr/bin/ollama', '/opt/ollama/bin/ollama');
  }
  const hit = firstExisting(list, exists);
  if (hit) return hit;
  const names = platform === 'win32' ? ['ollama.exe'] : ['ollama'];
  return firstExisting(pathCandidates(names, env, platform), exists);
}

module.exports = { sofficeCandidates, findSoffice, findOllama };
