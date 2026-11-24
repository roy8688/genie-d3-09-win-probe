'use strict';
/**
 * D3-10 打开应用 / 打开文件（2026-11-24）
 *
 * 业务代码不许再写 `open -a` 或 `start ""`。macOS 用 open，Windows 用
 * `Start-Process`，Linux 用 xdg-open；失败返回结构化错误，不假装成功。
 *
 * 所有参数走 argv（execFileSync），不拼 shell 字符串；只有 PowerShell 必须
 * 传一段脚本文本时，单引号按 `''` 转义。
 */

const { execFileSync } = require('node:child_process');

function execFn(opts) {
  if (opts && typeof opts.execFileSync === 'function') return opts.execFileSync;
  return execFileSync;
}

function platformOf(opts) { return (opts && opts.platform) || process.platform; }
function envOf(opts) { return (opts && opts.env) || process.env; }

function powershell(opts) {
  const env = envOf(opts);
  return env.GENIE_POWERSHELL || 'powershell.exe';
}

function psQuote(value) {
  return String(value == null ? '' : value).replace(/'/g, "''");
}

function result(ok, extra) {
  return Object.assign({ ok }, extra || {});
}

/** 打开一个已安装应用（macOS 应用名 / Windows exe / Linux desktop 名）。 */
function openApp(appName, opts = {}) {
  const app = String(appName == null ? '' : appName).trim();
  if (!app) return result(false, { code: 'APP_REQUIRED', error: '缺少应用名' });
  const platform = platformOf(opts);
  try {
    if (platform === 'darwin') {
      execFn(opts)('open', ['-a', app], { stdio: 'ignore' });
      return result(true, { platform, app });
    }
    if (platform === 'win32') {
      execFn(opts)(powershell(opts), ['-NoProfile', '-NonInteractive', '-Command', "Start-Process -FilePath '" + psQuote(app) + "'"], {
        stdio: 'ignore', windowsHide: true,
      });
      return result(true, { platform, app });
    }
    execFn(opts)('xdg-open', [app], { stdio: 'ignore' });
    return result(true, { platform, app });
  } catch (e) {
    return result(false, { code: e && e.code || 'OPEN_APP_FAILED', error: (e && e.message) || String(e), platform, app });
  }
}

/** 用系统默认程序打开文件/目录/URL。 */
function openPath(target, opts = {}) {
  const p = String(target == null ? '' : target).trim();
  if (!p) return result(false, { code: 'PATH_REQUIRED', error: '缺少路径' });
  const platform = platformOf(opts);
  try {
    if (platform === 'darwin') {
      execFn(opts)('open', [p], { stdio: 'ignore' });
    } else if (platform === 'win32') {
      execFn(opts)(powershell(opts), ['-NoProfile', '-NonInteractive', '-Command', "Start-Process -FilePath '" + psQuote(p) + "'"], {
        stdio: 'ignore', windowsHide: true,
      });
    } else {
      execFn(opts)('xdg-open', [p], { stdio: 'ignore' });
    }
    return result(true, { platform, path: p });
  } catch (e) {
    return result(false, { code: e && e.code || 'OPEN_PATH_FAILED', error: (e && e.message) || String(e), platform, path: p });
  }
}

/**
 * 用 WPS 打开一个文件。macOS 走 `open -a wpsoffice`；Windows 走
 * `Start-Process wps.exe -ArgumentList <path>`；Linux 优先 `wps`，没有则降级 xdg-open。
 */
function openWithWps(filePath, opts = {}) {
  const p = String(filePath == null ? '' : filePath).trim();
  if (!p) return result(false, { code: 'PATH_REQUIRED', error: '缺少文件路径' });
  const platform = platformOf(opts);
  if (platform === 'darwin') {
    try {
      execFn(opts)('open', ['-a', 'wpsoffice', p], { stdio: 'ignore' });
      return result(true, { platform, path: p, app: 'wpsoffice' });
    } catch (e) {
      return result(false, { code: e && e.code || 'OPEN_WPS_FAILED', error: (e && e.message) || String(e), platform, path: p });
    }
  }
  if (platform === 'win32') {
    try {
      execFn(opts)(powershell(opts), ['-NoProfile', '-NonInteractive', '-Command',
        "Start-Process -FilePath 'wps.exe' -ArgumentList '" + psQuote(p) + "'"], {
        stdio: 'ignore', windowsHide: true,
      });
      return result(true, { platform, path: p, app: 'wps.exe' });
    } catch (e) {
      return openPath(p, opts);
    }
  }
  try {
    execFn(opts)('wps', [p], { stdio: 'ignore' });
    return result(true, { platform, path: p, app: 'wps' });
  } catch (_) {
    const r = openPath(p, opts);
    return Object.assign({}, r, { degraded: 'wps 不在 PATH，已改用系统默认程序' });
  }
}

/**
 * macOS 启动 .app 时的底层参数（Electron 原生面板助手用）。
 * 只给 macOS 业务用；非 darwin 返回 null，调用方走自己的平台实现。
 */
function macOpenArgs(args, opts = {}) {
  if (platformOf(opts) !== 'darwin') return null;
  if (!Array.isArray(args)) return null;
  return ['open'].concat(args.map(String));
}

module.exports = { openApp, openPath, openWithWps, macOpenArgs, psQuote };
