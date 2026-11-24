'use strict';
/**
 * 持久终端 seam（D3-01，2026-11-23）
 *
 * 目标：同一终端会话连续执行 `cd`、`export`、前台命令不丢状态；输出可增量读，
 * 也能被 `job_*` 之外的第二条通道（交互式 stdin）继续喂输入。
 *
 * 实现边界（诚实说明）：
 *   · POSIX 优先用系统 `script(1)` 分配伪终端；没有 `script` 或启动失败时退回
 *     管道模式，并在 `snapshot().pty` 明确写 false，不把“管道”冒充成 PTY。
 *   · Windows 用持久 pwsh 进程 + 控制标记；ConPTY 需要额外原生依赖，本版不假装有。
 *   · 不用 node-pty：项目当前没有该依赖，为一个终端引入原生编译链会让
 *     “装不上就整个功能不可用”。先保证状态保留与可交互，PTY 能力按平台能力报。
 *
 * 输出协议：
 *   bash 的 `PROMPT_COMMAND` 在每次提示符前输出
 *   `ESC ]133;D;<exit>\BEL ESC ]133;P;<cwd>\BEL`
 *   exec 等待这一次新增标记，拿到真实退出码与当前目录；标记不会进入给模型看的正文。
 */

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Sandbox = require('./sandbox');
const Pwsh = require('./pwsh');
const WinPath = require('./win-path');
const ProcessTree = require('./process-tree');

const MAX_SESSIONS = 8;
const MAX_CHUNKS = 4000;
const MAX_BUFFER_BYTES = 256 * 1024;
const MAX_EXEC_OUTPUT = 64 * 1024;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

const sessions = new Map();
const owners = new Map();
let seq = 0;
let janitor = null;

const MARK_D = /\x1b\]133;D;([0-9-]+)\x07/g;
const MARK_P = /\x1b\]133;P;([^\x07]*)\x07/g;
const ANSI_OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(s) {
  return String(s || '')
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(/\r/g, '')
    .replace(/\u0000/g, '');
}

function cleanPtyText(s) {
  return stripAnsi(s)
    .replace(/^Last login:.*\n?/gm, '')
    .replace(/^The default interactive shell is now zsh\..*\n?/gm, '');
}

function byteCap(text, maxBytes) {
  const s = String(text || '');
  if (Buffer.byteLength(s) <= maxBytes) return { text: s, truncated: false };
  const chars = Array.from(s);
  let bytes = 0;
  let start = chars.length;
  while (start > 0) {
    const n = Buffer.byteLength(chars[start - 1]);
    if (bytes + n > maxBytes) break;
    bytes += n;
    start -= 1;
  }
  return { text: chars.slice(start).join(''), truncated: true };
}

function tailCap(text, maxBytes) {
  const r = byteCap(text, maxBytes);
  return r.truncated ? '（输出过长，只保留末尾）\n' + r.text : r.text;
}

function platform() {
  return process.platform === 'win32' ? 'win32' : process.platform;
}

function workspaceRoot(ws) {
  return String((ws && ws.path) || '');
}

function resolveCwd(workspace, input) {
  return resolveCwdFor(process.platform, workspace, input);
}

/**
 * D3-09：Windows 走 `path.win32` + 盘符/UNC/大小写规则；POSIX 仍用当前平台。
 * @param {string} platform
 * @param {{path?: string}} workspace
 * @param {string} input
 */
function resolveCwdFor(platformName, workspace, input) {
  const root = workspaceRoot(workspace);
  if (!root) throw Object.assign(new Error('没有活动工作区'), { code: 'NO_WORKSPACE' });
  if (!fs.existsSync(root)) throw Object.assign(new Error('工作区不存在：' + root), { code: 'NO_WORKSPACE' });
  const raw = String(input == null ? '' : input).trim() || '.';
  if (String(platformName || process.platform) === 'win32') {
    let abs;
    try {
      abs = WinPath.resolve(raw, root, { win32: true });
    } catch (e) {
      throw Object.assign(new Error('终端 cwd 必须是 Windows 绝对路径：' + raw), { code: 'TERMINAL_CWD_OUTSIDE' });
    }
    if (!WinPath.inside(root, abs)) throw Object.assign(new Error('终端 cwd 必须在工作区内：' + raw), { code: 'TERMINAL_CWD_OUTSIDE' });
    const checked = WinPath.exceedsMaxPath(abs) ? WinPath.extendedLength(abs) : abs;
    if (!fs.existsSync(checked)) throw Object.assign(new Error('终端 cwd 不存在：' + raw), { code: 'TERMINAL_CWD_MISSING' });
    return abs;
  }
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  if (!inside(root, abs)) throw Object.assign(new Error('终端 cwd 必须在工作区内：' + raw), { code: 'TERMINAL_CWD_OUTSIDE' });
  if (!fs.existsSync(abs)) throw Object.assign(new Error('终端 cwd 不存在：' + raw), { code: 'TERMINAL_CWD_MISSING' });
  return abs;
}

function isPwshShell(shell) {
  return /(?:^|[\\/])(pwsh|powershell)(?:\.exe)?$/i.test(String(shell || ''));
}

function inside(root, target) {
  if (!root || !target) return false;
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

/**
 * 真实 PTY：用系统 Python 的 `pty.fork()` 做桥。
 * 为什么不在 Node 里找 `script(1)`：macOS 的 script 要求自己的 stdin 是 TTY，
 * 从 Node 管道喂进去会直接 `tcgetattr: Operation not supported on socket` 退出。
 * 也不用 node-pty：原生模块要按 Electron ABI 重编译，装不上就整个终端不可用。
 */
const PTY_HELPER = String.raw`#!/usr/bin/env python3
import os, pty, select, signal, sys, time

child_pid = 0
kill_deadline = 0.0

def forward(signum, frame):
    global kill_deadline
    try:
        if child_pid:
            os.kill(child_pid, signum)
            kill_deadline = time.time() + 0.4
    except Exception:
        pass

for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGQUIT):
    try:
        signal.signal(sig, forward)
    except Exception:
        pass

pid, fd = pty.fork()
if pid == 0:
    try:
        os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
    except Exception as exc:
        sys.stderr.write(str(exc) + "\n")
        os._exit(127)
child_pid = pid
stdin_open = True
try:
    while True:
        readers = [fd]
        if stdin_open:
            readers.append(sys.stdin.buffer)
        timeout = 0.1 if kill_deadline else 0.5
        ready, _, _ = select.select(readers, [], [], timeout)
        if kill_deadline and time.time() > kill_deadline:
            try:
                os.kill(child_pid, signal.SIGKILL)
            except Exception:
                pass
            kill_deadline = 0.0
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        if stdin_open and sys.stdin.buffer in ready:
            try:
                data = sys.stdin.buffer.read1(4096)
            except Exception:
                data = b""
            if not data:
                stdin_open = False
            else:
                try:
                    os.write(fd, data)
                except OSError:
                    break
except KeyboardInterrupt:
    pass
try:
    _, status = os.waitpid(pid, 0)
except ChildProcessError:
    status = 0
if os.WIFEXITED(status):
    sys.exit(os.WEXITSTATUS(status))
if os.WIFSIGNALED(status):
    sys.exit(128 + os.WTERMSIG(status))
sys.exit(0)
`;

/**
 * D3-11 Windows ConPTY：用产品自带 conpty-host.ps1 调 CreatePseudoConsole。
 * 不引 node-pty / Python；宿主只转发 stdin/stdout，PowerShell 仍是原来的 pwsh。
 */
let _conptyProbe = null;
function windowsPowerShell() {
  const explicit = String(process.env.GENIE_POWERSHELL || '').trim();
  if (explicit) return explicit;
  const root = String(process.env.SystemRoot || 'C:\\Windows').trim();
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
function conptyHostPath() { return path.join(__dirname, 'conpty-host.ps1'); }
function b64Args(list) { return Buffer.from((list || []).join('\n'), 'utf8').toString('base64'); }
function conptyInvocation(shellExe, cwd, innerArgs) {
  return {
    command: windowsPowerShell(),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', conptyHostPath(),
      '-Exe', shellExe, '-Cwd', cwd, '-ArgsB64', b64Args(innerArgs), '-Cols', '120', '-Rows', '30'],
  };
}
function conptyRuntime() {
  if (_conptyProbe) return _conptyProbe;
  if (process.platform !== 'win32') {
    _conptyProbe = { ok: false, reason: 'ConPTY 只在 Windows 可用' };
    return _conptyProbe;
  }
  const host = conptyHostPath();
  if (!fs.existsSync(host)) {
    _conptyProbe = { ok: false, reason: 'ConPTY 宿主缺失：' + host, host };
    return _conptyProbe;
  }
  let shellExe = '';
  try {
    shellExe = Pwsh.resolvePwshPath({ configured: process.env.GENIE_PWSH_PATH || '', platform: 'win32' });
  } catch (_) {
    _conptyProbe = { ok: false, reason: 'ConPTY 探测失败：找不到 pwsh', host };
    return _conptyProbe;
  }
  try {
    const inv = conptyInvocation(shellExe, process.cwd(), ['-NoLogo', '-NoProfile', '-Command', 'exit 0']);
    const r = spawnSync(inv.command, inv.args, { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (!r.error && r.status === 0) {
      _conptyProbe = { ok: true, reason: 'ConPTY（CreatePseudoConsole）', host, shell: shellExe };
    } else {
      _conptyProbe = { ok: false, reason: 'ConPTY 探测失败：' + ((r.error && r.error.message) || ('exit=' + r.status + ' ' + String(r.stderr || '').slice(-300))), host, shell: shellExe };
    }
  } catch (e) {
    _conptyProbe = { ok: false, reason: 'ConPTY 探测异常：' + e.message, host, shell: shellExe };
  }
  return _conptyProbe;
}

let _ptyProbe = null;
function ptyRuntime() {
  if (_ptyProbe) return _ptyProbe;
  if (process.platform === 'win32') {
    _ptyProbe = conptyRuntime();
    return _ptyProbe;
  }
  let python = '';
  try {
    const r = spawnSync('python3', ['-c', 'import pty'], { encoding: 'utf8', timeout: 3000 });
    if (!r.error && r.status === 0) python = 'python3';
  } catch (_) {}
  if (!python && fs.existsSync('/usr/bin/python3')) {
    try {
      const r = spawnSync('/usr/bin/python3', ['-c', 'import pty'], { encoding: 'utf8', timeout: 3000 });
      if (!r.error && r.status === 0) python = '/usr/bin/python3';
    } catch (_) {}
  }
  if (!python) {
    _ptyProbe = { ok: false, python: '', reason: '本机没有可用的 python3 pty 支持，退回持久管道 shell' };
    return _ptyProbe;
  }
  try {
    const dir = path.join(os.tmpdir(), 'genie-harness');
    fs.mkdirSync(dir, { recursive: true });
    const helper = path.join(dir, 'terminal-pty-v1.py');
    fs.writeFileSync(helper, PTY_HELPER, { mode: 0o700 });
    _ptyProbe = { ok: true, python, helper, reason: 'python pty bridge' };
  } catch (e) {
    _ptyProbe = { ok: false, python: '', reason: 'PTY helper 写入失败：' + e.message };
  }
  return _ptyProbe;
}

function shellEnv(cwd, extra, shell) {
  const isPwsh = isPwshShell(shell);
  const env = Object.assign({}, process.env, {
    PATH: process.env.PATH || (process.platform === 'win32' ? '' : '/usr/local/bin:/usr/bin:/bin'),
    HOME: process.env.HOME || cwd,
    USERPROFILE: process.env.USERPROFILE || cwd,
    LANG: process.env.LANG || 'zh_CN.UTF-8',
    TERM: isPwsh ? 'dumb' : 'xterm-256color',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    NO_COLOR: '1',
    BASH_SILENCE_DEPRECATION_WARNING: '1',
    PS1: '',
    PROMPT_COMMAND: isPwsh ? '' : 'printf "\\033]133;D;%s\\007\\033]133;P;%s\\007" "$?" "$PWD"',
    POWERSHELL_TELEMETRY_OPTOUT: isPwsh ? '1' : process.env.POWERSHELL_TELEMETRY_OPTOUT,
    POWERSHELL_UPDATECHECK: isPwsh ? 'Off' : process.env.POWERSHELL_UPDATECHECK,
  }, extra || {});
  env.PWD = cwd;
  return env;
}

class TerminalSession {
  constructor(opts) {
    const o = opts || {};
    this.id = 'term-' + (++seq).toString(36);
    this.name = String(o.name || '');
    this.ownerKey = String(o.ownerKey || 'default');
    this.workspace = o.workspace || null;
    this.cwd = o.cwd;
    this.permission = String(o.permission || 'workspace-write');
    this.sandboxConfig = o.sandbox || null;
    this.shell = String(o.shell || (process.platform === 'win32' ? 'pwsh' : 'bash'));
    this.shellKind = isPwshShell(this.shell) ? 'pwsh' : 'posix';
    this.pty = false;
    this.conpty = false;
    this.child = null;
    this.status = { kind: 'running', since: Date.now() };
    this.exitCode = null;
    this.chunks = [];
    this.chunkSeq = 0;
    this.bytes = 0;
    this.promptSeq = 0;
    this.lastExit = 0;
    this.lastCwd = this.cwd;
    this._pending = '';
    this._waiters = new Set();
    this._bytesTruncated = false;
    this._closed = false;
    this._lastUsed = Date.now();
    this._startup = null;
    this._sandbox = null;
    this._sandboxMeta = null;
  }

  async start() {
    let env = shellEnv(this.cwd, null, this.shell);
    let command;
    let args;
    let windowsHide = false;
    if (this.shellKind === 'pwsh') {
      const configured = /[\\/]/.test(this.shell) ? this.shell : (process.env.GENIE_PWSH_PATH || '');
      command = Pwsh.resolvePwshPath({ configured, platform: process.platform });
      const probe = spawnSync(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      });
      if (probe.error || probe.status !== 0) {
        throw Object.assign(new Error('找不到可用的 PowerShell：' + command + '（设置 GENIE_PWSH_PATH 或安装 pwsh）'), {
          code: 'TERMINAL_PWSH_MISSING',
        });
      }
      const version = String(probe.stdout || '').trim();
      const conpty = conptyRuntime();
      if (conpty.ok) {
        const inner = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-Command', 'function global:prompt { "" }'];
        const inv = conptyInvocation(command, this.cwd, inner);
        command = inv.command;
        args = inv.args;
        this.pty = true;
        this.conpty = true;
        this.ptyReason = 'ConPTY（PowerShell ' + (version || '?') + '）';
      } else {
        args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'];
        this.pty = false;
        this.ptyReason = '持久 pwsh 管道（PowerShell ' + (version || '?') + '；' + conpty.reason + '）';
      }
      windowsHide = true;
    } else if (process.platform === 'win32') {
      command = this.shell;
      args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'];
      windowsHide = true;
    } else if (ptyRuntime().ok) {
      const ptyRt = ptyRuntime();
      command = ptyRt.python;
      args = [ptyRt.helper].concat(this.shell === 'bash'
        ? [this.shell, '--noprofile', '--norc', '-i']
        : [this.shell, '-i']);
      this.pty = true;
      this.ptyReason = ptyRt.reason;
    } else {
      command = this.shell;
      args = ['--noprofile', '--norc', '-s'];
    }

    // D3-04：长命 shell 同样先过沙箱。准备失败就不 spawn，snapshot 不会
    // 出现一个“自称 running、实际无限制”的终端。
    try {
      const policy = Sandbox.policyFor({
        permission: this.permission,
        workspaceRoot: (this.workspace && this.workspace.path) || this.cwd,
        config: this.sandboxConfig,
      });
      const wrapped = Sandbox.prepare({ command, args, cwd: this.cwd, env, policy });
      this._sandbox = wrapped;
      this._sandboxMeta = { backend: wrapped.backend, mode: wrapped.mode, enforced: wrapped.enforced };
      command = wrapped.command;
      args = wrapped.args;
      env = wrapped.env;
    } catch (e) {
      throw Object.assign(new Error('终端沙箱不可用，未启动：' + ((e && e.message) || e)), {
        code: (e && e.code) || 'SANDBOX_UNAVAILABLE',
      });
    }

    try {
      this.child = spawn(command, args, {
        cwd: this.cwd, env, windowsHide, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (this._sandbox) { try { this._sandbox.cleanup(); } catch (_) {} }
      throw Object.assign(new Error('终端启动失败：' + e.message), { code: 'TERMINAL_SPAWN_FAILED' });
    }
    this._bind();
    // pwsh 管道没有 bash 的提示符标记；进程起来即可接收 stdin，不必空等 3 秒。
    this._startup = this.shellKind === 'pwsh' ? Promise.resolve() : this._waitReady();
    await this._startup;
    return this;
  }

  _waitReady() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const timer = setTimeout(finish, 3000);
      timer.unref();
      this._readyResolve = () => { clearTimeout(timer); finish(); };
      if (this.promptSeq > 0 || this.status.kind !== 'running') this._readyResolve();
    });
  }

  _bind() {
    const onData = (d) => this._onData(d);
    this.child.stdout.on('data', onData);
    this.child.stderr.on('data', onData);
    this.child.on('error', (e) => {
      this._append('终端错误：' + e.message + '\n');
      this._setExit(null);
    });
    this.child.on('exit', (code, signal) => {
      this._setExit(code, signal);
      this._flushPending();
    });
    this.child.on('close', (code, signal) => {
      this._setExit(code, signal);
      this._flushPending();
    });
  }

  _setExit(code, signal) {
    if (this.status.kind === 'exited') return;
    if (this._sandbox) { try { this._sandbox.cleanup(); } catch (_) {} }
    this.exitCode = code;
    this.status = { kind: 'exited', exitCode: code, signal: signal || null, since: Date.now() };
    this._closed = true;
    for (const w of Array.from(this._waiters)) w.resolve({ reason: 'session_exit' });
    this._waiters.clear();
    if (typeof this._readyResolve === 'function') this._readyResolve();
    const rec = sessions.get(this.id);
    if (rec && rec.session === this) { /* 保留记录，terminal_list 可查退出码 */ }
  }

  _onData(d) {
    this._lastUsed = Date.now();
    this._pending += String(d || '');
    this._flushPending();
    if (this.promptSeq > 0 && typeof this._readyResolve === 'function') this._readyResolve();
  }

  _flushPending() {
    let text = this._pending;
    let consumed = 0;
    // 标记可能跨 chunk：只处理完整 BEL，尾部保留到下一次。
    const re = /\x1b\]133;(D|P);([^\x07]*)\x07/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const before = text.slice(consumed, m.index);
      if (before) this._append(cleanPtyText(before));
      consumed = m.index + m[0].length;
      if (m[1] === 'D') {
        const code = Number(m[2]);
        this.lastExit = Number.isFinite(code) ? code : 0;
        this.promptSeq += 1;
        for (const w of Array.from(this._waiters)) {
          // 只让“等这一次新提示符”的调用方醒来；启动期的旧标记不能提前结束 exec。
          if (!w.target || this.promptSeq >= w.target) {
            this._waiters.delete(w);
            w.resolve({ reason: 'prompt', code: this.lastExit, cwd: this.lastCwd });
          }
        }
      } else if (m[1] === 'P') {
        const cwd = String(m[2] || '').trim();
        if (cwd) { this.lastCwd = cwd; this.cwd = cwd; }
      }
    }
    this._pending = text.slice(consumed);
    this._flushPwshMarkers();
    // 没有标记的纯输出（交互式程序）也要及时给到 read；保留可能未闭合的 `ESC]133` 尾巴。
    let safe = this._cutPartialMarker(this._pending);
    safe = this._cutPartialPwshMarker(safe);
    if (safe) { this._append(cleanPtyText(safe)); this._pending = this._pending.slice(safe.length); }
    if (this.promptSeq > 0 && typeof this._readyResolve === 'function') this._readyResolve();
  }

  /**
   * D3-09 持久 pwsh 标记：START / CWD(base64) / END(exitCode)。
   * 命令正文走 base64，所以标记不会与用户输出里的 `$`/引号相撞；nonce 每个 exec 唯一。
   */
  _flushPwshMarkers() {
    const re = /__GENIE_PWSH_(START|END|CWD)_([0-9a-fA-F-]+)(?::([^\r\n_]*))?__\r?\n?/g;
    let consumed = 0;
    let m;
    while ((m = re.exec(this._pending)) !== null) {
      const before = this._pending.slice(consumed, m.index);
      if (before) this._append(cleanPtyText(before));
      consumed = m.index + m[0].length;
      if (m[1] === 'CWD') {
        try {
          const cwd = Buffer.from(String(m[3] || ''), 'base64').toString('utf8').trim();
          if (cwd) { this.lastCwd = cwd; this.cwd = cwd; }
        } catch (_) {}
      } else if (m[1] === 'END') {
        const code = Number(m[3]);
        this.lastExit = Number.isFinite(code) ? code : 1;
        this.promptSeq += 1;
        const nonce = m[2];
        for (const w of Array.from(this._waiters)) {
          if (w.marker === nonce) {
            this._waiters.delete(w);
            w.resolve({ reason: 'prompt', code: this.lastExit, cwd: this.lastCwd });
          }
        }
      }
    }
    if (consumed) this._pending = this._pending.slice(consumed);
  }

  _cutPartialPwshMarker(s) {
    const idx = String(s || '').lastIndexOf('__GENIE_PWSH_');
    return idx < 0 ? s : s.slice(0, idx);
  }

  _cutPartialMarker(s) {
    const idx = s.lastIndexOf('\x1b]133');
    if (idx >= 0 && !s.includes('\x07', idx)) return s.slice(0, idx);
    return s;
  }

  _append(text) {
    const clean = stripAnsi(text);
    if (!clean) return;
    this.chunkSeq += 1;
    this.chunks.push({ seq: this.chunkSeq, ts: Date.now(), text: clean });
    this.bytes += Buffer.byteLength(clean);
    while (this.bytes > MAX_BUFFER_BYTES && this.chunks.length > 1) {
      const old = this.chunks.shift();
      this.bytes -= Buffer.byteLength(old.text);
      this._bytesTruncated = true;
    }
    while (this.chunks.length > MAX_CHUNKS) {
      const old = this.chunks.shift();
      this.bytes -= Buffer.byteLength(old.text);
      this._bytesTruncated = true;
    }
  }

  writeRaw(text) {
    this._lastUsed = Date.now();
    if (this.status.kind !== 'running' || !this.child) {
      throw Object.assign(new Error('终端已退出，不能再写入'), { code: 'TERMINAL_EXITED' });
    }
    try { this.child.stdin.write(String(text || '')); } catch (e) {
      throw Object.assign(new Error('终端写入失败：' + e.message), { code: 'TERMINAL_WRITE_FAILED' });
    }
  }

  async exec(command, opts) {
    const o = opts || {};
    const cmd = String(command || '');
    if (!cmd.trim()) throw Object.assign(new Error('缺少 command'), { code: 'TERMINAL_COMMAND_REQUIRED' });
    if (cmd.length > 20000) throw Object.assign(new Error('命令过长'), { code: 'TERMINAL_COMMAND_TOO_LONG' });
    if (this.status.kind !== 'running') throw Object.assign(new Error('终端已退出'), { code: 'TERMINAL_EXITED' });
    if (this.shellKind === 'pwsh') return this._execPwsh(cmd, o);
    const timeoutMs = Math.min(Math.max(Number(o.timeoutMs || 120000), 1000), 600000);
    const signal = o.signal || null;
    const beforePrompt = this.promptSeq;
    const startSeq = this.chunkSeq;
    const started = Date.now();
    this.lastExit = null;
    this.writeRaw(cmd + (cmd.endsWith('\n') ? '' : '\n'));

    const wait = await new Promise((resolve) => {
      let done = false;
      let timer = null;
      let onAbort = null;
      const finish = (v) => {
        if (done) return;
        done = true;
        this._waiters.delete(w);
        if (timer) clearTimeout(timer);
        if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort); } catch (_) {} }
        resolve(v);
      };
      // D3-06：超时/取消不能只“不等了”然后把命令留在 PTY 里继续跑。
      // 向前台进程组发 Ctrl-C（SIGINT），让 sleep/build 真正停下；会话本身保留，
      // 用户的下一条命令仍然有 cwd/export。
      const interrupt = (reason) => {
        try { this.writeRaw('\x03'); } catch (_) {}
        finish({ reason });
      };
      const w = {
        target: beforePrompt + 1,
        resolve: finish,
      };
      this._waiters.add(w);
      timer = setTimeout(() => interrupt('timeout'), timeoutMs);
      timer.unref();
      if (signal) {
        onAbort = () => interrupt('abort');
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    const collected = this._collectSince(startSeq);
    const text = this._cleanExecText(collected.text, cmd);
    const capped = tailCap(text, Number(o.maxBytes || MAX_EXEC_OUTPUT));
    return {
      ok: wait.reason !== 'session_exit',
      waitReason: wait.reason,
      exitCode: wait.reason === 'prompt' ? wait.code : null,
      signal: null,
      cwd: this.lastCwd,
      pty: this.pty,
      durationMs: Date.now() - started,
      output: capped,
      truncated: capped.length < text.length || collected.truncated,
      promptSeq: this.promptSeq,
      seq: this.chunkSeq,
      sessionStatus: this.status,
    };
  }

  /**
   * D3-09：持久 pwsh 用“命令注入 + 三标记”协议。
   * 与 bash 的 OSC 提示符不同：这里不需要 PTY，命令结束标记里的退出码就是真实结果；
   * 超时直接杀整棵进程树（PowerShell 管道无法用 Ctrl-C 中断原生子进程）。
   */
  async _execPwsh(command, opts) {
    const o = opts || {};
    const timeoutMs = Math.min(Math.max(Number(o.timeoutMs || 120000), 1000), 600000);
    const signal = o.signal || null;
    const startSeq = this.chunkSeq;
    const started = Date.now();
    const nonce = crypto.randomUUID();
    let scriptPath = '';
    let invocation = '';
    this.lastExit = null;
    const wait = await new Promise((resolve) => {
      let done = false;
      let timer = null;
      let onAbort = null;
      const finish = (v) => {
        if (done) return;
        done = true;
        this._waiters.delete(w);
        if (timer) clearTimeout(timer);
        if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort); } catch (_) {} }
        resolve(v);
      };
      const interrupt = (reason) => {
        this._waiters.delete(w);
        ProcessTree.killTree(this.child, 'SIGKILL');
        this._setExit(null, 'SIGKILL');
        finish({ reason });
      };
      const w = { marker: nonce, resolve: finish };
      this._waiters.add(w);
      try {
        if (this.conpty) {
          const dir = path.join(os.tmpdir(), 'genie-harness');
          fs.mkdirSync(dir, { recursive: true });
          scriptPath = path.join(dir, 'run-' + nonce + '.ps1');
          fs.writeFileSync(scriptPath, Pwsh.persistentScript(command, nonce), { encoding: 'utf8', mode: 0o600 });
          invocation = "& '" + scriptPath.replace(/'/g, "''") + "'";
          this.writeRaw(invocation + '\n');
        } else {
          this.writeRaw(Pwsh.persistentScript(command, nonce) + '\n');
        }
      } catch (e) {
        finish({ reason: 'write_failed', error: e });
        return;
      }
      timer = setTimeout(() => interrupt('timeout'), timeoutMs);
      if (timer.unref) timer.unref();
      if (signal) {
        onAbort = () => interrupt('abort');
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    if (scriptPath) { try { fs.unlinkSync(scriptPath); } catch (_) {} }
    const collected = this._collectSince(startSeq);
    const text = this._cleanExecText(collected.text, invocation);
    const capped = tailCap(text, Number(o.maxBytes || MAX_EXEC_OUTPUT));
    return {
      ok: wait.reason === 'prompt' && wait.code === 0,
      waitReason: wait.reason,
      exitCode: wait.reason === 'prompt' ? wait.code : null,
      signal: wait.reason === 'timeout' || wait.reason === 'abort' ? 'SIGKILL' : null,
      cwd: this.lastCwd,
      pty: !!this.pty,
      durationMs: Date.now() - started,
      output: capped,
      truncated: capped.length < text.length || collected.truncated,
      promptSeq: this.promptSeq,
      seq: this.chunkSeq,
      sessionStatus: this.status,
      error: wait.error ? String(wait.error.message || wait.error) : null,
    };
  }

  _collectSince(fromSeq) {
    const list = this.chunks.filter((c) => c.seq > fromSeq);
    let text = list.map((c) => c.text).join('');
    const capped = tailCap(text, MAX_EXEC_OUTPUT * 2);
    return { text: capped, truncated: list.length > 0 && (this._bytesTruncated || text.length > MAX_EXEC_OUTPUT * 2) };
  }

  _cleanExecText(text, command) {
    let s = String(text || '').replace(/^Last login:.*\n?/gm, '');
    // pty 的回显有时带提示符/换行；去掉第一处与命令完全相同的一行。
    const lines = s.split('\n');
    const firstNonEmpty = lines.findIndex((l) => l.trim() !== '');
    if (firstNonEmpty >= 0 && lines[firstNonEmpty].trim() === command.trim()) lines.splice(firstNonEmpty, 1);
    s = lines.join('\n');
    return s.replace(/^\s*\n/, '');
  }

  write(text, opts) {
    const o = opts || {};
    const submit = o.submit !== false;
    this.writeRaw(String(text || '') + (submit ? '\n' : ''));
    return { ok: true, submitted: submit, seq: this.chunkSeq };
  }

  read(since, opts) {
    const o = opts || {};
    const from = Math.max(0, Number(since) || 0);
    const limit = Math.min(200, Math.max(1, Number(o.limit || 80)));
    const list = this.chunks.filter((c) => c.seq > from).slice(0, limit);
    const text = list.map((c) => c.text).join('');
    const capped = tailCap(text, Number(o.maxBytes || MAX_EXEC_OUTPUT));
    return {
      ok: true, chunks: list, text: capped, seq: this.chunkSeq,
      truncated: capped.length < text.length || (this._bytesTruncated && from === 0),
      pty: this.pty, status: this.status, cwd: this.lastCwd, exitCode: this.exitCode,
    };
  }

  kill(signal) {
    if (this.status.kind !== 'running' || !this.child) return { ok: true, already: true };
    const sig = ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP'].includes(String(signal)) ? String(signal) : 'SIGTERM';
    const pid = Number(this.child.pid);
    try {
      ProcessTree.killTree(this.child, sig);
    } catch (_) {
      try { this.child.kill(sig); } catch (_) {}
    }
    if (sig === 'SIGKILL') this._setExit(null, sig);
    return { ok: true, signal: sig, pid };
  }

  snapshot() {
    return {
      id: this.id, name: this.name, ownerKey: this.ownerKey,
      shell: this.shell, pty: this.pty, ptyReason: this.ptyReason || (this.pty ? 'pty' : ptyRuntime().reason), cwd: this.lastCwd,
      shellKind: this.shellKind, pwsh: this.shellKind === 'pwsh',
      status: this.status, exitCode: this.exitCode,
      seq: this.chunkSeq, promptSeq: this.promptSeq,
      createdAt: this.createdAt || null, lastUsedAt: this._lastUsed,
      sandbox: this._sandboxMeta || null,
    };
  }
}

function start(opts) {
  const o = opts || {};
  const workspace = o.workspace || null;
  const ownerKey = String(o.ownerKey || 'default');
  const ownerSet = owners.get(ownerKey) || new Set();
  if (ownerSet.size >= MAX_SESSIONS) {
    throw Object.assign(new Error('同一个会话最多同时开 ' + MAX_SESSIONS + ' 个终端'), { code: 'TERMINAL_LIMIT' });
  }
  const cwd = resolveCwd(workspace, o.cwd);
  const session = new TerminalSession({
    ownerKey, workspace, cwd,
    name: o.name,
    permission: o.permission,
    sandbox: o.sandbox,
    shell: o.shell || (process.platform === 'win32' ? 'pwsh' : 'bash'),
  });
  session.createdAt = Date.now();
  sessions.set(session.id, session);
  ownerSet.add(session.id);
  owners.set(ownerKey, ownerSet);
  return session.start().then(() => session.snapshot());
}

function getSession(id, ownerKey) {
  const s = sessions.get(String(id || ''));
  if (!s) throw Object.assign(new Error('没有这个终端：' + (id || '（空 id）')), { code: 'TERMINAL_NOT_FOUND' });
  if (ownerKey && s.ownerKey !== String(ownerKey)) {
    throw Object.assign(new Error('这个终端不属于当前会话'), { code: 'TERMINAL_NOT_OWNED' });
  }
  return s;
}

function latest(ownerKey) {
  const ids = Array.from(owners.get(String(ownerKey)) || []);
  if (!ids.length) return null;
  return sessions.get(ids[ids.length - 1]) || null;
}

function resolveSession(id, ownerKey) {
  if (id) return getSession(id, ownerKey);
  const s = latest(ownerKey);
  if (!s) throw Object.assign(new Error('当前会话还没有终端，请先 terminal_start'), { code: 'TERMINAL_NONE' });
  return s;
}

function list(ownerKey) {
  return Array.from(sessions.values())
    .filter((s) => !ownerKey || s.ownerKey === String(ownerKey))
    .map((s) => s.snapshot());
}

async function kill(id, ownerKey, signal) {
  const s = getSession(id, ownerKey);
  const r = s.kill(signal);
  // 给 shell/pty 桥 300ms 收尸，避免工具返回后马上 terminal_list 仍看到 running。
  if (!r.already) {
    const until = Date.now() + 700;
    while (s.status.kind === 'running' && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  return Object.assign({ id: s.id }, r, { status: s.status });
}

function closeOwner(ownerKey) {
  const ids = Array.from(owners.get(String(ownerKey)) || []);
  for (const id of ids) {
    const s = sessions.get(id);
    if (s) { try { s.kill('SIGTERM'); } catch (_) {} }
    sessions.delete(id);
  }
  owners.delete(String(ownerKey));
  return ids.length;
}

function shutdown() {
  for (const s of sessions.values()) { try { s.kill('SIGKILL'); } catch (_) {} }
  sessions.clear();
  owners.clear();
  if (janitor) { clearInterval(janitor); janitor = null; }
}

function startJanitor() {
  if (janitor) return;
  janitor = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (s.status.kind !== 'running') continue;
      if (now - s._lastUsed > IDLE_TIMEOUT_MS) {
        try { s.kill('SIGTERM'); } catch (_) {}
        sessions.delete(id);
        const set = owners.get(s.ownerKey);
        if (set) set.delete(id);
      }
    }
  }, 60 * 1000);
  janitor.unref();
}

startJanitor();

module.exports = {
  start, list, kill, closeOwner, shutdown, resolveSession, getSession,
  TerminalSession, stripAnsi, resolveCwd, resolveCwdFor, isPwshShell, ptyRuntime,
  MAX_SESSIONS, MAX_BUFFER_BYTES, MAX_EXEC_OUTPUT, IDLE_TIMEOUT_MS,
};
