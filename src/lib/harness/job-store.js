'use strict';
/**
 * 后台任务注册表（D2-06）
 *
 * 这一层只回答四件事：**起没起来、还在不在、输出了什么、怎么停**。
 * 它不负责"把结果发回对话"——那属于 relay。混在一起会让"任务跑完了"
 * 和"通知发出去"变成同一个状态，失败时无法判断是哪一段坏了。
 *
 * 几个刻意的决定：
 *  · **stdout/stderr 分开落盘**。合并成一个日志最省事，但编译器错误在 stderr、
 *    进度在 stdout，合起来就看不出"失败在哪一段"。
 *  · **输出有硬上限**（每个流 8MB）。后台任务是"跑一夜的构建"，不设上限会先把磁盘写满，
 *    然后整个 App 因为写日志失败而挂掉。
 *  · **用进程组停**。只 kill 父进程，`npm run build` 拉起的子进程会继续跑，
 *    用户看到"停了"但 CPU 还在转。
 *  · **重启后不假装还活着**：进程不在就标 `lost`，历史输出仍可读。
 */

const fs = require('node:fs');
const path = require('node:path');
const Platform = require('../platform');
const { spawn } = require('node:child_process');
const ProcessTree = require('./process-tree');
const paths = require('../paths');

const MAX_JOBS = 100;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

const live = new Map();   // id -> { child, meta, timer, out, err, outBytes, errBytes, truncated }

function rootDir() {
  return process.env.GENIE_JOBS_DIR || path.join(paths.brainMeta, 'jobs');
}

function metaFile(id) {
  return path.join(rootDir(), String(id) + '.json');
}

function outFile(id) {
  return path.join(rootDir(), String(id) + '.stdout.log');
}

function errFile(id) {
  return path.join(rootDir(), String(id) + '.stderr.log');
}

function ensureDir() {
  fs.mkdirSync(rootDir(), { recursive: true });
}

function newId() {
  return 'job_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function readMeta(id) {
  try {
    const raw = fs.readFileSync(metaFile(id), 'utf8');
    return JSON.parse(raw);
  } catch (_) { return null; }
}

function writeMeta(meta) {
  ensureDir();
  const f = metaFile(meta.id);
  const tmp = f + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}

function listMeta() {
  ensureDir();
  return fs.readdirSync(rootDir())
    .filter((f) => /^job_[a-z0-9]+\.json$/.test(f))
    .map((f) => readMeta(f.replace(/\.json$/, '')))
    .filter(Boolean);
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** 把"上次进程留下的 running"纠正成 lost。只改状态，不删日志。 */
function refresh(meta) {
  if (!meta || meta.status !== 'running') return meta;
  if (live.has(meta.id)) return meta;
  if (pidAlive(meta.pid)) return meta;
  const next = Object.assign({}, meta, {
    status: 'lost',
    endedAt: Number(meta.endedAt || Date.now()),
    note: '进程已不在（可能随上次 App 退出而终止）',
  });
  try { writeMeta(next); } catch (_) {}
  return next;
}

function list(opts) {
  const o = opts || {};
  let items = listMeta().map(refresh);
  if (o.status) items = items.filter((j) => j.status === o.status);
  items.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  if (o.limit) items = items.slice(0, Math.max(1, Number(o.limit)));
  return items;
}

function get(id) {
  const meta = readMeta(id);
  return meta ? refresh(meta) : null;
}

function writeChunk(job, stream, buf) {
  const key = stream === 'stderr' ? 'err' : 'out';
  const bytesKey = stream === 'stderr' ? 'errBytes' : 'outBytes';
  if (job.truncated[key]) return;
  const room = MAX_STREAM_BYTES - job[bytesKey];
  if (room <= 0) {
    job.truncated[key] = true;
    return;
  }
  const slice = buf.length > room ? buf.subarray(0, room) : buf;
  try { job[key].write(slice); } catch (_) { return; }
  job[bytesKey] += slice.length;
  if (slice.length < buf.length || job[bytesKey] >= MAX_STREAM_BYTES) job.truncated[key] = true;
}

function finish(job, code, signal, error) {
  if (job.meta.status !== 'running') return;
  const timedOut = !!job.timedOut;
  const killed = !!job.killed;
  job.meta.status = timedOut ? 'timeout' : (killed ? 'killed' : (code === 0 ? 'done' : 'failed'));
  job.meta.exitCode = Number.isInteger(code) ? code : null;
  job.meta.signal = signal || null;
  job.meta.endedAt = Date.now();
  job.meta.durationMs = job.meta.endedAt - job.meta.startedAt;
  job.meta.stdoutBytes = job.outBytes;
  job.meta.stderrBytes = job.errBytes;
  job.meta.truncated = { stdout: !!job.truncated.out, stderr: !!job.truncated.err };
  if (error) job.meta.note = String(error.message || error);
  try { job.out.end(); } catch (_) {}
  try { job.err.end(); } catch (_) {}
  if (job.timer) clearTimeout(job.timer);
  try { writeMeta(job.meta); } catch (_) {}
  if (typeof job.cleanup === 'function') { try { job.cleanup(); } catch (_) {} }
  live.delete(job.meta.id);
}

function start(opts) {
  const o = opts || {};
  const command = String(o.command || '').trim();
  if (!command) throw new Error('缺少 command');
  if (command.length > 20000) throw new Error('命令过长');
  const cwd = String(o.cwd || '').trim();
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('工作目录不存在：' + (cwd || '（空）'));
  if (listMeta().length >= MAX_JOBS) throw new Error('后台任务已达上限 ' + MAX_JOBS + ' 条，先清理旧任务');
  const timeoutMs = Math.min(Math.max(Number(o.timeoutMs || DEFAULT_TIMEOUT_MS), 1000), MAX_TIMEOUT_MS);

  ensureDir();
  const id = newId();
  const out = fs.createWriteStream(outFile(id), { flags: 'w' });
  const err = fs.createWriteStream(errFile(id), { flags: 'w' });
  const meta = {
    id,
    title: String(o.title || command.split('\n')[0].slice(0, 80)),
    command,
    cwd,
    status: 'running',
    pid: null,
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    signal: null,
    timeoutMs,
    source: String(o.source || 'agent'),
    sessionId: String(o.sessionId || ''),
    stdoutBytes: 0,
    stderrBytes: 0,
    truncated: { stdout: false, stderr: false },
    note: '',
    sandbox: (o.exec && o.exec.sandbox) || null,
  };

  const isWin = process.platform === 'win32';
  const ex = (o.exec && typeof o.exec === 'object') ? o.exec : null;
  let child;
  try {
    if (ex && ex.command) {
      child = spawn(String(ex.command), Array.isArray(ex.args) ? ex.args : [], {
        cwd,
        env: ex.env || process.env,
        detached: !isWin,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      // D3-10：默认 shell 由平台层回答；Windows 不再写死 cmd.exe，POSIX 不再写死 /bin/bash。
      const spec = Platform.shell.shellSpec(command, { allowSubprocess: true });
      child = spawn(spec.command, spec.args, {
        cwd, env: process.env, detached: !isWin, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
  } catch (e) {
    if (ex && typeof ex.cleanup === 'function') { try { ex.cleanup(); } catch (_) {} }
    try { out.end(); } catch (_) {}
    try { err.end(); } catch (_) {}
    throw e;
  }

  const job = {
    id, child, meta, out, err, outBytes: 0, errBytes: 0,
    truncated: { out: false, err: false }, timer: null, killed: false, timedOut: false,
    cleanup: (ex && typeof ex.cleanup === 'function') ? ex.cleanup : null,
    sandbox: (ex && ex.sandbox) || null,
  };
  meta.pid = child.pid || null;
  live.set(id, job);
  writeMeta(meta);

  child.stdout.on('data', (buf) => writeChunk(job, 'stdout', buf));
  child.stderr.on('data', (buf) => writeChunk(job, 'stderr', buf));
  child.on('error', (e) => finish(job, null, null, e));
  child.on('close', (code, signal) => finish(job, code, signal, null));

  if (timeoutMs > 0) {
    job.timer = setTimeout(() => {
      job.timedOut = true;
      kill(id, 'timeout');
    }, timeoutMs);
    job.timer.unref();
  }
  return meta;
}

/** 停任务：先 TERM 整组，3 秒后还在就 KILL。 */
function kill(id, reason) {
  const target = String(id || '');
  const job = live.get(target);
  if (!job) {
    const meta = get(target);
    if (!meta) return { ok: false, error: '没有这个任务：' + target };
    return { ok: false, error: '任务已不在运行（状态：' + meta.status + '）' };
  }
  job.killed = true;
  job.meta.note = reason === 'timeout' ? '超时，已终止' : '用户/Agent 主动停止';
  // 统一走 process-tree：POSIX kill(-pid) 整组，Windows taskkill /T /F。
  ProcessTree.killTree(job.child, 'SIGTERM');
  setTimeout(() => {
    if (!live.has(target)) return;
    ProcessTree.killTree(job.child, 'SIGKILL');
  }, 3000).unref();
  return { ok: true, id: target, status: 'stopping', note: job.meta.note };
}

function readTail(file, maxBytes) {
  const cap = Math.max(256, Number(maxBytes || 16000));
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return { text: '', bytes: 0, truncated: false }; }
  const start = Math.max(0, stat.size - cap);
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch (_) { text = ''; }
  return { text, bytes: stat.size, truncated: start > 0 };
}

function output(id, opts) {
  const o = opts || {};
  const meta = get(id);
  if (!meta) return null;
  const maxBytes = Math.min(Math.max(Number(o.maxBytes || 16000), 256), 128 * 1024);
  const stdout = readTail(outFile(id), maxBytes);
  const stderr = readTail(errFile(id), maxBytes);
  return {
    job: meta,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
  };
}

/** 等任务结束，最多 waitMs；超时返回当前状态，不假装完成。 */
function wait(id, waitMs) {
  const target = String(id || '');
  const timeout = Math.min(Math.max(Number(waitMs || 30000), 500), 10 * 60 * 1000);
  return new Promise((resolve) => {
    const deadline = Date.now() + timeout;
    const tick = () => {
      const meta = get(target);
      if (!meta) return resolve({ ok: false, error: '没有这个任务：' + target });
      if (meta.status !== 'running') return resolve({ ok: true, job: meta, waitedMs: timeout - (deadline - Date.now()) });
      if (Date.now() >= deadline) return resolve({ ok: false, timeout: true, job: meta, waitedMs: timeout });
      setTimeout(tick, 250);
    };
    tick();
  });
}

function reset() {
  live.clear();
  try { fs.rmSync(rootDir(), { recursive: true, force: true }); } catch (_) {}
}

module.exports = {
  start, list, get, output, wait, kill, reset, metaFile, outFile, errFile,
  MAX_JOBS, MAX_STREAM_BYTES, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS,
};
