'use strict';
// D3-11 诊断：在 ConPTY 子进程里直接查询 stdin 是否真的是控制台。
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const host = path.join(__dirname, '..', '..', 'src', 'lib', 'harness', 'conpty-host.ps1');
const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const exe = process.argv[2] || 'pwsh.exe';
const inner = [
  '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
  [
    "Add-Type -Name C -Namespace W -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetStdHandle(int n); [DllImport(\"kernel32.dll\")] public static extern bool GetConsoleMode(IntPtr h, out uint m);'",
    "$h=[W.C]::GetStdHandle(-10); $m=0; $ok=[W.C]::GetConsoleMode($h,[ref]$m)",
    "Write-Output ('PROBE_REDIRECTED=' + [Console]::IsInputRedirected + ' H=' + $h + ' GETMODE=' + $ok + ' MODE=' + $m)",
  ].join('; '),
];
const argsB64 = Buffer.from(inner.join('\n'), 'utf8').toString('base64');
const child = spawn(ps, ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',host,'-Exe',exe,'-Cwd',os.tmpdir(),'-ArgsB64',argsB64,'-Cols','120','-Rows','30'], {
  env: Object.assign({}, process.env, { GENIE_CONPTY_DEBUG: '1' }), stdio: ['pipe','pipe','pipe'], windowsHide: true,
});
let out = '';
child.stdout.on('data', d => out += d);
child.stderr.on('data', d => out += d);
child.on('exit', (c, s) => { console.log('PROBE_RESULT exit=' + c + ' signal=' + s + '\n' + out); process.exit(0); });
setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 8000);
