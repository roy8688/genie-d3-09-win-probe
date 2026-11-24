'use strict';
/**
 * D3-10 平台适配层真实 e2e（可在 macOS / Windows / Linux 上直接跑）
 *
 * 只验证“当前平台真的能走通”的路径：数据/日志根、shell 真执行、进程存活、进程树终止、
 * 浏览器/Office 探测结果。对话框/GUI 在无桌面 CI 中明确 skip，不伪造。
 *
 * 输出一行 `D3_10_PLATFORM_RESULT {...}`，供 Actions 断言。
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const Platform = require('../../src/lib/platform');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const out = { platform: process.platform, checked: [], skipped: [], discovered: {} };

  const p = Platform.paths.describe();
  assert.ok(p.dataRoot && p.dataRoot.length > 0, 'dataRoot 不能为空');
  assert.ok(p.logRoot && p.logRoot.length > 0, 'logRoot 不能为空');
  if (process.platform === 'darwin') {
    assert.match(p.dataRoot, /Library[\\/]Application Support[\\/]Genie/);
  } else if (process.platform === 'win32') {
    assert.match(p.dataRoot, /Genie$/i);
  } else {
    assert.match(p.dataRoot, /[\\/]genie$/);
  }
  out.checked.push('paths');
  out.discovered.paths = p;

  // 真实 shell 执行：echo 一行，拿真实退出码与 stdout。
  const spec = Platform.shell.shellSpec('echo d3-10-shell-ok');
  const r = await new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, command: spec.command }));
  });
  assert.equal(r.code, 0, 'shell 退出码必须为 0: ' + r.stderr);
  assert.match(r.stdout, /d3-10-shell-ok/);
  out.checked.push('shell');
  out.discovered.shell = { command: r.command, args: spec.args, stdout: r.stdout.trim() };

  // 当前进程必须被判活着。
  assert.equal(Platform.process.isProcessAlive(process.pid), true);
  out.checked.push('process-alive');

  // 真实进程树终止：起一个长命子进程，Platform.process.killTree 后必须不在。
  const child = process.platform === 'win32'
    ? spawn('ping.exe', ['-n', '31', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' })
    : spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  await sleep(400);
  assert.equal(Platform.process.isProcessAlive(child.pid), true, '子进程应先活着');
  const killed = Platform.process.killTree(child.pid);
  assert.equal(killed.ok, true, '进程树终止必须成功');
  let alive = true;
  for (let i = 0; i < 12; i++) {
    await sleep(250);
    alive = Platform.process.isProcessAlive(child.pid);
    if (!alive) break;
  }
  assert.equal(alive, false, '进程树终止后子进程必须消失');
  out.checked.push('process-tree');

  // 浏览器/Office 只探测，不要求 CI 一定装有：找不到时把空结果如实上报。
  out.discovered.browser = Platform.browser.findBrowserBinary({ name: 'chrome' }) || '';
  out.discovered.soffice = Platform.office.findSoffice() || '';
  out.discovered.ollama = Platform.office.findOllama() || '';
  out.checked.push('browser-office-probe');

  // WPS：三平台声明必须一致，不能把未实测写成支持。
  const wps = Platform.wps.liveWriteSupported();
  out.discovered.wps = wps;
  if (process.platform !== 'darwin') assert.equal(wps.supported, false);
  out.checked.push('wps-degradation');
  out.discovered.fonts = { cjk: Platform.fonts.cjk(), stack: Platform.fonts.stack() };
  assert.ok(out.discovered.fonts.cjk, 'CJK 字体不能为空');
  out.checked.push('fonts');

  // 无桌面环境不弹原生对话框、不做 GUI 截图；这是明确 skip，不是通过。
  out.skipped.push({ item: 'native-dialog', reason: 'CI 无交互桌面，弹窗会挂起' });
  out.skipped.push({ item: 'gui-screenshot', reason: 'CI 无交互桌面/截图工具不保证存在' });

  console.log('D3_10_PLATFORM_RESULT ' + JSON.stringify(out));
}

main().catch((e) => {
  console.error('D3_10_PLATFORM_FAIL ' + (e && e.stack || e));
  process.exitCode = 1;
});
