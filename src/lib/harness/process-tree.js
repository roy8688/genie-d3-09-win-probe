'use strict';
/**
 * 进程树终止（D3-06）
 *
 * 只 kill 包装进程是不够的：`bash -lc "npm run build"` 被 kill 后，真正吃 CPU 的
 * 子进程还在。POSIX 用“独立进程组 + kill(-pid)”整组发信号；Windows 用
 * `taskkill /T /F`。调用方负责 spawn 时设 `detached: true`（POSIX），否则进程组
 * 不成立，本模块会退化为只杀直接子进程。
 */

const { spawnSync } = require('node:child_process');

function isWin() { return process.platform === 'win32'; }

/**
 * 平台无关的终止协议（D3-09）：Windows 必须 `/T /F` 连子孙一起杀，
 * POSIX 用负 pid 指向进程组。调用方只按这个描述执行，不在别处再写一份。
 */
function killSpec(platform, pid, signal) {
  const p = String(platform || process.platform);
  if (p === 'win32') {
    return { kind: 'taskkill', command: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] };
  }
  return { kind: 'group', pid: -Number(pid), signal: String(signal || 'SIGTERM') };
}

/**
 * 给一棵进程树发信号。POSIX 先杀整组，组不存在时退回直接子进程。
 * @param {import('node:child_process').ChildProcess} child
 * @param {'SIGTERM'|'SIGKILL'|'SIGINT'} [signal]
 * @returns {boolean} 是否至少成功发出一次信号
 */
function killTree(child, signal) {
  if (!child || !child.pid) return false;
  const sig = signal || 'SIGTERM';
  const spec = killSpec(process.platform, child.pid, sig);
  if (spec.kind === 'taskkill') {
    try {
      const r = spawnSync(spec.command, spec.args, { windowsHide: true, timeout: 5000 });
      if (r && r.status === 0) return true;
    } catch (_) {}
    try { child.kill(sig); return true; } catch (_) { return false; }
  }
  // detached spawn 后 child.pid 是进程组 id；负数表示整组。
  try { process.kill(spec.pid, spec.signal); return true; } catch (e) {
    try { child.kill(sig); return true; } catch (_) { return false; }
  }
}

/** 先 TERM，宽限后 KILL；返回 force timer（caller 可 unref/清理）。 */
function terminateTree(child, graceMs) {
  const grace = Math.max(0, Number(graceMs == null ? 1000 : graceMs));
  killTree(child, 'SIGTERM');
  const timer = setTimeout(() => { killTree(child, 'SIGKILL'); }, grace);
  if (timer.unref) timer.unref();
  return timer;
}

/** pid 是否还活着（EPERM 也算活着：存在但没权限发信号）。 */
function alive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

module.exports = { killTree, terminateTree, alive, isWin, killSpec };
