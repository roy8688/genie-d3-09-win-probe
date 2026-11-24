'use strict';
/**
 * Windows 路径语义（D3-09，2026-11-24）
 *
 * 这些函数不碰文件系统，只做“字符串层面的 Windows 规则”，因此可以在 macOS/Linux
 * 上被真实调用与断言。Windows 上 fs 操作再交给 Node（长路径统一加 `\\?\` 前缀）。
 */
const path = require('node:path');

function isUnc(p) {
  return /^\\\\[^\\]+\\[^\\]+/.test(String(p || ''));
}

function isExtended(p) {
  return /^\\\\\?\\/.test(String(p || ''));
}

function isDriveAbsolute(p) {
  return /^[A-Za-z]:[\\/]/.test(String(p || ''));
}

function isDriveRelative(p) {
  return /^[A-Za-z]:(?![\\/])/.test(String(p || ''));
}

/** 盘符统一大写；UNC / 扩展路径不改前缀。 */
function normalizeDrive(p) {
  const s = String(p || '');
  if (/^[A-Za-z]:/.test(s)) return s[0].toUpperCase() + s.slice(1);
  return s;
}

/**
 * 解析为 Windows 绝对路径。
 * @param {string} input
 * @param {string} [cwd] 盘符相对路径（`C:foo`）必须给 cwd，否则明确拒绝。
 * @param {{win32?: boolean}} [opts]
 */
function resolve(input, cwd, opts) {
  const o = opts || {};
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw Object.assign(new Error('路径不能为空'), { code: 'WIN_PATH_EMPTY' });
  if (raw.includes('\0')) throw Object.assign(new Error('路径含 NUL'), { code: 'WIN_PATH_NUL' });
  if (isDriveRelative(raw)) {
    throw Object.assign(new Error('盘符相对路径必须补全为绝对路径：' + raw), { code: 'WIN_PATH_DRIVE_RELATIVE' });
  }
  if (!o.win32 && process.platform !== 'win32') {
    // 纯函数调用方显式声明 win32；不给默认的平台混用。
    throw Object.assign(new Error('非 Windows 平台请用 opts.win32=true'), { code: 'WIN_PATH_PLATFORM' });
  }
  const base = cwd ? normalizeDrive(path.win32.resolve(cwd)) : 'C:\\';
  const abs = normalizeDrive(path.win32.resolve(base, normalizeDrive(raw)));
  if (!isDriveAbsolute(abs) && !isUnc(abs)) {
    throw Object.assign(new Error('不是 Windows 绝对路径：' + abs), { code: 'WIN_PATH_NOT_ABSOLUTE' });
  }
  return abs;
}

/** 260 限制兼容：绝对路径转 `\\?\` / `\\?\UNC\`，已是扩展路径则原样返回。 */
function extendedLength(p) {
  const s = normalizeDrive(String(p || ''));
  if (isExtended(s)) return s;
  if (isUnc(s)) return '\\\\?\\UNC\\' + s.replace(/^\\\\/, '');
  if (isDriveAbsolute(s)) return '\\\\?\\' + s;
  return s;
}

/** Windows 比较不区分大小写；去掉尾部分隔符后再比。 */
function normalizeForCompare(p) {
  const s = normalizeDrive(String(p || '')).replace(/[\\/]+$/, '');
  return s.toLowerCase();
}

/** target 是否在 root 内（含 root 本身）；盘符大小写不敏感。 */
function inside(root, target) {
  const r = normalizeForCompare(root);
  const t = normalizeForCompare(target);
  if (!r || !t) return false;
  if (t === r) return true;
  const sep = r.endsWith('\\') ? '' : '\\';
  return t.startsWith(r + sep);
}

/** 长路径是否超过 MAX_PATH（不把 `\\?\` 的 4 个字符算进去）。 */
function exceedsMaxPath(p, max) {
  const limit = Number(max || 260);
  const s = String(p || '').replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '');
  return s.length > limit;
}

module.exports = {
  isUnc, isExtended, isDriveAbsolute, isDriveRelative,
  normalizeDrive, resolve, extendedLength, normalizeForCompare, inside, exceedsMaxPath,
  MAX_PATH: 260,
};
