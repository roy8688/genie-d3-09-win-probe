'use strict';
/* Windows 内置沙箱 runner 的真实端到端验收（在真实 win32 上运行）。
 * 只断言磁盘事实与进程事实，不看“接口返回 ok”。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Sandbox = require('../src/lib/harness/sandbox');

function mk(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), label));
}

function clean(...dirs) {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('WIN_E2E_PLATFORM:' + process.platform);
  const ws = mk('genie-win-e2e-');
  const outside = mk('genie-win-out-');
  const outFile = path.join(outside, 'outside.txt');
  const survivor = path.join(ws, 'survivor.txt');
  const policy = Sandbox.policyFor({ permission: 'workspace-write', workspaceRoot: ws, tempWrite: false });
  const prepared = Sandbox.prepare({ command: 'cmd.exe', args: ['/c', 'echo ok'], cwd: ws, policy });
  const facts = {
    runner: Sandbox.defaultWindowsRunner(),
    backend: prepared.backend,
    command: prepared.command,
    hasFile: prepared.args.includes('-File'),
    runnerArg: prepared.args.find((x) => String(x).endsWith('win-sandbox-runner.ps1')) || '',
  };
  if (facts.runner) {
    const inside = await Sandbox.run({
      command: 'cmd.exe', args: ['/c', 'echo inside> inside.txt'], cwd: ws, policy, timeoutMs: 30000,
    });
    const outsideRun = await Sandbox.run({
      command: 'powershell.exe',
      args: ['-NoProfile', '-Command', "[IO.File]::WriteAllText('" + outFile.replace(/'/g, "''") + "', 'outside')"],
      cwd: ws, policy, timeoutMs: 30000,
    });
    const timed = await Sandbox.run({
      command: 'powershell.exe',
      args: ['-NoProfile', '-Command', "Start-Sleep -Seconds 30; [IO.File]::WriteAllText('survivor.txt', 'survived')"],
      cwd: ws, policy, timeoutMs: 1000,
    });
    await new Promise((r) => setTimeout(r, 2500));
    facts.inside = { exitCode: inside.exitCode, file: fs.existsSync(path.join(ws, 'inside.txt')), stderr: inside.stderr.slice(0, 200) };
    facts.outside = { exitCode: outsideRun.exitCode, file: fs.existsSync(outFile), denied: outsideRun.denied, stderr: outsideRun.stderr.slice(0, 200) };
    facts.timeout = { timedOut: timed.timedOut, exitCode: timed.exitCode, survivor: fs.existsSync(survivor) };
  }
  console.log('WIN_E2E_RESULT ' + JSON.stringify(facts));
  if (!facts.runner) throw new Error('WIN_E2E_NO_DEFAULT_RUNNER');
  if (facts.backend !== 'windows-runner' || !facts.hasFile || !facts.runnerArg) throw new Error('WIN_E2E_PREPARE');
  if (facts.inside.exitCode !== 0 || !facts.inside.file) throw new Error('WIN_E2E_INSIDE');
  if (facts.outside.exitCode === 0 || facts.outside.file) throw new Error('WIN_E2E_OUTSIDE');
  if (!facts.timeout.timedOut || facts.timeout.survivor) throw new Error('WIN_E2E_JOB');
  clean(ws, outside);
}
main().catch((e) => { console.error('WIN_E2E_FAIL ' + e.message); process.exitCode = 1; });
