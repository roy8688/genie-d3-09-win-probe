'use strict';
/**
 * D3-10 GUI 适配器（2026-11-24）
 *
 * 截图 / 点击 / 输入 / 快捷键在三平台没有统一工具：
 *   macOS  : screencapture / cliclick / osascript
 *   Linux  : grim|gnome-screenshot|import / xdotool
 *   Windows: PowerShell + System.Drawing / user32 / SendKeys
 *
 * 原则：工具缺失返回 `TOOL_UNAVAILABLE`，绝不把“记录动作”当成“已经点击/输入”。
 * 测试可注入 execFileSync / toolExists，不需要真的开一个桌面。
 */

const { execFileSync } = require('node:child_process');

function execFn(opts) { return (opts && opts.execFileSync) || execFileSync; }
function platformOf(opts) { return (opts && opts.platform) || process.platform; }
function envOf(opts) { return (opts && opts.env) || process.env; }

function toolExists(name, opts = {}) {
  if (typeof opts.toolExists === 'function') return !!opts.toolExists(name);
  try {
    if (platformOf(opts) === 'win32') {
      execFn(opts)('where.exe', [name], { stdio: 'ignore', windowsHide: true });
    } else {
      execFn(opts)('which', [name], { stdio: 'ignore' });
    }
    return true;
  } catch (_) {
    return false;
  }
}

function psQuote(s) { return String(s == null ? '' : s).replace(/'/g, "''"); }
function appleQuote(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

/** 执行 AppleScript（仅 macOS）；供 WPS 等需要 System Events 的调用点使用。 */
function appleScript(script, opts = {}) {
  if (platformOf(opts) !== 'darwin') {
    return { ok: false, code: 'APPLESCRIPT_UNSUPPORTED', error: 'AppleScript 只在 macOS 可用' };
  }
  try {
    execFn(opts)('osascript', ['-e', String(script)], { stdio: 'ignore', timeout: 30000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e && e.code || 'APPLESCRIPT_FAILED', error: (e && e.message) || String(e) };
  }
}

function powershell(opts) { return envOf(opts).GENIE_POWERSHELL || 'powershell.exe'; }

function screenshot(file, opts = {}) {
  const platform = platformOf(opts);
  const exec = execFn(opts);
  if (platform === 'darwin') {
    exec('screencapture', ['-x', file], { stdio: 'ignore' });
    return { ok: true, tool: 'screencapture' };
  }
  if (platform === 'win32') {
    const body = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing\n"
      + "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds\n"
      + "$bmp=New-Object Drawing.Bitmap $b.Width,$b.Height\n"
      + "$g=[Drawing.Graphics]::FromImage($bmp)\n"
      + "$g.CopyFromScreen($b.Location,[Drawing.Point]::Empty,$b.Size)\n"
      + "$bmp.Save('" + psQuote(file) + "',[Drawing.Imaging.ImageFormat]::Png)";
    exec(powershell(opts), ['-NoProfile', '-STA', '-Command', body], { stdio: 'ignore', windowsHide: true, timeout: 30000 });
    return { ok: true, tool: 'powershell-screen' };
  }
  const cands = [
    { tool: 'grim', args: ['-t', 'png', file] },
    { tool: 'gnome-screenshot', args: ['-f', file] },
    { tool: 'scrot', args: ['-o', file] },
    { tool: 'import', args: ['-window', 'root', file] },
  ];
  for (const c of cands) {
    if (!toolExists(c.tool, opts)) continue;
    exec(c.tool, c.args, { stdio: 'ignore', timeout: 30000 });
    return { ok: true, tool: c.tool };
  }
  return { ok: false, code: 'TOOL_UNAVAILABLE', error: '需要 grim / gnome-screenshot / ImageMagick import 之一' };
}

function click(x, y, opts = {}) {
  const platform = platformOf(opts);
  if (platform === 'darwin') {
    if (!toolExists('cliclick', opts)) return { ok: false, code: 'TOOL_UNAVAILABLE', error: '未安装 cliclick' };
    execFn(opts)('cliclick', ['c:' + x + ',' + y], { stdio: 'ignore' });
    return { ok: true, tool: 'cliclick' };
  }
  if (platform === 'win32') {
    const body = "Add-Type @\"\nusing System.Runtime.InteropServices;\npublic class GenieMouse {\n"
      + "[DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x,int y);\n"
      + "[DllImport(\"user32.dll\")] public static extern void mouse_event(int f,int dx,int dy,int d,int e);\n}\n\"@\n"
      + "[GenieMouse]::SetCursorPos(" + x + "," + y + ")\n"
      + "[GenieMouse]::mouse_event(2,0,0,0,0)\n[GenieMouse]::mouse_event(4,0,0,0,0)";
    execFn(opts)(powershell(opts), ['-NoProfile', '-Command', body], { stdio: 'ignore', windowsHide: true });
    return { ok: true, tool: 'user32' };
  }
  if (!toolExists('xdotool', opts)) return { ok: false, code: 'TOOL_UNAVAILABLE', error: '未安装 xdotool' };
  execFn(opts)('xdotool', ['mousemove', String(x), String(y), 'click', '1'], { stdio: 'ignore' });
  return { ok: true, tool: 'xdotool' };
}

function windowsSendKeys(text) {
  // SendKeys 把 + ^ % ~ ( ) { } [ ] 当控制符；逐字转义。
  return String(text).replace(/([+^%~(){}[\]])/g, '{$1}');
}

function typeText(text, opts = {}) {
  const platform = platformOf(opts);
  if (platform === 'darwin') {
    const lines = String(text).split(/\r?\n/);
    const script = 'tell application "System Events" to keystroke "' + lines
      .map(appleQuote).join('\\n') + '"';
    execFn(opts)('osascript', ['-e', script], { stdio: 'ignore' });
    return { ok: true, tool: 'osascript' };
  }
  if (platform === 'win32') {
    const body = "Add-Type -AssemblyName System.Windows.Forms\n"
      + "[System.Windows.Forms.SendKeys]::SendWait('" + psQuote(windowsSendKeys(text)) + "')";
    execFn(opts)(powershell(opts), ['-NoProfile', '-STA', '-Command', body], { stdio: 'ignore', windowsHide: true });
    return { ok: true, tool: 'SendKeys' };
  }
  if (!toolExists('xdotool', opts)) return { ok: false, code: 'TOOL_UNAVAILABLE', error: '未安装 xdotool' };
  execFn(opts)('xdotool', ['type', '--clearmodifiers', '--', String(text)], { stdio: 'ignore' });
  return { ok: true, tool: 'xdotool' };
}

function winShortcut(keys) {
  return String(keys || '').split('+').map((k) => {
    const s = k.trim().toLowerCase();
    if (s === 'cmd' || s === 'ctrl' || s === 'control') return '^';
    if (s === 'alt') return '%';
    if (s === 'shift') return '+';
    if (s.length === 1) return s;
    const named = { enter: '{ENTER}', tab: '{TAB}', esc: '{ESC}', space: ' ', backspace: '{BACKSPACE}', delete: '{DELETE}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}' };
    return named[s] || s;
  }).join('');
}

function pressShortcut(keys, opts = {}) {
  const platform = platformOf(opts);
  if (platform === 'darwin') {
    if (!toolExists('cliclick', opts)) return { ok: false, code: 'TOOL_UNAVAILABLE', error: '未安装 cliclick' };
    execFn(opts)('cliclick', ['k:' + String(keys || '')], { stdio: 'ignore' });
    return { ok: true, tool: 'cliclick' };
  }
  if (platform === 'win32') {
    const body = "Add-Type -AssemblyName System.Windows.Forms\n"
      + "[System.Windows.Forms.SendKeys]::SendWait('" + psQuote(winShortcut(keys)) + "')";
    execFn(opts)(powershell(opts), ['-NoProfile', '-STA', '-Command', body], { stdio: 'ignore', windowsHide: true });
    return { ok: true, tool: 'SendKeys' };
  }
  if (!toolExists('xdotool', opts)) return { ok: false, code: 'TOOL_UNAVAILABLE', error: '未安装 xdotool' };
  const xkeys = String(keys || '').replace(/cmd|control/gi, 'ctrl').replace(/\+/g, '+');
  execFn(opts)('xdotool', ['key', xkeys], { stdio: 'ignore' });
  return { ok: true, tool: 'xdotool' };
}

function capabilities(opts = {}) {
  const platform = platformOf(opts);
  if (platform === 'darwin') {
    return { platform, screenshot: true, click: toolExists('cliclick', opts), type: true, shortcut: toolExists('cliclick', opts), openApp: true };
  }
  if (platform === 'win32') {
    return { platform, screenshot: true, click: true, type: true, shortcut: true, openApp: true };
  }
  return {
    platform, screenshot: ['grim', 'gnome-screenshot', 'import'].some((t) => toolExists(t, opts)),
    click: toolExists('xdotool', opts), type: toolExists('xdotool', opts),
    shortcut: toolExists('xdotool', opts), openApp: toolExists('xdg-open', opts),
  };
}

module.exports = { toolExists, screenshot, click, typeText, pressShortcut, capabilities, windowsSendKeys, appleScript };
