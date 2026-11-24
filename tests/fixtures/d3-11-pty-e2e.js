'use strict';
/**
 * D3-11 三平台 PTY 真实 e2e（2026-11-24）
 *
 * POSIX：Python pty.fork() 真伪终端；Windows：conpty-host.ps1 → CreatePseudoConsole。
 * 不是“pty:true 字段”，必须拿到子进程自己的 TTY 判断：
 *   · POSIX  `test -t 0/1` + node `process.stdin.isTTY/process.stdout.isTTY`
 *   · Windows `[Console]::IsInputRedirected/IsOutputRedirected` + node 同上
 * 另测持久状态（cwd/env 跨 exec）与真实超时终止。
 * 输出 D3_11_PTY_RESULT {...}；失败直接非 0。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Terminal = require('../../src/lib/harness/terminal');
const Platform = require('../../src/lib/platform');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-d3-11-pty-'));
  const out = { platform: process.platform, checked: [], discovered: {} };
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash';
  const started = await Terminal.start({
    shell, workspace: { path: ws }, cwd: '', permission: 'full', ownerKey: 'd3-11-pty',
  });
  const s = Terminal.getSession(started.id);
  try {
    const snap = s.snapshot();
    assert.equal(snap.pty, true, 'PTY 必须为 true：' + snap.ptyReason);
    out.discovered.snapshot = { shell: snap.shell, pty: snap.pty, ptyReason: snap.ptyReason, sandbox: snap.sandbox };
    if (process.platform === 'win32') assert.match(snap.ptyReason, /ConPTY|PseudoConsole/);
    out.checked.push('pty-flag');

    const ttyCmd = process.platform === 'win32'
      ? '[Console]::IsInputRedirected; [Console]::IsOutputRedirected; node -e "console.log(\'TTY_IN=\'+process.stdin.isTTY+\' TTY_OUT=\'+process.stdout.isTTY)"'
      : 'test -t 0 && echo STDIN_IS_TTY; test -t 1 && echo STDOUT_IS_TTY; node -e "console.log(\'TTY_IN=\'+process.stdin.isTTY+\' TTY_OUT=\'+process.stdout.isTTY)"';
    const tty = await s.exec(ttyCmd, { timeoutMs: 30000 });
    assert.equal(tty.exitCode, 0, 'TTY 检查命令必须成功：' + tty.output);
    out.discovered.tty = { waitReason: tty.waitReason, exitCode: tty.exitCode, output: tty.output.trim() };
    if (process.platform === 'win32') {
      assert.match(tty.output, /False\s*\nFalse/, 'Windows ConPTY 子进程输入/输出都不应是 redirected：' + tty.output);
    } else {
      assert.match(tty.output, /STDIN_IS_TTY/);
      assert.match(tty.output, /STDOUT_IS_TTY/);
    }
    assert.match(tty.output, /TTY_IN=true/);
    assert.match(tty.output, /TTY_OUT=true/);
    out.checked.push('tty-truth');

    if (process.platform === 'win32') {
      const size = await s.exec('[Console]::WindowWidth; [Console]::WindowHeight', { timeoutMs: 30000 });
      assert.equal(size.exitCode, 0, '窗口尺寸读取失败：' + size.output);
      assert.match(size.output, /120/, 'ConPTY 宽度必须是 120：' + size.output);
      out.discovered.window = size.output.trim();
      out.checked.push('conpty-size');
    }

    // 同一会话跨 exec 保留 cwd 与 env。
    const setCmd = process.platform === 'win32'
      ? "cd '" + ws.replace(/'/g, "''") + "'; $env:GENIE_PTY_TEST='d3-11'"
      : 'cd ' + JSON.stringify(ws) + ' && export GENIE_PTY_TEST=d3-11';
    const set = await s.exec(setCmd, { timeoutMs: 30000 });
    assert.equal(set.exitCode, 0, '设置 cwd/env 失败：' + set.output);
    const read = await s.exec(process.platform === 'win32'
      ? 'Write-Output ((Get-Location).Path + "|" + $env:GENIE_PTY_TEST)'
      : 'pwd; echo "$GENIE_PTY_TEST"', { timeoutMs: 30000 });
    assert.equal(read.exitCode, 0, '读取 cwd/env 失败：' + read.output);
    assert.ok(read.output.includes('d3-11'), 'env 必须跨 exec 保留：' + read.output);
    out.discovered.persist = { output: read.output.trim() };
    out.checked.push('persistent-cwd-env');

    // 新会话真实超时：命令必须被杀掉，不是只“不等了”。
    const started2 = await Terminal.start({
      shell, workspace: { path: ws }, cwd: '', permission: 'full', ownerKey: 'd3-11-timeout',
    });
    const s2 = Terminal.getSession(started2.id);
    try {
      const slow = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
      const t0 = Date.now();
      const r = await s2.exec(slow, { timeoutMs: 1500 });
      assert.equal(r.waitReason, 'timeout', '超时必须返回 timeout：' + r.waitReason);
      if (process.platform === 'win32') {
        assert.equal(s2.snapshot().status.kind, 'exited', 'Windows 超时必须杀掉整个终端');
      } else {
        assert.equal(s2.snapshot().status.kind, 'running', 'POSIX 超时只杀前台命令，会话必须保留');
        const probe = await s2.exec("pgrep -fl '[s]leep 30' || true", { timeoutMs: 30000 });
        assert.ok(!/sleep 30/.test(probe.output), '超时后 sleep 不能被留在后台：' + probe.output);
      }
      out.discovered.timeout = { waitReason: r.waitReason, durationMs: Date.now() - t0, status: s2.snapshot().status };
      out.checked.push('timeout-kill');
    } finally {
      Terminal.kill(s2.id, 'd3-11-timeout', 'SIGKILL');
    }
  } finally {
    try { Terminal.kill(s.id, 'd3-11-pty', 'SIGKILL'); } catch (_) {}
    fs.rmSync(ws, { recursive: true, force: true });
    Terminal.shutdown();
  }
  await sleep(50);
  console.log('D3_11_PTY_RESULT ' + JSON.stringify(out));
}

main().catch((e) => {
  console.error('D3_11_PTY_FAIL ' + (e && e.stack || e));
  process.exit(1);
});
