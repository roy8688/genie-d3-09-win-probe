'use strict';
/**
 * D3-03 LSP 管理器：配置 → provider（扩展名路由）→ 每工作区惰性实例 → 规范化查询。
 *
 * 与官方 DSH 的差异（有意）：
 *  · 官方 seam 只有定义/引用/实现/悬停；本项目 D3 验收要求「诊断」，所以
 *    这里同时支持 pull（textDocument/diagnostic）与 push（publishDiagnostics）。
 *  · 官方每次查询 didOpen → 查询 → didClose，查询间不保留文档；这里沿用同一策略，
 *    避免缓存陈旧，也让语言服务器永远看到磁盘当前字节。
 *  · 先读源文件再 spawn：无效路径不会留下一个空闲语言服务器进程。
 *
 * 配置：config/lsp.json（GENIE_LSP_CONFIG 可覆盖）。凭证不写在这里，env 里显式配置的
 * 值才会传给服务器，ambient 的 *KEY/TOKEN/SECRET/PASSWORD* 会被 lsp-client 过滤。
 */
const fs = require('node:fs');
const path = require('node:path');
const paths = require('../paths');
const { LspError, LspConnection } = require('./lsp-client');
const T = require('./lsp-translate');

const DEFAULTS = {
  maxMessageBytes: 16 * 1000 * 1000,
  maxStderrBytes: 1000 * 1000,
  maxDocumentBytes: 4 * 1000 * 1000,
  shutdownTimeoutMs: 5000,
  killGraceMs: 2000,
  requestTimeoutMs: 60000,
  diagnosticsTimeoutMs: 5000,
  startupTimeoutMs: 30000,
  maxLocations: 100,
  maxDiagnostics: 200,
  warmupMs: 1500,
};

const POSITION_OPS = new Set(['goToDefinition', 'findReferences', 'goToImplementation', 'hover']);

const state = {
  configPath: '',
  loaded: false,
  mtimeMs: -1,
  config: null,
  servers: [],
  byExt: new Map(),
  error: null,
  instances: new Map(),
  loadedAt: 0,
};

function configPath() {
  return process.env.GENIE_LSP_CONFIG || path.join(paths.config, 'lsp.json');
}

function resetForTests() {
  for (const inst of state.instances.values()) {
    try { inst.killNow(); } catch (_) { /* 测试清理 */ }
  }
  state.instances.clear();
  state.configPath = '';
  state.loaded = false;
  state.mtimeMs = -1;
  state.config = null;
  state.servers = [];
  state.byExt = new Map();
  state.error = null;
  state.loadedAt = 0;
}

function readConfigFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw new LspError('LSP 配置无法读取：' + e.message, 'LSP_CONFIG_INVALID', { cause: e });
  }
  let doc;
  try { doc = JSON.parse(text); }
  catch (e) { throw new LspError('LSP 配置不是合法 JSON：' + e.message, 'LSP_CONFIG_INVALID', { cause: e }); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new LspError('LSP 配置顶层必须是对象', 'LSP_CONFIG_INVALID');
  }
  if (doc.schemaVersion !== undefined && doc.schemaVersion !== 1) {
    throw new LspError('LSP 配置 schemaVersion 必须是 1', 'LSP_CONFIG_INVALID');
  }
  if (doc.servers === undefined) return { schemaVersion: 1, servers: {} };
  if (!doc.servers || typeof doc.servers !== 'object' || Array.isArray(doc.servers)) {
    throw new LspError('LSP 配置 servers 必须是对象', 'LSP_CONFIG_INVALID');
  }
  return doc;
}

function assertPositiveInt(name, value, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new LspError('LSP 配置 ' + name + ' 必须是正整数', 'LSP_CONFIG_INVALID');
  return n;
}

function assertNonNegativeInt(name, value, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new LspError('LSP 配置 ' + name + ' 必须是非负整数', 'LSP_CONFIG_INVALID');
  return n;
}

function normalizeExtensionMap(name, map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new LspError('LSP server ' + name + ' 缺少 extensionToLanguage', 'LSP_CONFIG_INVALID');
  }
  const out = {};
  for (const [ext, language] of Object.entries(map)) {
    const e = String(ext || '').trim().toLowerCase();
    if (!e.startsWith('.') || e.length < 2) {
      throw new LspError('LSP server ' + name + ' 的扩展名必须是小写且以点开头：' + ext, 'LSP_CONFIG_INVALID');
    }
    if (typeof language !== 'string' || !language.trim()) {
      throw new LspError('LSP server ' + name + ' 的 language id 不能为空：' + ext, 'LSP_CONFIG_INVALID');
    }
    out[e] = language.trim();
  }
  if (!Object.keys(out).length) throw new LspError('LSP server ' + name + ' 没有配置任何扩展名', 'LSP_CONFIG_INVALID');
  return out;
}

function resolveExecutable(command) {
  const raw = String(command || '').trim();
  if (!raw) throw new LspError('LSP server command 不能为空', 'LSP_CONFIG_INVALID');
  const canExec = (p) => {
    try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch (_) { return false; }
  };
  if (path.isAbsolute(raw)) {
    if (canExec(raw)) return raw;
    throw new LspError('LSP server 不可执行：' + raw, 'LSP_CONFIG_INVALID');
  }
  if (raw.includes('/') || raw.includes('\\')) {
    const abs = path.resolve(paths.root, raw);
    if (canExec(abs)) return abs;
    throw new LspError('LSP server 不可执行：' + abs, 'LSP_CONFIG_INVALID');
  }
  const sep = path.delimiter;
  const extra = path.join(paths.root, 'node_modules', '.bin');
  const search = String(process.env.PATH || '').split(sep).filter(Boolean).concat([extra]);
  const suffixes = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : [''];
  for (const dir of search) {
    for (const suffix of suffixes) {
      const cand = path.join(dir, raw + suffix);
      if (canExec(cand)) return cand;
    }
  }
  throw new LspError('LSP server 找不到可执行文件：' + raw + '（可写绝对路径，或装到 node_modules/.bin）', 'LSP_CONFIG_INVALID');
}

function buildServers(doc) {
  const names = Object.keys(doc.servers || {});
  if (!names.length) return [];
  const servers = [];
  const byExt = new Map();
  for (const name of names) {
    if (!name.trim()) throw new LspError('LSP server 名不能为空', 'LSP_CONFIG_INVALID');
    const raw = doc.servers[name] || {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new LspError('LSP server ' + name + ' 配置必须是对象', 'LSP_CONFIG_INVALID');
    }
    const extMap = normalizeExtensionMap(name, raw.extensionToLanguage);
    const command = resolveExecutable(raw.command);
    const args = raw.args === undefined ? [] : raw.args;
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      throw new LspError('LSP server ' + name + ' 的 args 必须是字符串数组', 'LSP_CONFIG_INVALID');
    }
    if (raw.env !== undefined && (!raw.env || typeof raw.env !== 'object' || Array.isArray(raw.env))) {
      throw new LspError('LSP server ' + name + ' 的 env 必须是对象', 'LSP_CONFIG_INVALID');
    }
    for (const ext of Object.keys(extMap)) {
      if (byExt.has(ext)) throw new LspError('LSP 扩展名冲突：' + ext + ' 同时被 ' + byExt.get(ext).name + ' 和 ' + name + ' 声明', 'LSP_CONFLICT');
    }
    const entry = {
      name,
      command,
      args: args.slice(),
      env: raw.env ? Object.assign({}, raw.env) : {},
      extensionToLanguage: extMap,
      initializationOptions: raw.initializationOptions === undefined ? null : raw.initializationOptions,
      configuration: raw.configuration === undefined ? null : raw.configuration,
      maxMessageBytes: assertPositiveInt(name + '.maxMessageBytes', raw.maxMessageBytes, DEFAULTS.maxMessageBytes),
      maxStderrBytes: assertPositiveInt(name + '.maxStderrBytes', raw.maxStderrBytes, DEFAULTS.maxStderrBytes),
      maxDocumentBytes: assertPositiveInt(name + '.maxDocumentBytes', raw.maxDocumentBytes, DEFAULTS.maxDocumentBytes),
      shutdownTimeoutMs: assertPositiveInt(name + '.shutdownTimeoutMs', raw.shutdownTimeoutMs, DEFAULTS.shutdownTimeoutMs),
      killGraceMs: assertPositiveInt(name + '.killGraceMs', raw.killGraceMs, DEFAULTS.killGraceMs),
      requestTimeoutMs: assertPositiveInt(name + '.requestTimeoutMs', raw.requestTimeoutMs, DEFAULTS.requestTimeoutMs),
      diagnosticsTimeoutMs: assertPositiveInt(name + '.diagnosticsTimeoutMs', raw.diagnosticsTimeoutMs, DEFAULTS.diagnosticsTimeoutMs),
      startupTimeoutMs: assertPositiveInt(name + '.startupTimeoutMs', raw.startupTimeoutMs, DEFAULTS.startupTimeoutMs),
      maxLocations: assertPositiveInt(name + '.maxLocations', raw.maxLocations, DEFAULTS.maxLocations),
      maxDiagnostics: assertPositiveInt(name + '.maxDiagnostics', raw.maxDiagnostics, DEFAULTS.maxDiagnostics),
      warmupMs: assertNonNegativeInt(name + '.warmupMs', raw.warmupMs, DEFAULTS.warmupMs),
    };
    servers.push(entry);
    for (const ext of Object.keys(extMap)) byExt.set(ext, entry);
  }
  return { servers, byExt };
}

function ensureLoaded(force) {
  const file = configPath();
  let st = null;
  try { st = fs.statSync(file); } catch (_) { st = null; }
  const mtime = st ? st.mtimeMs : -1;
  if (!force && state.loaded && state.configPath === file && state.mtimeMs === mtime) return state;
  if (force) {
    for (const inst of state.instances.values()) inst.killNow();
    state.instances.clear();
  }
  state.configPath = file;
  state.error = null;
  const doc = readConfigFile(file);
  if (!doc || !Object.keys(doc.servers || {}).length) {
    state.config = doc || { schemaVersion: 1, servers: {} };
    state.servers = [];
    state.byExt = new Map();
    state.loaded = true;
    state.mtimeMs = mtime;
    state.loadedAt = Date.now();
    return state;
  }
  const built = buildServers(doc);
  state.config = doc;
  state.servers = built.servers;
  state.byExt = built.byExt;
  state.loaded = true;
  state.mtimeMs = mtime;
  state.loadedAt = Date.now();
  return state;
}

function querySafe(force) {
  try { return ensureLoaded(force); }
  catch (e) {
    state.error = String((e && e.message) || e);
    state.loaded = false;
    throw e;
  }
}

function isWithin(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

function canonicalWorkspace(workspaceRoot) {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    throw new LspError('LSP 需要工作区根目录', 'LSP_WORKSPACE_REQUIRED');
  }
  const abs = path.resolve(workspaceRoot);
  let st;
  try { st = fs.statSync(abs); }
  catch (_) { throw new LspError('工作区不存在：' + abs, 'LSP_WORKSPACE_REQUIRED'); }
  if (!st.isDirectory()) throw new LspError('工作区不是目录：' + abs, 'LSP_WORKSPACE_REQUIRED');
  return fs.realpathSync.native(abs);
}

function readSource(root, filePath, maxBytes) {
  const raw = String(filePath || '').trim();
  if (!raw) throw new LspError('LSP file_path 不能为空', 'LSP_FILE_NOT_FOUND');
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  let real;
  let st;
  try { real = fs.realpathSync.native(abs); st = fs.statSync(real); }
  catch (_) { throw new LspError('文件不存在：' + abs, 'LSP_FILE_NOT_FOUND'); }
  if (!st.isFile()) throw new LspError('不是普通文件：' + abs, 'LSP_FILE_NOT_FOUND');
  if (!isWithin(root, real)) throw new LspError('文件在工作区之外：' + raw, 'LSP_FILE_OUTSIDE_WORKSPACE');
  if (st.size > maxBytes) throw new LspError('文件超过 ' + maxBytes + ' 字节上限：' + raw, 'LSP_FILE_TOO_LARGE');
  let text;
  try { text = fs.readFileSync(real, 'utf8'); }
  catch (e) { throw new LspError('文件读取失败：' + e.message, 'LSP_FILE_NOT_FOUND', { cause: e }); }
  return { path: real, text, size: st.size };
}

function relativePath(root, target) {
  if (!target || target === root) return '.';
  if (isWithin(root, target)) return path.relative(root, target).split(path.sep).join('/');
  return target;
}

class LspInstance {
  constructor(server, root, options) {
    this.server = server;
    this.root = root;
    this.rootUri = T.pathToUri(root);
    this.opts = options || {};
    this.capabilities = null;
    this.warmed = false;
    this.disposed = false;
    this.queue = Promise.resolve();
    this.diagnosticsCache = new Map();
    this.diagnosticsSerial = new Map();
    this.diagWaiters = new Map();
    this.connection = new LspConnection({
      command: server.command,
      args: server.args,
      cwd: root,
      env: server.env,
      maxMessageBytes: server.maxMessageBytes,
      maxStderrBytes: server.maxStderrBytes,
      requestTimeoutMs: server.requestTimeoutMs,
      onNotification: (method, params) => this._onNotification(method, params),
      onServerRequest: (method, params) => this._onServerRequest(method, params),
    });
    this.ready = this._initialize();
    this.ready.catch(() => { /* 首个查询会接住；避免未处理拒绝 */ });
  }

  get alive() {
    return !this.disposed && !this.connection.failed;
  }

  _initialize() {
    return (async () => {
      const result = await this.connection.request('initialize', {
        processId: null,
        rootUri: this.rootUri,
        workspaceFolders: [{ uri: this.rootUri, name: path.basename(this.root) || 'workspace' }],
        capabilities: T.CLIENT_CAPABILITIES,
        initializationOptions: this.server.initializationOptions,
      }, { timeoutMs: this.server.startupTimeoutMs });
      const caps = T.initializeCapabilities(result);
      T.negotiatePositionEncoding(caps);
      await this.connection.notify('initialized', {});
      this.capabilities = caps;
      return caps;
    })();
  }

  _onNotification(method, params) {
    if (method === 'textDocument/publishDiagnostics' && params && typeof params.uri === 'string') {
      const uri = params.uri;
      const items = Array.isArray(params.diagnostics) ? params.diagnostics : [];
      const normalized = T.normalizeDiagnostics(items);
      this.diagnosticsCache.set(uri, normalized.items);
      const serial = (this.diagnosticsSerial.get(uri) || 0) + 1;
      this.diagnosticsSerial.set(uri, serial);
      const waiters = this.diagWaiters.get(uri) || [];
      this.diagWaiters.delete(uri);
      for (const w of waiters) w.resolve({ items: normalized.items, complete: true, source: 'push' });
    }
  }

  async _onServerRequest(method, params) {
    if (method === 'workspace/configuration') {
      const items = params && Array.isArray(params.items) ? params.items : [];
      return items.map(() => this.server.configuration);
    }
    if (method === 'workspace/workspaceFolders') {
      return [{ uri: this.rootUri, name: path.basename(this.root) || 'workspace' }];
    }
    if (method === 'client/registerCapability' || method === 'client/unregisterCapability'
      || method === 'window/workDoneProgress/create') return null;
    if (method === 'workspace/applyEdit') throw new Error('workspace/applyEdit is not permitted');
    throw new Error('unsupported server request: ' + method);
  }

  _wirePosition(position) {
    return {
      line: Number(position && position.line) || 0,
      character: Number(position && position.character) || 0,
    };
  }

  _enqueue(run) {
    const previous = this.queue;
    const result = previous.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  run(operation, uri, languageId, text, position) {
    return this._enqueue(() => this._runLifecycle(operation, uri, languageId, text, position));
  }

  async _runLifecycle(operation, uri, languageId, text, position) {
    if (this.disposed) throw new LspError('LSP 实例已释放', 'LSP_DISPOSED');
    let caps;
    try { caps = await this.ready; }
    catch (e) {
      this.killNow();
      throw e;
    }
    if (!T.supportsTransientOpen(caps.textDocumentSync)) {
      throw new LspError('语言服务器不支持 didOpen/didClose，无法做临时打开查询', 'LSP_UNSUPPORTED_OPERATION');
    }
    const isDiagnostics = operation === 'diagnostics';
    const pullDiagnostics = isDiagnostics && T.hasCapability(caps, 'diagnostics');
    if (!isDiagnostics && !T.hasCapability(caps, operation)) {
      throw new LspError('语言服务器不支持 ' + operation, 'LSP_UNSUPPORTED_OPERATION');
    }

    let pushWaiter = null;
    if (isDiagnostics && !pullDiagnostics) {
      pushWaiter = this._armPushWaiter(uri);
    }

    let opened = false;
    try {
      await this.connection.notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text },
      });
      opened = true;

      // TypeScript 语言服务器在 initialize 后异步加载项目：首次 didOpen 立刻查定义，
      // 命中的可能只是 import 别名（b.ts 里的 add），而不是 a.ts 的真声明。给项目索引
      // 一个一次性短窗口；diagnostics 本身会等 publishDiagnostics，不需要再等。
      if (!isDiagnostics && !this.warmed && this.server.warmupMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.server.warmupMs));
        this.warmed = true;
      }

      if (isDiagnostics) {
        if (pullDiagnostics) {
          const payload = await this.connection.request('textDocument/diagnostic', {
            textDocument: { uri },
            identifier: 'genie',
          }, { timeoutMs: this.server.requestTimeoutMs });
          const report = T.normalizeDiagnostics(payload);
          if (report.unchanged) {
            return {
              kind: 'diagnostics',
              diagnostics: this.diagnosticsCache.get(uri) || [],
              complete: true,
              source: 'pull',
              unchanged: true,
            };
          }
          this.diagnosticsCache.set(uri, report.items);
          return { kind: 'diagnostics', diagnostics: report.items, complete: true, source: 'pull' };
        }
        const waited = await pushWaiter.promise;
        return { kind: 'diagnostics', diagnostics: waited.items, complete: waited.complete, source: 'push' };
      }

      const method = T.requestMethod(operation);
      const params = {
        textDocument: { uri },
        position: this._wirePosition(position),
      };
      if (operation === 'findReferences') params.context = { includeDeclaration: true };
      const payload = await this.connection.request(method, params, { timeoutMs: this.server.requestTimeoutMs });
      if (operation === 'hover') return { kind: 'hover', hover: T.normalizeHover(payload) };
      return {
        kind: 'locations',
        locations: T.normalizeLocations(payload),
        resolvedWorkspaceUri: this.rootUri,
      };
    } finally {
      if (pushWaiter) pushWaiter.cancel();
      if (opened && this.alive) {
        try { await this.connection.notify('textDocument/didClose', { textDocument: { uri } }); }
        catch (_) { this.killNow(); }
      }
    }
  }

  _armPushWaiter(uri) {
    const existing = this.diagnosticsCache.get(uri) || [];
    let done = false;
    let timer = null;
    let finish = null;
    const entry = {
      resolve: (v) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        const list = this.diagWaiters.get(uri) || [];
        this.diagWaiters.set(uri, list.filter((w) => w !== entry));
        finish(v);
      },
    };
    const promise = new Promise((resolve) => { finish = resolve; });
    const waiters = this.diagWaiters.get(uri) || [];
    waiters.push(entry);
    this.diagWaiters.set(uri, waiters);
    timer = setTimeout(() => entry.resolve({ items: existing, complete: false, source: 'push' }), this.server.diagnosticsTimeoutMs);
    return {
      promise,
      cancel: () => entry.resolve({ items: existing, complete: false, source: 'push' }),
    };
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.connection.failed) {
      this.killNow();
      return;
    }
    try {
      await this.connection.request('shutdown', null, { timeoutMs: this.server.shutdownTimeoutMs });
      await this.connection.notify('exit', null);
    } catch (_) { /* 已退出或拒绝 shutdown，下面强制收尸 */ }
    await this.connection.waitForExit(this.server.killGraceMs);
    this.killNow('SIGKILL');
    await this.connection.waitForExit(500);
  }

  /** 同步终止（测试清理 / 强制收尸），不做 LSP shutdown 握手。 */
  killNow(signal) {
    try { this.connection.kill(signal || 'SIGTERM'); } catch (_) { /* 已退出 */ }
  }
}

function instanceKey(serverName, root) {
  return serverName + '\u0000' + root;
}

function instanceFor(server, root) {
  const key = instanceKey(server.name, root);
  const current = state.instances.get(key);
  if (current && current.alive) return current;
  if (current) {
    current.killNow();
    state.instances.delete(key);
  }
  const created = new LspInstance(server, root);
  state.instances.set(key, created);
  return created;
}

function evict(key, inst) {
  if (state.instances.get(key) === inst) state.instances.delete(key);
  try { inst.killNow(); } catch (_) { /* 已退出 */ }
}

function formatError(e) {
  return String((e && e.message) || e);
}

async function runWithRetry(server, root, operation, file, request) {
  let attempt = 0;
  while (attempt < 2) {
    const key = instanceKey(server.name, root);
    const inst = instanceFor(server, root);
    try {
      const result = await inst.run(operation, T.pathToUri(file.path), request.languageId, file.text, request.position);
      if (!inst.alive) evict(key, inst);
      return result;
    } catch (e) {
      if (!inst.alive) evict(key, inst);
      const retryable = e && (e.code === 'LSP_SERVER_EXITED' || e.code === 'LSP_SPAWN_FAILED'
        || e.code === 'LSP_PROTOCOL_ERROR' || e.code === 'LSP_MESSAGE_TOO_LARGE');
      if (!retryable || attempt > 0) throw e;
      attempt += 1;
    }
  }
  throw new LspError('LSP 查询失败', 'LSP_ERROR');
}

function attachPaths(root, items) {
  return items.map((item) => {
    const filePath = T.uriToPath(item.uri);
    return {
      uri: item.uri,
      path: relativePath(root, filePath),
      absolutePath: filePath,
      range: item.range,
    };
  });
}

async function query(req) {
  const r = req || {};
  if (!T.OPERATIONS.includes(r.operation)) {
    throw new LspError('未知 LSP operation：' + r.operation, 'LSP_UNSUPPORTED_OPERATION');
  }
  const root = canonicalWorkspace(r.workspaceRoot);
  if (!r.filePath || typeof r.filePath !== 'string') throw new LspError('LSP 需要 file_path', 'LSP_FILE_NOT_FOUND');
  const ext = path.extname(r.filePath).toLowerCase();
  querySafe(false);
  const server = state.byExt.get(ext);
  if (!server) throw new LspError('没有语言服务器处理 ' + (ext || '无扩展名') + ' 文件', 'LSP_UNAVAILABLE');
  if (POSITION_OPS.has(r.operation)) {
    if (!r.position || !Number.isInteger(r.position.line) || !Number.isInteger(r.position.character)
      || r.position.line < 0 || r.position.character < 0) {
      throw new LspError('LSP 位置必须是零基非负整数 line/character', 'LSP_INVALID_POSITION');
    }
  }
  const file = readSource(root, r.filePath, server.maxDocumentBytes);
  const languageId = server.extensionToLanguage[ext];
  if (!languageId) throw new LspError('没有 language id 对应 ' + ext, 'LSP_UNAVAILABLE');

  const raw = await runWithRetry(server, root, r.operation, file, {
    languageId,
    position: r.position || { line: 0, character: 0 },
  });

  if (raw.kind === 'locations') {
    return {
      kind: 'locations',
      operation: r.operation,
      workspaceRoot: root,
      file: relativePath(root, file.path),
      locations: attachPaths(root, raw.locations).slice(0, server.maxLocations),
      total: raw.locations.length,
      truncated: raw.locations.length > server.maxLocations,
      server: server.name,
    };
  }
  if (raw.kind === 'hover') {
    return {
      kind: 'hover',
      operation: 'hover',
      workspaceRoot: root,
      file: relativePath(root, file.path),
      hover: raw.hover,
      server: server.name,
    };
  }
  const diagnostics = raw.diagnostics.slice(0, server.maxDiagnostics).map((d) => ({
    path: relativePath(root, file.path),
    range: d.range,
    severity: d.severity,
    severityCode: d.severityCode,
    message: String(d.message || '').slice(0, 2000),
    source: d.source,
    code: d.code,
  }));
  return {
    kind: 'diagnostics',
    operation: 'diagnostics',
    workspaceRoot: root,
    file: relativePath(root, file.path),
    diagnostics,
    total: raw.diagnostics.length,
    complete: !!raw.complete,
    sourceKind: raw.source,
    unchanged: !!raw.unchanged,
    truncated: raw.diagnostics.length > server.maxDiagnostics,
    server: server.name,
  };
}

function status() {
  let error = null;
  try { querySafe(false); }
  catch (e) { error = formatError(e); }
  const instances = [...state.instances.entries()].map(([key, inst]) => {
    const parts = key.split('\u0000');
    return {
      server: parts[0],
      workspace: parts[1] || '',
      alive: !!inst.alive,
      pid: inst.connection && inst.connection.child ? (inst.connection.child.pid || null) : null,
    };
  });
  return {
    configPath: state.configPath || configPath(),
    loaded: !!state.loaded,
    error: error || state.error,
    loadedAt: state.loadedAt || null,
    servers: (state.servers || []).map((s) => ({
      name: s.name,
      state: instances.filter((i) => i.server === s.name && i.alive).length ? 'connected' : 'idle',
      extensions: Object.keys(s.extensionToLanguage),
      command: s.command,
      workspaces: instances.filter((i) => i.server === s.name).length,
    })),
    instances,
  };
}

async function reload() {
  // 先优雅释放旧实例，再重读配置；不能先 kill 再“dispose 空表”，那等于每次 reload
  // 都跳过 shutdown/exit，只留下 SIGTERM。
  const shut = await shutdown();
  state.loaded = false;
  state.mtimeMs = -1;
  state.configPath = '';
  let loadError = null;
  try { querySafe(true); } catch (e) { loadError = formatError(e); }
  const error = [shut.error, loadError].filter(Boolean).join('; ') || null;
  return { ok: !error, error, status: status() };
}

async function shutdown() {
  const results = await Promise.allSettled([...state.instances.values()].map((inst) => inst.dispose()));
  state.instances.clear();
  const failures = results.filter((r) => r.status === 'rejected').map((r) => formatError(r.reason));
  return { ok: failures.length === 0, error: failures.length ? failures.join('; ') : null };
}

module.exports = {
  LspError, DEFAULTS, configPath, ensureLoaded, query, status, reload, shutdown,
  resetForTests, resolveExecutable, canonicalWorkspace, readSource,
};
