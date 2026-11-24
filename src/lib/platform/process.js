'use strict';
/**
 * D3-10 进程存活与进程树（2026-11-24）
 *
 * `process.kill(pid, 0)` 在三个平台都能用，但它只能回答“这个 pid 还能被投信号”。
 * 僵尸进程的 pid 也还能投信号，所以 macOS/Linux 再查 `ps -o stat=` 的 Z/X 状态。
 * Windows 没有僵尸，但 pid 可能被复用，用 `tasklist /FI "PID eq N"` 确认该 pid 真的在表里。
 *
 * 这里不吞掉“ps/tasklist 不可用”：那会让活进程被误判成死，然后锁被抢。
 * 工具缺失时返回活着（保守），并给出 `checked:false` 供调用方记录。
 */

const { spawnSync } = require('node:child_process');
const ProcessTree = require('../harness/process-tree');

function execFileSyncFn(opts) {
  if (opts && typeof opts.execFileSync === 'function') return opts.execFileSync;
  return require('node:child_process').execFileSync;
}

/**
 * @returns {{alive:boolean, checked:boolean, state?:string}}
 */
function probeProcess(pid, opts = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return { alive: false, checked: true, state: 'invalid-pid' };
  let alive = false;
  try {
    process.kill(n, 0);
    alive = true;
  } catch (e) {
    // EPERM = 进程存在但不属于当前用户，算活着。
    alive = !!(e && e.code === 'EPERM');
  }
  if (!alive) return { alive: false, checked: true, state: 'gone' };

  const platform = (opts && opts.platform) || process.platform;
  const exec = execFileSyncFn(opts);
  if (platform === 'win32') {
    try {
      const out = exec('tasklist', ['/FI', 'PID eq ' + n, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8', timeout: 1500, windowsHide: true,
      }).trim();
      if (!out || /^INFO:/i.test(out)) return { alive: false, checked: true, state: 'gone' };
      return { alive: true, checked: true, state: 'running' };
    } catch (_) {
      return { alive: true, checked: false, state: 'unknown' };
    }
  }
  try {
    // 不写 /bin/ps：NixOS 等发行版没有 /bin/ps，但 PATH 里有。
    const out = exec('ps', ['-o', 'stat=', '-p', String(n)], {
      encoding: 'utf8', timeout: 1500,
    }).trim();
    if (out && (out.startsWith('Z') || out.startsWith('X'))) {
      return { alive: false, checked: true, state: 'zombie' };
    }
    return { alive: true, checked: true, state: out || 'running' };
  } catch (_) {
    return { alive: true, checked: false, state: 'unknown' };
  }
}

function isProcessAlive(pid, opts = {}) {
  return probeProcess(pid, opts).alive;
}

/**
 * 按平台执行进程树终止；Windows 是 taskkill /T /F，POSIX 是负 pid 进程组。
 * @returns {{ok:boolean, command?:string, args?:string[], error?:string}}
 */
function killTree(pid, opts = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: '非法 pid' };
  const spec = ProcessTree.killSpec((opts && opts.platform) || process.platform, n);
  const spawn = (opts && opts.spawnSync) || spawnSync;
  try {
    if (spec.kind === 'taskkill') {
      const r = spawn(spec.command, spec.args, { windowsHide: true, timeout: 5000 });
      return { ok: !!(r && r.status === 0), command: spec.command, args: spec.args };
    }
    const kill = (opts && typeof opts.kill === 'function') ? opts.kill : process.kill;
    kill(spec.pid, spec.signal);
    return { ok: true, command: 'kill', args: [String(spec.pid), spec.signal] };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

module.exports = { probeProcess, isProcessAlive, killTree };
