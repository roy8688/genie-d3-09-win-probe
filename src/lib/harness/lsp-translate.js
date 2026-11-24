'use strict';
/**
 * D3-03 LSP 纯翻译层：server capability → operation、wire payload → 规范化结果。
 * 这里没有 I/O / 进程状态，便于用 fixture 精确锁协议边界。
 */
const { fileURLToPath, pathToFileURL } = require('node:url');
const { LspError } = require('./lsp-client');

const OPERATIONS = ['goToDefinition', 'findReferences', 'goToImplementation', 'hover', 'diagnostics'];

function requestMethod(operation) {
  switch (operation) {
    case 'goToDefinition': return 'textDocument/definition';
    case 'findReferences': return 'textDocument/references';
    case 'goToImplementation': return 'textDocument/implementation';
    case 'hover': return 'textDocument/hover';
    case 'diagnostics': return 'textDocument/diagnostic';
    default: throw new LspError('unsupported LSP operation: ' + operation, 'LSP_UNSUPPORTED_OPERATION');
  }
}

function capabilityValue(capabilities, operation) {
  switch (operation) {
    case 'goToDefinition': return capabilities && capabilities.definitionProvider;
    case 'findReferences': return capabilities && capabilities.referencesProvider;
    case 'goToImplementation': return capabilities && capabilities.implementationProvider;
    case 'hover': return capabilities && capabilities.hoverProvider;
    case 'diagnostics': return capabilities && capabilities.diagnosticProvider;
    default: return false;
  }
}

function hasCapability(capabilities, operation) {
  const v = capabilityValue(capabilities, operation);
  if (v === undefined || v === false || v === null) return false;
  if (typeof v === 'boolean') return v;
  return typeof v === 'object';
}

function supportsTransientOpen(sync) {
  if (sync === undefined || sync === null) return false;
  if (typeof sync === 'number') return sync === 1 || sync === 2;
  return sync.openClose === true;
}

function isCoordinate(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isRange(v) {
  if (!v || typeof v !== 'object') return false;
  const start = v.start;
  const end = v.end;
  return !!start && !!end && isCoordinate(start.line) && isCoordinate(start.character)
    && isCoordinate(end.line) && isCoordinate(end.character);
}

function toRange(range) {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function isLocationLink(v) {
  return !!v && typeof v.targetUri === 'string' && isRange(v.targetSelectionRange);
}

function isLocation(v) {
  return !!v && typeof v.uri === 'string' && isRange(v.range);
}

function malformed(message) {
  return new LspError(message, 'LSP_MALFORMED_RESPONSE');
}

/** Location / LocationLink[] → 规范位置；null/[] 是成功空结果。 */
function normalizeLocations(payload) {
  if (payload === null || payload === undefined) return [];
  const elements = Array.isArray(payload) ? payload : [payload];
  const out = [];
  for (const el of elements) {
    if (!el || typeof el !== 'object') throw malformed('LSP location entry was not an object');
    if (isLocationLink(el)) out.push({ uri: el.targetUri, range: toRange(el.targetSelectionRange) });
    else if (isLocation(el)) out.push({ uri: el.uri, range: toRange(el.range) });
    else throw malformed('LSP navigation result was neither Location nor LocationLink');
  }
  return out;
}

function renderMarkedString(v) {
  if (typeof v === 'string') return v;
  return '```' + String(v.language || '') + '\n' + String(v.value || '') + '\n```';
}

function renderHoverContents(contents) {
  if (contents === null || contents === undefined) throw malformed('LSP hover had no contents');
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) {
    return contents.map((v) => {
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object' && typeof v.value === 'string') return renderMarkedString(v);
      throw malformed('LSP hover contained a malformed MarkedString');
    }).join('\n\n');
  }
  if (typeof contents !== 'object') throw malformed('LSP hover contents were not text');
  if (typeof contents.value !== 'string') throw malformed('LSP hover MarkupContent was malformed');
  if (contents.kind === 'markdown' || contents.kind === 'plaintext') return contents.value;
  if (typeof contents.language === 'string') return renderMarkedString(contents);
  return contents.value;
}

/** Hover → {contents, range?} 或 null。 */
function normalizeHover(payload) {
  if (payload === null || payload === undefined) return null;
  if (typeof payload !== 'object') throw malformed('LSP hover result was not an object');
  const contents = renderHoverContents(payload.contents);
  if (contents === '') return null;
  if (payload.range === undefined) return { contents };
  if (!isRange(payload.range)) throw malformed('LSP hover range was malformed');
  return { contents, range: toRange(payload.range) };
}

const SEVERITY = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };

function normalizeOneDiagnostic(d) {
  if (!d || typeof d !== 'object') throw malformed('LSP diagnostic was not an object');
  if (!isRange(d.range)) throw malformed('LSP diagnostic range was malformed');
  if (typeof d.message !== 'string') throw malformed('LSP diagnostic message was not a string');
  const code = (typeof d.code === 'number' || typeof d.code === 'string') ? d.code : null;
  return {
    range: toRange(d.range),
    severity: SEVERITY[Number(d.severity)] || 'info',
    severityCode: Number(d.severity) || 0,
    message: d.message,
    source: typeof d.source === 'string' ? d.source : '',
    code,
    tags: Array.isArray(d.tags) ? d.tags.filter((x) => Number.isInteger(x)).slice(0, 4) : [],
  };
}

/**
 * 支持三种诊断载荷：
 *  · push: publishDiagnostics.params.diagnostics（数组）
 *  · pull: {kind:'full', items:[...]}
 *  · pull: {kind:'unchanged', resultId}（返回 unchanged=true，由调用方决定是否复用缓存）
 */
function normalizeDiagnostics(payload) {
  if (payload === null || payload === undefined) return { items: [], unchanged: false };
  if (Array.isArray(payload)) return { items: payload.map(normalizeOneDiagnostic), unchanged: false };
  if (typeof payload !== 'object') throw malformed('LSP diagnostics payload was not an object');
  if (payload.kind === 'unchanged') return { items: [], unchanged: true, resultId: payload.resultId || null };
  const source = Array.isArray(payload.items) ? payload.items : (Array.isArray(payload.diagnostics) ? payload.diagnostics : null);
  if (!source) throw malformed('LSP diagnostics payload had no items');
  // documentDiagnosticReport 的 kind 只允许 full/unchanged；其他 kind 是协议错误。
  if (payload.kind !== undefined && payload.kind !== 'full') throw malformed('LSP diagnostics report kind was unknown');
  return { items: source.map(normalizeOneDiagnostic), unchanged: false, resultId: payload.resultId || null };
}

function pathToUri(absPath) {
  return pathToFileURL(absPath).href;
}

function uriToPath(uri) {
  if (typeof uri !== 'string') return '';
  if (!uri.startsWith('file:')) return uri;
  try { return fileURLToPath(uri); } catch (_) { return uri; }
}

function initializeCapabilities(result) {
  if (!result || typeof result !== 'object') throw malformed('LSP initialize result was not an object');
  const caps = result.capabilities;
  if (!caps || typeof caps !== 'object') throw malformed('LSP initialize result had no capabilities');
  return caps;
}

function negotiatePositionEncoding(caps) {
  const enc = caps && caps.positionEncoding;
  if (enc === undefined || enc === null || enc === 'utf-16') return 'utf-16';
  throw new LspError('unsupported LSP positionEncoding: ' + enc, 'LSP_UNSUPPORTED_ENCODING');
}

/** 客户端 initialize capabilities：UTF-16、配置、hover markdown、definition link。 */
const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  workspace: { configuration: true, workspaceFolders: true },
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    definition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
    publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] } },
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
  },
  window: { workDoneProgress: true },
};

module.exports = {
  OPERATIONS, requestMethod, hasCapability, supportsTransientOpen,
  normalizeLocations, normalizeHover, normalizeDiagnostics, initializeCapabilities,
  negotiatePositionEncoding, pathToUri, uriToPath, CLIENT_CAPABILITIES,
};
