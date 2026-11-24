'use strict';
/**
 * D3-10 中文字体族（2026-11-24）
 * docx 的 eastAsia 字体不能固定 PingFang SC：Windows 没这字体，Word 会回退成宋体/乱码。
 * macOS: PingFang SC；Windows: Microsoft YaHei；Linux: Noto Sans CJK SC。
 */
function platformOf(opts) { return (opts && opts.platform) || process.platform; }
function cjk(opts = {}) {
  const p = platformOf(opts);
  if (p === 'win32') return 'Microsoft YaHei';
  if (p === 'darwin') return 'PingFang SC';
  return 'Noto Sans CJK SC';
}
function stack(opts = {}) {
  const p = platformOf(opts);
  if (p === 'win32') return '"Microsoft YaHei","Segoe UI",sans-serif';
  if (p === 'darwin') return '"PingFang SC","Hiragino Sans GB",system-ui,sans-serif';
  return '"Noto Sans CJK SC","Source Han Sans SC",sans-serif';
}
module.exports = { cjk, stack };
