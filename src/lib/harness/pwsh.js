'use strict';
/**
 * PowerShell 执行器（D3-09，2026-11-24）
 *
 * 一条命令 = 一个 `pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand <base64>`：
 *   · 命令正文走 UTF-16LE base64，PowerShell 自己解码； quotes / $ / 反引号 / 换行 / 中文都不经过
 *     任何中间 shell，因此没有“再转义一层”的注入面；
 *   · 第一行固定 UTF-8 输出，Windows PowerShell 5.1 的 OEM 代码页不会把中文写成乱码；
 *   · 末尾显式 `exit` 真实退出码：原生命令的 `$LASTEXITCODE` 优先，其次是 `$?`，
 *     不再出现“命令失败但工具返回 0”；
 *   · 超时/取消用进程树终止（POSIX 进程组 / Windows taskkill /T /F），不是只 kill 包装进程。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ProcessTree = require('./process-tree');

const MAX_COMMAND = 20000;
const MAX_OUTPUT = 64 * 1024;

const ENCODING_PREAMBLE = [
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
].join('; ');

function executableName(platform) {
  return String(platform || process.platform) === 'win32' ? 'pwsh.exe' : 'pwsh';
}

/**
 * Windows 候选顺序：PowerShell 7 安装目录 → PATH（含 Microsoft Store 别名）→
 * Windows PowerShell 5.1。纯函数，测试可注入 exists。
 */
function candidatePwshPaths(env, platform, exists) {
  const e = env || process.env;
  const p = String(platform || process.platform);
  if (p !== 'win32') {
    const found = [];
    if (e.GENIE_PWSH_PATH) found.push(e.GENIE_PWSH_PATH);
    if (e.PATH) {
      for (const entry of e.PATH.split(':')) if (entry.trim()) found.push(path.join(entry.trim(), 'pwsh'));
    }
    return found;
  }
  const has = exists || ((x) => { try { const s = fs.lstatSync(x); return s.isFile() || s.isSymbolicLink(); } catch (_) { return false; } });
  const programFiles = e.ProgramFiles || 'C:\\Program Files';
  const systemRoot = e.SystemRoot || 'C:\\Windows';
  const candidates = [path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe')];
  for (const entry of String(e.PATH || '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '');
    if (trimmed) candidates.push(path.win32.join(trimmed, 'pwsh.exe'));
  }
  candidates.push(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  return candidates.filter((x) => has(x));
}

function resolvePwshPath(opts) {
  const o = opts || {};
  const configured = String(o.configured || o.env && o.env.GENIE_PWSH_PATH || '').trim();
  if (configured) return configured;
  const platform = String(o.platform || process.platform);
  const hits = candidatePwshPaths(o.env || process.env, platform, o.exists);
  if (hits.length) return hits[0];
  return executableName(platform);
}

function assertCommand(command) {
  const cmd = String(command == null ? '' : command);
  if (!cmd.trim()) throw Object.assign(new Error('缺少 command'), { code: 'PWSH_COMMAND_REQUIRED' });
  if (cmd.length > MAX_COMMAND) throw Object.assign(new Error('命令过长'), { code: 'PWSH_COMMAND_TOO_LONG' });
  return cmd;
}

/**
 * 把用户命令包成一段会在最后 `exit` 的 PowerShell 脚本。
 * `& { ... }` 保持原命令的语句边界；`$LASTEXITCODE` 用全局值，避免子作用域读不到。
 */
function buildScript(command) {
  const cmd = assertCommand(command);
  return [
    ENCODING_PREAMBLE,
    '& {',
    cmd,
    '}',
    '$__genieOk = $?',
    '$__genieCode = if ($null -ne $global:LASTEXITCODE) { [int]$global:LASTEXITCODE } elseif ($__genieOk) { 0 } else { 1 }',
    'exit $__genieCode',
  ].join('\n');
}

function encodedCommand(command) {
  return Buffer.from(buildScript(command), 'utf16le').toString('base64');
}

function argsFor(command) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand(command)];
}

/** 持久会话每个命令的包装：开始/结束/当前目录三个标记，均带随机 nonce。 */
function persistentScript(command, nonce) {
  assertCommand(command);
  const b64 = Buffer.from(String(command), 'utf8').toString('base64');
  const id = String(nonce || '');
  const start = '__GENIE_PWSH_START_' + id + '__';
  const end = '__GENIE_PWSH_END_' + id + ':';
  const cwd = '__GENIE_PWSH_CWD_' + id + ':';
  return [
    ENCODING_PREAMBLE,
    '$__genieStart = \'' + start + '\'',
    '$__genieEnd = \'' + end + '\'',
    '$__genieCwd = \'' + cwd + '\'',
    'Write-Output $__genieStart',
    '$global:LASTEXITCODE = $null',
    'try {',
    '  Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\'' + b64 + '\')))',
    '  $__genieOk = $?',
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  $__genieOk = $false',
    '}',
    '$__genieCode = if ($null -ne $global:LASTEXITCODE) { [int]$global:LASTEXITCODE } elseif ($__genieOk) { 0 } else { 1 }',
    '[Console]::Out.Flush()',
    'Write-Output ($__genieCwd + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Location).Path)) + \'__\')',
    'Write-Output ($__genieEnd + $__genieCode + \'__\')',
  ].join('; ');
}

function capTail(text, maxBytes) {
  const s = String(text || '');
  const max = Number(maxBytes || MAX_OUTPUT);
  if (Buffer.byteLength(s) <= max) return { text: s, truncated: false };
  const chars = Array.from(s);
  let bytes = 0;
  let start = chars.length;
  while (start > 0) {
    const n = Buffer.byteLength(chars[start - 1]);
    if (bytes + n > max) break;
    bytes += n;
    start -= 1;
  }
  return { text: chars.slice(start).join(''), truncated: true };
}

/**
 * 跑一条 pwsh 命令。
 * @returns {Promise<{ok,code,stdout,stderr,timedOut,aborted,signal,durationMs,pid,pidAlive,truncated}>}
 */
function run(command, opts) {
  const o = opts || {};
  const cmd = assertCommand(command);
  const exe = String(o.exe || resolvePwshPath(o));
  const timeoutMs = Math.min(Math.max(Number(o.timeoutMs || 120000), 100), 600000);
  const maxBytes = Math.min(Math.max(Number(o.maxBytes || MAX_OUTPUT), 1024), 2 * 1024 * 1024);
  const env = Object.assign({}, process.env, o.env || {}, {
    NO_COLOR: '1',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    POWERSHELL_TELEMETRY_OPTOUT: '1',
    POWERSHELL_UPDATECHECK: 'Off',
    TERM: 'dumb',
  });
  const cwd = o.cwd || process.cwd();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    let timer = null;
    let hardTimer = null;
    let timedOut = false;
    let aborted = false;
    const started = Date.now();
    let child;
    const finish = (code, signal, error) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      const pid = child && child.pid ? child.pid : null;
      let pidAlive = false;
      if (pid) {
        try { process.kill(pid, 0); pidAlive = true; } catch (e) { pidAlive = e && e.code === 'EPERM'; }
      }
      const out = capTail(stdout, maxBytes);
      const err = capTail(stderr, maxBytes);
      resolve({
        ok: !timedOut && !aborted && !error && code === 0,
        code: timedOut ? 'PWSH_TIMEOUT' : aborted ? 'PWSH_ABORTED' : error ? 'PWSH_SPAWN_FAILED' : null,
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal || null,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
        pid,
        pidAlive,
      });
    };
    try {
      child = spawn(exe, argsFor(cmd), {
        cwd,
        env,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish(null, null, e);
      return;
    }
    const stop = (why) => {
      if (done) return;
      if (why === 'timeout') timedOut = true; else aborted = true;
      ProcessTree.terminateTree(child, 1000);
      hardTimer = setTimeout(() => finish(null, 'SIGKILL', null), 3000);
      if (hardTimer.unref) hardTimer.unref();
    };
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    if (timer.unref) timer.unref();
    if (o.signal) {
      if (o.signal.aborted) stop('abort');
      else o.signal.addEventListener('abort', () => stop('abort'), { once: true });
    }
    child.stdout.on('data', (d) => {
      stdout += String(d);
      if (stdout.length > maxBytes * 2) stdout = stdout.slice(-maxBytes);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
      if (stderr.length > maxBytes * 2) stderr = stderr.slice(-maxBytes);
    });
    child.on('error', (e) => finish(null, null, e));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}

module.exports = {
  ENCODING_PREAMBLE,
  MAX_COMMAND,
  MAX_OUTPUT,
  candidatePwshPaths,
  resolvePwshPath,
  buildScript,
  encodedCommand,
  argsFor,
  persistentScript,
  assertCommand,
  capTail,
  run,
};
