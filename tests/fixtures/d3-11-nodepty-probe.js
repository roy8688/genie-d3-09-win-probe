'use strict';
// D3-11 对照探针：用 node-pty（Windows 上走 ConPTY）验证 runner 会话是否支持真 PTY。
const pty = require('node-pty');
const p = pty.spawn(process.env.ComSpec || 'cmd.exe', [], { cols: 120, rows: 30, cwd: process.cwd(), env: process.env });
let out = '';
p.onData(d => { out += d; });
p.onExit(e => { console.log('NODEPTY_EXIT ' + JSON.stringify(e) + '\n' + out); process.exit(0); });
setTimeout(() => { try { p.write('echo NODEPTY_INPUT_OK\r\n'); } catch (e) { console.error(e); } }, 1200);
setTimeout(() => { try { p.kill(); } catch (_) {} }, 6000);
setTimeout(() => { console.log('NODEPTY_TIMEOUT\n' + out); process.exit(1); }, 9000);
