'use strict';
/**
 * D3-04 进程沙箱 seam（2026-11-23）
 *
 * 这里只做三件事：把“一次调用允许什么”变成确定的 policy；把 policy 翻译成
 * 当前平台的执行前缀；在执行前确认前缀真的可用。**任何一步失败都必须阻断**，
 * 绝不把命令退化成无沙箱直跑——那会让“沙箱坏了”看起来只是“命令偶尔失败”。
 *
 * 平台链：
 *  · macOS：`sandbox-exec`（Seatbelt/SBPL）；写白名单 + 可选网络/子进程拒绝；
 *  · Linux：`bwrap`（只读根 + 可写 bind + 可选 `--unshare-net`）；
 *  · Windows：外部受限令牌 runner（`--workspace --temp --mode -- argv...`）；
 *    runner 缺失即 `SANDBOX_UNAVAILABLE`，不在本层假装 ACL/Job 已生效。
 *
 * 已知边界（不写成“全隔离”）：
 *  · 读侧不隔离：Seatbelt 只拦写入，bwrap 允许读根；执行命令需要系统库；
 *  · Linux 无法只靠 bwrap 拒绝 fork，`allowSubprocess=false` 会明确不支持；
 *  · Windows 的网络/读侧由 runner 能力决定，本层只透传 policy；
 *  · `danger-full-access` 是用户显式选择，返回 `enforced:false`，不伪装成沙箱。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

let paths = null;
try { paths = require('../paths'); } catch (_) { paths = null; }

const MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access']);
const ENFORCED_BACKENDS = Object.freeze(['seatbelt', 'bwrap', 'windows-runner']);
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_PROFILE_PATH = 4096;
const PROBE_TTL_MS = 60 * 1000;

const DEFAULTS = Object.freeze({
  schemaVersion: 1,
  defaultMode: 'auto',
  network: false,
  allowExec: true,
  allowSubprocess: true,
  tempWrite: true,
  extraWritableRoots: [],
  windowsRunner: '',
});

const DENIAL_SIGNATURES = Object.freeze({
  seatbelt: ['operation not permitted'],
  bwrap: ['read-only file system', 'permission denied'],
  'windows-runner': ['access is denied', 'permission denied', 'operation not permitted'],
});

const probeCache = new Map();
let configCache = null;

class SandboxError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'SandboxError';
    this.code = code || 'SANDBOX_ERROR';
    this.details = details || null;
  }
}

function fail(message, code, details) {
  throw new SandboxError(message, code, details);
}

function configPath() {
  const fromEnv = String(process.env.GENIE_SANDBOX_CONFIG || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  const root = (paths && paths.config) || path.resolve(__dirname, '../../../config');
  return path.join(root, 'sandbox.json');
}

/** Windows 内置 runner 是产品资产，不是测试探针；只在真实 win32 上兜底。 */
function defaultWindowsRunner() {
  if (process.platform !== 'win32') return '';
  const runner = path.join(__dirname, 'win-sandbox-runner.ps1');
  return fs.existsSync(runner) ? runner : '';
}

function windowsPowerShell() {
  const explicit = String(process.env.GENIE_POWERSHELL || '').trim();
  if (explicit) return explicit;
  const root = String(process.env.SystemRoot || 'C:\\Windows').trim();
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function normalizeMode(mode, permission) {
  const m = String(mode || 'auto').trim();
  if (m === 'auto') {
    if (permission === 'read-only') return 'read-only';
    if (permission === 'full') return 'danger-full-access';
    return 'workspace-write';
  }
  if (!MODES.includes(m)) {
    fail('沙箱 mode 非法：' + m + '（可选 read-only / workspace-write / danger-full-access / auto）', 'SANDBOX_CONFIG_INVALID');
  }
  return m;
}

function normalizeRoot(root, label) {
  const s = String(root == null ? '' : root).trim();
  if (!s) fail(label + '不能为空', 'SANDBOX_INVALID_ROOT');
  if (s.includes('\0')) fail(label + '含 NUL 字节', 'SANDBOX_INVALID_ROOT');
  if (!path.isAbsolute(s)) fail(label + '必须是绝对路径：' + s, 'SANDBOX_INVALID_ROOT');
  if (s.length > MAX_PROFILE_PATH) fail(label + '过长', 'SANDBOX_INVALID_ROOT');
  let real;
  try { real = fs.realpathSync(s); } catch (_) {
    fail(label + '不存在：' + s, 'SANDBOX_INVALID_ROOT');
  }
  let st;
  try { st = fs.statSync(real); } catch (_) {
    fail(label + '不可访问：' + s, 'SANDBOX_INVALID_ROOT');
  }
  if (!st.isDirectory()) fail(label + '不是目录：' + s, 'SANDBOX_INVALID_ROOT');
  return real;
}

function uniqueRoots(list, label) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(list) ? list : [])) {
    const root = normalizeRoot(raw, label);
    if (seen.has(root)) continue;
    seen.add(root);
    out.push(root);
  }
  return out;
}

function readConfig() {
  const file = configPath();
  let stat = null;
  try { stat = fs.statSync(file); } catch (_) { stat = null; }
  if (configCache && configCache.file === file && stat
    && configCache.mtimeMs === stat.mtimeMs && configCache.size === stat.size) {
    return configCache.value;
  }
  if (configCache && configCache.file === file && !stat) return configCache.value;

  const cfg = Object.assign({}, DEFAULTS);
  if (stat) {
    if (stat.size > MAX_CONFIG_BYTES) fail('沙箱配置过大：' + file, 'SANDBOX_CONFIG_INVALID');
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      fail('沙箱配置无法解析：' + file + '：' + e.message, 'SANDBOX_CONFIG_INVALID');
    }
    if (!isPlainObject(raw)) fail('沙箱配置必须是对象：' + file, 'SANDBOX_CONFIG_INVALID');
    if (raw.schemaVersion != null && Number(raw.schemaVersion) !== 1) {
      fail('沙箱配置 schemaVersion 只支持 1', 'SANDBOX_CONFIG_INVALID');
    }
    if (raw.defaultMode != null) cfg.defaultMode = String(raw.defaultMode);
    if (raw.network != null) {
      if (typeof raw.network !== 'boolean') fail('sandbox.network 必须是布尔值', 'SANDBOX_CONFIG_INVALID');
      cfg.network = raw.network;
    }
    if (raw.allowExec != null) {
      if (typeof raw.allowExec !== 'boolean') fail('sandbox.allowExec 必须是布尔值', 'SANDBOX_CONFIG_INVALID');
      cfg.allowExec = raw.allowExec;
    }
    if (raw.allowSubprocess != null) {
      if (typeof raw.allowSubprocess !== 'boolean') fail('sandbox.allowSubprocess 必须是布尔值', 'SANDBOX_CONFIG_INVALID');
      cfg.allowSubprocess = raw.allowSubprocess;
    }
    if (raw.tempWrite != null) {
      if (typeof raw.tempWrite !== 'boolean') fail('sandbox.tempWrite 必须是布尔值', 'SANDBOX_CONFIG_INVALID');
      cfg.tempWrite = raw.tempWrite;
    }
    if (raw.extraWritableRoots != null) {
      if (!Array.isArray(raw.extraWritableRoots)) fail('sandbox.extraWritableRoots 必须是数组', 'SANDBOX_CONFIG_INVALID');
      cfg.extraWritableRoots = raw.extraWritableRoots.slice();
    }
    if (raw.windowsRunner != null) cfg.windowsRunner = String(raw.windowsRunner || '');
  }
  cfg.windowsRunner = String(process.env.GENIE_WINDOWS_SANDBOX_RUNNER || cfg.windowsRunner || '').trim();
  Object.freeze(cfg.extraWritableRoots);
  configCache = { file, mtimeMs: stat ? stat.mtimeMs : -1, size: stat ? stat.size : -1, value: Object.freeze(cfg) };
  return configCache.value;
}

function pickConfigOverrides(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  if (raw.defaultMode != null) out.defaultMode = String(raw.defaultMode);
  if (raw.mode != null) out.defaultMode = String(raw.mode);
  for (const k of ['network', 'allowExec', 'allowSubprocess', 'tempWrite']) {
    if (raw[k] != null) {
      if (typeof raw[k] !== 'boolean') fail('sandbox.' + k + ' 必须是布尔值', 'SANDBOX_CONFIG_INVALID');
      out[k] = raw[k];
    }
  }
  if (raw.extraWritableRoots != null) {
    if (!Array.isArray(raw.extraWritableRoots)) fail('sandbox.extraWritableRoots 必须是数组', 'SANDBOX_CONFIG_INVALID');
    out.extraWritableRoots = raw.extraWritableRoots.slice();
  }
  if (raw.windowsRunner != null) out.windowsRunner = String(raw.windowsRunner || '');
  return out;
}

function policyFor(input) {
  const i = input || {};
  const overrides = pickConfigOverrides(i.config);
  const cfg = Object.freeze(Object.assign({}, readConfig(), overrides));
  const permission = String(i.permission || 'workspace-write');
  const mode = normalizeMode(i.mode || cfg.defaultMode, permission);
  const workspaceRoot = normalizeRoot(i.workspaceRoot || (i.workspace && i.workspace.path), '工作区根');
  const extraWritableRoots = mode === 'danger-full-access'
    ? []
    : uniqueRoots(cfg.extraWritableRoots, '额外可写根');
  const network = i.network == null ? !!cfg.network : !!i.network;
  const allowExec = i.allowExec == null ? !!cfg.allowExec : !!i.allowExec;
  const allowSubprocess = i.allowSubprocess == null ? !!cfg.allowSubprocess : !!i.allowSubprocess;
  const tempWrite = mode === 'workspace-write' && (i.tempWrite == null ? !!cfg.tempWrite : !!i.tempWrite);
  const windowsRunner = String(i.windowsRunner || cfg.windowsRunner || defaultWindowsRunner()).trim();
  if (windowsRunner && !path.isAbsolute(windowsRunner)) {
    fail('sandbox.windowsRunner 必须是绝对路径：' + windowsRunner, 'SANDBOX_CONFIG_INVALID');
  }
  return Object.freeze({
    mode,
    workspaceRoot,
    extraWritableRoots: Object.freeze(extraWritableRoots),
    network,
    allowExec,
    allowSubprocess,
    tempWrite,
    windowsRunner,
    permission,
    configPath: configPath(),
  });
}

function sbplString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** macOS Seatbelt profile。写白名单用 realpath，避免 /tmp -> /private/tmp 被判在界外。 */
function buildSeatbeltProfile(policy) {
  const p = policy || {};
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)'];
  const roots = [];
  if (p.mode === 'workspace-write') {
    roots.push(p.workspaceRoot);
    roots.push(...(p.extraWritableRoots || []));
    if (p.tempWrite && p.tempDir) roots.push(p.tempDir);
  }
  const allow = ['(literal "/dev/null")', '(subpath "/dev")'];
  for (const root of roots) {
    if (!root) continue;
    allow.push('(subpath ' + sbplString(root) + ')');
  }
  forms.push('(allow file-write* ' + allow.join(' ') + ')');
  if (!p.network) forms.push('(deny network*)');
  if (!p.allowSubprocess) forms.push('(deny process-fork)');
  if (!p.allowExec) forms.push('(deny process-exec)');
  return forms.join('\n');
}

function buildBwrapArgs(policy, command, args, cwd, tempDir) {
  const p = policy || {};
  if (p.mode !== 'workspace-write' && p.mode !== 'read-only') {
    fail('Linux bwrap 不支持 mode=' + p.mode, 'SANDBOX_CONFIG_INVALID');
  }
  if (!p.allowExec) fail('当前策略禁止 exec', 'SANDBOX_EXEC_DENIED');
  if (!p.allowSubprocess) {
    fail('Linux bwrap 无法只靠挂载拒绝 fork；allowSubprocess=false 在该平台不受支持', 'SANDBOX_UNSUPPORTED');
  }
  const out = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--unshare-pid',
    '--die-with-parent',
    '--new-session',
    '--cap-drop', 'ALL',
  ];
  if (!p.network) out.push('--unshare-net');
  if (p.mode === 'workspace-write') {
    out.push('--tmpfs', '/tmp');
    for (const root of [p.workspaceRoot, ...(p.extraWritableRoots || [])]) {
      if (root) out.push('--bind', root, root);
    }
    if (p.tempWrite && tempDir) out.push('--bind', tempDir, tempDir);
  }
  out.push('--chdir', cwd, '--', command, ...(args || []));
  return out;
}

function buildWindowsRunnerArgs(policy, runner, command, args, cwd, tempDir) {
  const p = policy || {};
  if (!p.allowExec) fail('当前策略禁止 exec', 'SANDBOX_EXEC_DENIED');
  if (!p.allowSubprocess) {
    fail('Windows runner 契约未声明 fork 限制；allowSubprocess=false 在该平台不受支持', 'SANDBOX_UNSUPPORTED');
  }
  if (!runner) fail('Windows 沙箱 runner 未配置（config/sandbox.json 的 windowsRunner）', 'SANDBOX_UNAVAILABLE');
  const out = [
    '--workspace', p.workspaceRoot,
    '--temp', tempDir || '',
    '--mode', p.mode,
    '--cwd', cwd,
    '--network', p.network ? 'on' : 'off',
  ];
  for (const root of (p.extraWritableRoots || [])) out.push('--extra', root);
  out.push('--', command, ...(args || []));
  return out;
}

function backendForPlatform(platform) {
  if (platform === 'darwin') return 'seatbelt';
  if (platform === 'linux') return 'bwrap';
  if (platform === 'win32') return 'windows-runner';
  return null;
}

function probeBackend(backend, opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  const runner = String(o.windowsRunner || '').trim();
  const key = backend + '|' + platform + '|' + runner;
  const now = Date.now();
  const hit = probeCache.get(key);
  if (hit && now - hit.at < PROBE_TTL_MS) return hit.value;

  let value;
  if (backend === 'seatbelt') {
    const exe = String(process.env.GENIE_SANDBOX_EXEC || '/usr/bin/sandbox-exec');
    if (!fs.existsSync(exe)) {
      value = { ok: false, backend, reason: '找不到 sandbox-exec：' + exe };
    } else {
      const r = spawnSync(exe, ['-p', '(version 1)(allow default)', '--', 'true'], {
        timeout: 5000, stdio: 'ignore', env: process.env,
      });
      value = r.status === 0
        ? { ok: true, backend, command: exe }
        : { ok: false, backend, reason: 'sandbox-exec 功能探针失败（exit=' + String(r.status) + '）' };
    }
  } else if (backend === 'bwrap') {
    const r = spawnSync('bwrap', ['--version'], { timeout: 5000, stdio: 'ignore', env: process.env });
    value = r.status === 0
      ? { ok: true, backend, command: 'bwrap' }
      : { ok: false, backend, reason: 'bwrap 不可用（exit=' + String(r.status) + '）' };
  } else if (backend === 'windows-runner') {
    if (!runner) value = { ok: false, backend, reason: 'Windows 受限令牌 runner 未配置' };
    else if (!fs.existsSync(runner)) value = { ok: false, backend, reason: 'Windows runner 不存在：' + runner };
    else if (/\.ps1$/i.test(runner)) {
      const shell = windowsPowerShell();
      if (!fs.existsSync(shell)) value = { ok: false, backend, reason: 'Windows PowerShell 不存在：' + shell };
      else value = { ok: true, backend, command: shell, script: runner };
    } else value = { ok: true, backend, command: runner };
  } else {
    value = { ok: false, backend: 'none', reason: '当前平台没有沙箱后端' };
  }
  probeCache.set(key, { at: now, value });
  return value;
}

function cleanupTemp(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-sbx-'));
  try { fs.chmodSync(dir, 0o700); } catch (_) {}
  return fs.realpathSync(dir);
}

function denialOf(stderr, backend) {
  const sigs = DENIAL_SIGNATURES[backend] || [];
  const text = String(stderr || '').toLowerCase();
  return sigs.some((sig) => text.includes(sig));
}

/**
 * 准备一次受限执行。
 * @returns {{command,args,env,cwd,backend,mode,enforced,policy,tempDir,cleanup,denialSignatures}}
 */
function prepare(opts) {
  const o = opts || {};
  const command = String(o.command || '').trim();
  if (!command) fail('缺少 command', 'SANDBOX_INVALID_ARGS');
  const args = Array.isArray(o.args) ? o.args.map((x) => String(x)) : [];
  const policy = o.policy || policyFor(o);
  if (!policy.allowExec) fail('当前策略禁止 exec：' + command, 'SANDBOX_EXEC_DENIED');

  const baseEnv = Object.assign({}, o.env || process.env);
  if (policy.mode === 'danger-full-access') {
    return {
      command, args, cwd: o.cwd || policy.workspaceRoot, env: baseEnv,
      backend: 'none', mode: policy.mode, enforced: false, policy,
      tempDir: null, cleanup: () => {}, denialSignatures: [],
    };
  }

  const platform = String(o.platform || process.platform);
  const backend = backendForPlatform(platform);
  if (!backend) fail('当前平台不支持沙箱：' + platform, 'SANDBOX_UNAVAILABLE');
  const probe = probeBackend(backend, { platform, windowsRunner: policy.windowsRunner });
  if (!probe.ok) {
    fail('沙箱不可用，命令未执行：' + (probe.reason || backend), 'SANDBOX_UNAVAILABLE', {
      backend, reason: probe.reason || '',
    });
  }

  let tempDir = null;
  let effective = policy;
  if (policy.tempWrite) {
    tempDir = makeTempDir();
    effective = Object.freeze(Object.assign({}, policy, { tempDir }));
    baseEnv.TMPDIR = tempDir;
    baseEnv.TMP = tempDir;
    baseEnv.TEMP = tempDir;
  }
  const cwd = String(o.cwd || policy.workspaceRoot);
  let wrappedCommand = command;
  let wrappedArgs = args;
  try {
    if (backend === 'seatbelt') {
      wrappedCommand = probe.command;
      wrappedArgs = ['-p', buildSeatbeltProfile(effective), '--', command, ...args];
    } else if (backend === 'bwrap') {
      wrappedCommand = probe.command;
      wrappedArgs = buildBwrapArgs(effective, command, args, cwd, tempDir);
    } else if (backend === 'windows-runner') {
      const runner = probe.script || probe.command;
      wrappedCommand = probe.command;
      wrappedArgs = buildWindowsRunnerArgs(effective, runner, command, args, cwd, tempDir);
      if (probe.script) {
        wrappedArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe.script, ...wrappedArgs];
      }
    } else {
      fail('未实现的沙箱后端：' + backend, 'SANDBOX_UNAVAILABLE');
    }
  } catch (e) {
    cleanupTemp(tempDir);
    throw e;
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    cleanupTemp(tempDir);
  };
  return {
    command: wrappedCommand,
    args: wrappedArgs,
    cwd,
    env: baseEnv,
    backend,
    mode: effective.mode,
    enforced: true,
    policy: effective,
    tempDir,
    cleanup,
    denialSignatures: DENIAL_SIGNATURES[backend].slice(),
  };
}

/** 便捷执行器（测试/诊断用；业务执行仍由调用方自己管 stdio 与超时）。 */
function run(opts) {
  const o = opts || {};
  let prepared;
  try {
    prepared = prepare(o);
  } catch (e) {
    return Promise.resolve({
      ok: false, code: e.code || 'SANDBOX_ERROR', content: e.message,
      exitCode: null, stdout: '', stderr: '', sandbox: null,
    });
  }
  const timeoutMs = Math.min(Math.max(Number(o.timeoutMs || 10000), 100), 600000);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    let timer = null;
    const finish = (code, signal, error) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      prepared.cleanup();
      const denied = prepared.enforced && code !== 0 && denialOf(stderr, prepared.backend);
      resolve({
        ok: code === 0 && !denied,
        code: denied ? 'SANDBOX_DENIED' : (error ? 'SANDBOX_SPAWN_FAILED' : (code === 0 ? null : 'SANDBOX_COMMAND_FAILED')),
        content: (denied ? '沙箱拒绝：' : '') + (stdout || '') + (stderr || ''),
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal || null,
        stdout, stderr,
        denied,
        timedOut: error === 'timeout',
        sandbox: { backend: prepared.backend, mode: prepared.mode, enforced: prepared.enforced },
      });
    };
    let child;
    try {
      child = spawn(prepared.command, prepared.args, {
        cwd: prepared.cwd, env: prepared.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      });
    } catch (e) {
      finish(null, null, e);
      return;
    }
    timer = setTimeout(() => {
      try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (_) {} }
      finish(null, 'SIGKILL', 'timeout');
    }, timeoutMs);
    if (timer.unref) timer.unref();
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => finish(null, null, e));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}

function status() {
  const cfg = readConfig();
  const platform = process.platform;
  const backend = backendForPlatform(platform);
  const windowsRunner = cfg.windowsRunner || defaultWindowsRunner();
  const probe = backend ? probeBackend(backend, { platform, windowsRunner }) : { ok: false, backend: 'none', reason: '平台不支持' };
  return {
    platform,
    backend: backend || 'none',
    available: !!probe.ok,
    reason: probe.reason || '',
    configPath: configPath(),
    runner: backend === 'windows-runner' ? windowsRunner : '',
    defaults: {
      defaultMode: cfg.defaultMode,
      network: cfg.network,
      allowExec: cfg.allowExec,
      allowSubprocess: cfg.allowSubprocess,
      tempWrite: cfg.tempWrite,
      extraWritableRoots: cfg.extraWritableRoots.slice(),
    },
    modes: MODES.slice(),
    enforcement: backend === 'windows-runner' ? 'runner-managed' : (backend ? 'kernel' : 'none'),
    boundaries: {
      read: backend === 'seatbelt' ? 'system-read-allowed' : (backend === 'bwrap' ? 'root-readonly' : 'runner-defined'),
      write: backend === 'windows-runner' ? 'runner-defined' : 'workspace+temp',
      network: cfg.network ? 'allowed' : 'denied',
    },
  };
}

function reload() {
  configCache = null;
  probeCache.clear();
  return status();
}

function resetForTests() {
  configCache = null;
  probeCache.clear();
}

/** 给模型/日志的一句话描述；不把路径全量吐出来。 */
function describe(policy) {
  if (!policy) return 'no-policy';
  return policy.mode + ' · net=' + (policy.network ? 'on' : 'off')
    + ' · fork=' + (policy.allowSubprocess ? 'on' : 'off')
    + ' · roots=' + (1 + (policy.extraWritableRoots || []).length);
}

module.exports = {
  MODES,
  DEFAULTS,
  SandboxError,
  configPath,
  defaultWindowsRunner,
  readConfig,
  policyFor,
  normalizePolicy: policyFor,
  buildSeatbeltProfile,
  buildBwrapArgs,
  buildWindowsRunnerArgs,
  backendForPlatform,
  probeBackend,
  prepare,
  run,
  status,
  reload,
  resetForTests,
  denialOf,
  describe,
  _configCache: () => configCache,
  _probeCache: () => probeCache,
};
