'use strict';
/**
 * D3-10 默认 shell（2026-11-24）
 *
 * 业务代码不许再写 `spawn('/bin/bash')`：Alpine/NixOS 可能没有 /bin/bash，
 * 用户也可能用 fish/zsh。这里按平台给出唯一口径：
 *   macOS  : $SHELL → /bin/zsh → /bin/bash
 *   Linux  : $SHELL → /bin/bash → /bin/sh
 *   Windows: $GENIE_PWSH_PATH → pwsh.exe → powershell.exe
 *
 * 注意：Windows 的单命令编码/退出码仍归 `harness/pwsh.js`；这里只回答“用哪个 shell、
 * 带什么参数”，不复制 UTF-16LE 逻辑。
 */

const fs = require('node:fs');
const path = require('node:path');

function envOf(opts) { return (opts && opts.env) || process.env; }
function existsFn(opts) { return (opts && opts.exists) || fs.existsSync; }

function firstExisting(candidates, exists) {
  for (const p of candidates) {
    if (!p) continue;
    try { if (exists(p)) return p; } catch (_) { /* 下一个 */ }
  }
  return '';
}

function defaultShell(opts = {}) {
  const platform = (opts && opts.platform) || process.platform;
  const env = envOf(opts);
  const exists = existsFn(opts);
  if (platform === 'win32') {
    const explicit = String(env.GENIE_PWSH_PATH || '').trim();
    if (explicit) return explicit;
    // PATH 里的 pwsh.exe 优先；没有则用系统自带 Windows PowerShell 的绝对路径。
    const dirs = String(env.PATH || '').split(';').filter(Boolean);
    for (const d of dirs) {
      const p = path.win32.join(d, 'pwsh.exe');
      try { if (exists(p)) return p; } catch (_) {}
    }
    const systemRoot = String(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows');
    return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }
  const home = String(env.HOME || env.USERPROFILE || '').trim();
  const fromEnv = String(env.SHELL || '').trim();
  if (fromEnv && fromEnv.startsWith('/')) return fromEnv;
  if (platform === 'darwin') {
    const hit = firstExisting(['/bin/zsh', '/bin/bash', '/bin/sh'], exists);
    if (hit) return hit;
  }
  const hit = firstExisting(['/bin/bash', '/bin/sh', '/usr/bin/bash', '/usr/bin/sh'], exists);
  if (hit) return hit;
  return home ? '/bin/sh' : '/bin/sh';
}

/**
 * 一条命令的 shell 描述。
 * @param {string} command
 * @param {{platform?:string, env?:object, exists?:Function, allowSubprocess?:boolean, winMode?:'encoded'|'plain'}} opts
 */
function shellSpec(command, opts = {}) {
  const platform = (opts && opts.platform) || process.platform;
  const allow = opts.allowSubprocess !== false;
  if (platform === 'win32') {
    const exe = defaultShell(opts);
    const mode = opts.winMode || 'plain';
    if (mode === 'encoded') {
      // 交由 pwsh.js 的 argsFor 生成；这里只报 shell 身份。
      return { kind: 'pwsh', command: exe, args: [], encoded: true };
    }
    return { kind: 'pwsh', command: exe, args: ['-NoProfile', '-NonInteractive', '-Command', String(command || '')], encoded: false };
  }
  return {
    kind: 'posix',
    command: defaultShell(opts),
    args: [allow ? '-lc' : '-c', String(command || '')],
    encoded: false,
  };
}

function loginArgs(opts = {}) {
  return [(opts && opts.allowSubprocess === false) ? '-c' : '-lc'];
}

module.exports = { defaultShell, shellSpec, loginArgs };
