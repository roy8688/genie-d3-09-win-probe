'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const host = path.join(__dirname, '..', '..', 'src', 'lib', 'harness', 'conpty-host.ps1');
const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const exe = process.argv[2] || 'cmd.exe';
const inner = exe.toLowerCase().includes('cmd') ? ['/Q', '/K'] : ['-NoLogo', '-NoProfile', '-NoExit'];
const argsB64 = Buffer.from(inner.join('\n'), 'utf8').toString('base64');
const child = spawn(ps, ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',host,'-Exe',exe,'-Cwd',os.tmpdir(),'-ArgsB64',argsB64,'-Cols','120','-Rows','30'], {
  env: Object.assign({}, process.env, { GENIE_CONPTY_DEBUG: '1' }), stdio: ['pipe','pipe','pipe'], windowsHide: true,
});
let out = '';
child.stdout.on('data', d => out += d);
child.stderr.on('data', d => { out += d; });
child.on('exit', (c, s) => { console.log('DEBUG_RESULT exe=' + exe + ' exit=' + c + ' signal=' + s + '\n' + out); process.exit(0); });
setTimeout(() => { child.stdin.write('echo CONPTY_INPUT_OK\r\n'); }, 300);
setTimeout(() => { child.stdin.write("Write-Output 'CONPTY_PS_OK'\r\n"); }, 1200);
setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 6000);
