'use strict';
/**
 * D3-10 原生文件对话框（2026-11-24）
 *
 * Electron 里有自己的 dialog；这里给「没有 Electron 宿主」的 CLI/内核场景兜底：
 *   macOS  : osascript（choose file / folder / file name）
 *   Linux  : zenity（--file-selection）
 *   Windows: PowerShell + System.Windows.Forms
 *
 * 返回值统一 `{ok, canceled, paths}`；工具缺失/用户取消都走结构化结果，
 * 不把“空数组”当作“用户选了空路径”。
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

function execFn(opts) {
  if (opts && typeof opts.execFileSync === 'function') return opts.execFileSync;
  return execFileSync;
}
function platformOf(opts) { return (opts && opts.platform) || process.platform; }
function envOf(opts) { return (opts && opts.env) || process.env; }

function asList(out) {
  return String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function appleQuote(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function psQuote(s) {
  return String(s == null ? '' : s).replace(/'/g, "''");
}

function filterToApple(filters) {
  // [[名称, 扩展名...], ...] → {"png","jpg"}；无筛选器时不生成子句。
  const exts = [];
  for (const f of (filters || [])) {
    for (const e of (f || []).slice(1)) if (e && e !== '*') exts.push(String(e));
  }
  if (!exts.length) return '';
  return ' of type {' + exts.map((e) => '"' + appleQuote(e) + '"').join(', ') + '}';
}

function macDialog(mode, req, opts) {
  const title = appleQuote(req.title || '选择');
  const start = req.defaultPath ? ' default location POSIX file "' + appleQuote(req.defaultPath) + '"' : '';
  let script;
  if (mode === 'folder') {
    script = 'POSIX path of (choose folder with prompt "' + title + '"' + start + ')';
  } else if (mode === 'save') {
    const name = appleQuote(req.defaultName || '未命名');
    script = 'POSIX path of (choose file name with prompt "' + title + '" default name "' + name + '"' + start + ')';
  } else {
    const multiple = req.multiple ? ' with multiple selections allowed' : '';
    const filters = filterToApple(req.filters);
    script = 'set xs to choose file with prompt "' + title + '"' + filters + start + multiple + '\n'
      + 'set out to ""\n'
      + 'repeat with f in xs\n'
      + 'set out to out & POSIX path of f & linefeed\n'
      + 'end repeat\n'
      + 'return out';
  }
  try {
    const out = execFn(opts)('osascript', ['-e', script], { encoding: 'utf8', timeout: 300000 });
    const paths = asList(out);
    return { ok: true, canceled: paths.length === 0, paths, platform: 'darwin' };
  } catch (e) {
    // AppleScript 用户取消返回 -128；按取消处理，不当作失败。
    if (e && (e.code === 1 || /User canceled|-128/i.test(String(e.message || ''))) && /User canceled|-128/.test(String(e.stderr || e.message || ''))) {
      return { ok: true, canceled: true, paths: [], platform: 'darwin' };
    }
    return { ok: false, canceled: false, paths: [], platform: 'darwin', error: (e && e.message) || String(e) };
  }
}

function linuxDialog(mode, req, opts) {
  const args = ['--file-selection'];
  if (req.title) args.push('--title=' + String(req.title));
  if (req.defaultPath) args.push('--filename=' + String(req.defaultPath));
  if (mode === 'folder') args.push('--directory');
  if (mode === 'save') args.push('--save', '--confirm-overwrite');
  if (req.multiple && mode !== 'save') args.push('--multiple', '--separator=\n');
  for (const f of (req.filters || [])) {
    const exts = (f || []).slice(1).filter((x) => x && x !== '*').map((x) => '*.' + x);
    if (exts.length) args.push('--file-filter=' + String((f && f[0]) || '文件') + ' | ' + exts.join(' '));
  }
  try {
    const out = execFn(opts)('zenity', args, { encoding: 'utf8', timeout: 300000 });
    const paths = asList(out);
    return { ok: true, canceled: paths.length === 0, paths, platform: 'linux' };
  } catch (e) {
    if (e && (e.status === 1 || e.code === 1)) return { ok: true, canceled: true, paths: [], platform: 'linux' };
    return {
      ok: false, canceled: false, paths: [], platform: 'linux',
      code: e && e.code === 'ENOENT' ? 'DIALOG_TOOL_UNAVAILABLE' : 'DIALOG_FAILED',
      error: e && e.code === 'ENOENT' ? '未安装 zenity' : ((e && e.message) || String(e)),
    };
  }
}

function winFilter(filters) {
  return (filters || []).map((f) => {
    const name = String((f && f[0]) || '文件');
    const exts = (f || []).slice(1).filter(Boolean).map((x) => (x === '*' ? '*.*' : '*.' + x));
    return name + '|' + (exts.length ? exts.join(';') : '*.*');
  }).join('|');
}

function winDialog(mode, req, opts) {
  const title = psQuote(req.title || '选择');
  const filter = psQuote(winFilter(req.filters));
  const defaultName = psQuote(req.defaultName || '');
  const initial = psQuote(req.defaultPath || '');
  let body;
  if (mode === 'folder') {
    body = "Add-Type -AssemblyName System.Windows.Forms\n"
      + "$d = New-Object System.Windows.Forms.FolderBrowserDialog\n"
      + "$d.Description = '" + title + "'\n"
      + (initial ? "$d.SelectedPath = '" + initial + "'\n" : '')
      + "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }";
  } else if (mode === 'save') {
    body = "Add-Type -AssemblyName System.Windows.Forms\n"
      + "$d = New-Object System.Windows.Forms.SaveFileDialog\n"
      + "$d.Title = '" + title + "'\n"
      + (filter ? "$d.Filter = '" + filter + "'\n" : '')
      + (defaultName ? "$d.FileName = '" + defaultName + "'\n" : '')
      + (initial ? "$d.InitialDirectory = '" + initial + "'\n" : '')
      + "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.FileName }";
  } else {
    body = "Add-Type -AssemblyName System.Windows.Forms\n"
      + "$d = New-Object System.Windows.Forms.OpenFileDialog\n"
      + "$d.Title = '" + title + "'\n"
      + (filter ? "$d.Filter = '" + filter + "'\n" : '')
      + "$d.Multiselect = $" + (req.multiple ? 'true' : 'false') + "\n"
      + (initial ? "$d.InitialDirectory = '" + initial + "'\n" : '')
      + "if ($d.ShowDialog() -eq 'OK') { $d.FileNames | ForEach-Object { Write-Output $_ } }";
  }
  const ps = envOf(opts).GENIE_POWERSHELL || 'powershell.exe';
  try {
    const out = execFn(opts)(ps, ['-NoProfile', '-STA', '-Command', body], {
      encoding: 'utf8', timeout: 300000, windowsHide: true,
    });
    const paths = asList(out);
    return { ok: true, canceled: paths.length === 0, paths, platform: 'win32' };
  } catch (e) {
    return { ok: false, canceled: false, paths: [], platform: 'win32', error: (e && e.message) || String(e) };
  }
}

function openFile(req = {}, opts = {}) {
  const platform = platformOf(opts);
  if (platform === 'darwin') return macDialog('open', req, opts);
  if (platform === 'win32') return winDialog('open', req, opts);
  return linuxDialog('open', req, opts);
}

function openFolder(req = {}, opts = {}) {
  const platform = platformOf(opts);
  if (platform === 'darwin') return macDialog('folder', req, opts);
  if (platform === 'win32') return winDialog('folder', req, opts);
  return linuxDialog('folder', req, opts);
}

function saveFile(req = {}, opts = {}) {
  const platform = platformOf(opts);
  if (platform === 'darwin') return macDialog('save', req, opts);
  if (platform === 'win32') return winDialog('save', req, opts);
  return linuxDialog('save', req, opts);
}

module.exports = { openFile, openFolder, saveFile, filterToApple, winFilter };
