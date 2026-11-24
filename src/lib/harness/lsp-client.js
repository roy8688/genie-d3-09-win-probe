'use strict';
/**
 * D3-03 LSP 协议层：Content-Length 分帧 + 一个 stdio JSON-RPC 连接。
 *
 * 边界：
 *  · 只实现 LSP 需要的 JSON-RPC 2.0 语义（request / notification / server request）；
 *  · 不装语言服务器、不做工作区路由——那些在 lsp-manager；
 *  · 所有失败带稳定 code，调用方按 code 路由，不解析 message。
 *
 * 官方参考：deepseek-harness/packages/lsp/lsp-stdio/src/{framing,connection}.ts。
 * 刻意保留「通知不等待响应」「initialize.processId=null」两条：前者曾在 MCP 里
 * 让每次连接白等 30 秒；后者避免服务器反过来监视 harness PID。
 */
const { spawn } = require('node:child_process');

class LspError extends Error {
  constructor(message, code, options) {
    super(message);
    this.name = 'LspError';
    this.code = String(code || 'LSP_ERROR');
    if (options && options.cause !== undefined) this.cause = options.cause;
  }
}

const HEADER_SEPARATOR = '\r\n\r\n';
const MAX_HEADER_BYTES = 64 * 1024;

/** 把一条 JSON-RPC 消息编码成 LSP base protocol 帧。 */
function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([
    Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'),
    body,
  ]);
}

/** 流式解码器：喂 stdout chunk，吐出完整 JSON-RPC 消息；单条消息有上限。 */
class LspDecoder {
  constructor(maxMessageBytes) {
    this.max = Number(maxMessageBytes) > 0 ? Number(maxMessageBytes) : 16 * 1000 * 1000;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''));
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, incoming]) : incoming;
    const messages = [];
    for (;;) {
      const step = this._nextFrame();
      if (!step) break;
      messages.push(step);
    }
    return messages;
  }

  _nextFrame() {
    const sep = this.buffer.indexOf(HEADER_SEPARATOR);
    if (sep < 0) {
      if (this.buffer.length > MAX_HEADER_BYTES) {
        throw new LspError('LSP header exceeded ' + MAX_HEADER_BYTES + ' bytes', 'LSP_PROTOCOL_ERROR');
      }
      return null;
    }
    if (sep > MAX_HEADER_BYTES) {
      throw new LspError('LSP header exceeded ' + MAX_HEADER_BYTES + ' bytes', 'LSP_PROTOCOL_ERROR');
    }
    const header = this.buffer.toString('ascii', 0, sep);
    let length = null;
    for (const line of header.split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      if (line.slice(0, colon).trim().toLowerCase() !== 'content-length') continue;
      const n = Number(line.slice(colon + 1).trim());
      if (!Number.isInteger(n) || n < 0) {
        throw new LspError('invalid LSP Content-Length: ' + JSON.stringify(line), 'LSP_PROTOCOL_ERROR');
      }
      length = n;
      break;
    }
    if (length === null) {
      throw new LspError('LSP header missing Content-Length: ' + JSON.stringify(header), 'LSP_PROTOCOL_ERROR');
    }
    if (length > this.max) {
      throw new LspError('LSP message length ' + length + ' exceeds ' + this.max + ' bytes', 'LSP_MESSAGE_TOO_LARGE');
    }
    const start = sep + HEADER_SEPARATOR.length;
    const end = start + length;
    if (this.buffer.length < end) return null;
    const body = this.buffer.toString('utf8', start, end);
    this.buffer = this.buffer.subarray(end);
    try { return JSON.parse(body); }
    catch (e) {
      throw new LspError('LSP body was not valid JSON: ' + e.message, 'LSP_PROTOCOL_ERROR', { cause: e });
    }
  }
}

/** 过滤环境里的常见凭证；显式配置的 env 仍会合并进去（那是用户有意授权）。 */
function scrubEnv(base, extra) {
  const out = {};
  const sensitive = /(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY)/i;
  for (const [k, v] of Object.entries(base || {})) {
    if (sensitive.test(k)) continue;
    if (String(k).startsWith('DSH_') || String(k).startsWith('GENIE_MCP_')) continue;
    if (typeof v === 'string') out[k] = v;
  }
  for (const [k, v] of Object.entries(extra || {})) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

class LspConnection {
  /**
   * @param {object} spec {command,args,cwd,env,maxMessageBytes,maxStderrBytes,requestTimeoutMs,onNotification,onServerRequest}
   */
  constructor(spec) {
    const s = spec || {};
    this.maxStderrBytes = Number(s.maxStderrBytes) > 0 ? Number(s.maxStderrBytes) : 1024 * 1024;
    this.requestTimeoutMs = Number(s.requestTimeoutMs) > 0 ? Number(s.requestTimeoutMs) : 60000;
    this.decoder = new LspDecoder(s.maxMessageBytes);
    this.pending = new Map();
    this.nextId = 1;
    this.closeReason = null;
    this.stderrText = '';
    this.closed = new Promise((resolve) => { this._resolveClosed = resolve; });
    this.onNotification = typeof s.onNotification === 'function' ? s.onNotification : null;
    this.onServerRequest = typeof s.onServerRequest === 'function' ? s.onServerRequest : null;

    try {
      this.child = spawn(String(s.command), Array.isArray(s.args) ? s.args : [], {
        cwd: s.cwd,
        env: scrubEnv(process.env, s.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        // POSIX 上单独进程组，teardown 可整组 kill；Windows 留 D3-09。
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      this._fail(new LspError('LSP server failed to start: ' + e.message, 'LSP_SPAWN_FAILED', { cause: e }));
      return;
    }

    this.child.on('error', (e) => { this._fail(new LspError('LSP server failed to start: ' + e.message, 'LSP_SPAWN_FAILED', { cause: e })); });
    this.child.on('exit', (code, signal) => { this._onExit(code, signal); });
    this.child.on('close', () => { this._resolveClosedOnce(); });
    this.child.stdout.on('data', (chunk) => { this._onStdout(chunk); });
    this.child.stderr.on('data', (chunk) => { this._onStderr(chunk); });
    this.child.stdin.on('error', (e) => {
      this._fail(new LspError('LSP server stopped accepting input: ' + e.message, 'LSP_SERVER_EXITED', { cause: e }));
    });
  }

  get stderrTail() { return this.stderrText; }
  get failed() { return !!this.closeReason; }

  request(method, params, options) {
    const o = options || {};
    if (this.closeReason) return Promise.reject(this.closeReason);
    const id = this.nextId++;
    const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      let timer = null;
      const settle = (fn, value) => {
        if (timer) clearTimeout(timer);
        timer = null;
        fn(value);
      };
      timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LspError('LSP request timed out: ' + method, 'LSP_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: (v) => settle(resolve, v), reject: (e) => settle(reject, e) });
      this._write({ jsonrpc: '2.0', id, method, params }).catch((e) => {
        if (this.pending.delete(id)) settle(reject, e);
      });
    });
  }

  notify(method, params) {
    if (this.closeReason) return Promise.reject(this.closeReason);
    return this._write({ jsonrpc: '2.0', method, params });
  }

  /** 等待进程退出；调用方负责先 kill 或先发 shutdown。 */
  waitForExit(timeoutMs) {
    if (this.closeReason) return Promise.resolve();
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000;
    return Promise.race([
      this.closed,
      new Promise((resolve) => setTimeout(resolve, ms)),
    ]);
  }

  kill(signal) {
    if (!this.child || this.child.killed) return;
    const sig = signal || 'SIGTERM';
    try {
      if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, sig);
      else this.child.kill(sig);
    } catch (_) {
      try { this.child.kill(sig); } catch (__) { /* 已退出 */ }
    }
  }

  _onStdout(chunk) {
    let messages;
    try { messages = this.decoder.push(chunk); }
    catch (e) {
      this._fail(e);
      this.kill('SIGTERM');
      return;
    }
    for (const m of messages) this._dispatch(m);
  }

  _onStderr(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    this.stderrText = (this.stderrText + text).slice(-this.maxStderrBytes);
  }

  _dispatch(message) {
    if (!message || typeof message !== 'object') return;
    const hasId = message.id !== undefined && message.id !== null;
    if (typeof message.method === 'string' && hasId) {
      this._answerServerRequest(message.id, message.method, message.params);
      return;
    }
    if (typeof message.method === 'string') {
      if (this.onNotification) {
        try { this.onNotification(message.method, message.params); } catch (_) { /* 通知处理不反向打断协议 */ }
      }
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const p = this.pending.get(Number(message.id));
    if (!p) return;
    this.pending.delete(Number(message.id));
    if (message.error && typeof message.error === 'object') {
      p.reject(new LspError('LSP server rejected ' + p.method + ': ' + String(message.error.message || 'unknown'),
        'LSP_SERVER_ERROR'));
    } else {
      p.resolve(message.result);
    }
  }

  async _answerServerRequest(id, method, params) {
    let result = null;
    let error = null;
    try {
      if (typeof this.onServerRequest === 'function') result = await this.onServerRequest(method, params);
      else if (method === 'workspace/configuration') {
        const items = params && Array.isArray(params.items) ? params.items : [];
        result = items.map(() => null);
      } else if (method === 'client/registerCapability' || method === 'window/workDoneProgress/create') {
        result = null;
      } else {
        throw new Error('unsupported server request: ' + method);
      }
    } catch (e) {
      error = { code: -32601, message: String((e && e.message) || e) };
    }
    const frame = error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result };
    try { await this._write(frame); } catch (_) { /* 连接已断，响应写不出去 */ }
  }

  _write(message) {
    if (this.closeReason) return Promise.reject(this.closeReason);
    return new Promise((resolve, reject) => {
      const bytes = encodeMessage(message);
      try {
        this.child.stdin.write(bytes, (err) => {
          if (err) {
            const failure = new LspError('LSP stdin write failed: ' + err.message, 'LSP_SERVER_EXITED', { cause: err });
            this._fail(failure);
            reject(failure);
          } else resolve();
        });
      } catch (e) {
        const failure = new LspError('LSP stdin write failed: ' + e.message, 'LSP_SERVER_EXITED', { cause: e });
        this._fail(failure);
        reject(failure);
      }
    });
  }

  _onExit(code, signal) {
    const tail = this.stderrText.trim();
    const reason = this.closeReason || new LspError(
      'language server exited' + (code != null ? ' (code ' + code + ')' : '')
      + (signal ? ' (signal ' + signal + ')' : '')
      + (tail ? '; stderr: ' + tail.slice(-400) : ''),
      'LSP_SERVER_EXITED'
    );
    this._fail(reason);
    this._resolveClosedOnce();
  }

  _fail(error) {
    if (!this.closeReason) this.closeReason = error;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(error);
  }

  _resolveClosedOnce() {
    if (this._closedResolved) return;
    this._closedResolved = true;
    if (this._resolveClosed) this._resolveClosed();
  }
}

module.exports = {
  LspError, LspDecoder, LspConnection, encodeMessage, scrubEnv,
};
