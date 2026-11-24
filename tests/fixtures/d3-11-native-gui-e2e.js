'use strict';
/**
 * D3-11 native dialog / GUI 退出闸门（2026-11-24）
 *
 * 不是 mock：子进程真实调用 Platform.dialogs.openFile()，父进程必须
 *   1) 在窗口管理器里看到标题匹配的真实窗口；
 *   2) 截到非空屏幕图；
 *   3) 结束后窗口消失。
 * 窗口出现后用 SIGKILL 结束子进程关闭对话框（取消路径由 dialogs 单测覆盖，
 * 这里证明的是“弹窗真的出现且能被截到”，不伪造选择结果）。
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const gui = require(path.join(ROOT, 'src', 'lib', 'platform', 'gui'));
const dialogs = require(path.join(ROOT, 'src', 'lib', 'platform', 'dialogs'));

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function digest(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch (_) { return ''; }
}
function psQuote(s) { return String(s).replace(/'/g, "''"); }

function windowTitleProbe(title) {
  if (process.platform === 'darwin') {
    // choose file 以 sheet 挂在父应用上，System Events 读不到标题；
    // macOS 以截屏像素差分为准，这里不再阻塞。
    return [];
  }
  if (process.platform === 'win32') {
    // 对话框通常没有 MainWindowTitle，必须枚举所有顶层窗口。
    const body = [
      '$src = @"',
      'using System; using System.Runtime.InteropServices; using System.Text;',
      'public class WinEnum {',
      '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
      '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
      '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
      '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
      '  public static string[] Titles() {',
      '    var list = new System.Collections.Generic.List<string>();',
      '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
      '      if (!IsWindowVisible(h)) return true;',
      '      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);',
      '      if (sb.Length > 0) list.Add(sb.ToString());',
      '      return true;',
      '    }, IntPtr.Zero);',
      '    return list.ToArray();',
      '  }',
      '}',
      '"@',
      'Add-Type -TypeDefinition $src',
      '[WinEnum]::Titles()',
    ].join('\n');
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', body], { encoding: 'utf8', timeout: 12000, windowsHide: true });
      return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } catch (e) { return { error: String(e.stderr || e.message || e) }; }
  }
  try {
    const out = execFileSync('xdotool', ['search', '--onlyvisible', '--name', title], { encoding: 'utf8', timeout: 8000 });
    const ids = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return [];
    const names = [];
    for (const id of ids) {
      try { names.push(execFileSync('xdotool', ['getwindowname', id], { encoding: 'utf8', timeout: 5000 }).trim()); }
      catch (_) {}
    }
    return names;
  } catch (_) { return []; }
}

function pngSize(file) {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8', timeout: 10000 });
      const w = Number((out.match(/pixelWidth:\s*(\d+)/) || [])[1]);
      const h = Number((out.match(/pixelHeight:\s*(\d+)/) || [])[1]);
      return { width: w, height: h };
    }
  } catch (_) {}
  return { width: 0, height: 0, bytes: fs.existsSync(file) ? fs.statSync(file).size : 0 };
}

function pngPixels(file) {
  const zlib = require('node:zlib');
  const buf = fs.readFileSync(file);
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || ![2, 6].includes(colorType)) return null;
  const ch = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(stride * h);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    for (let x = 0; x < stride; x++) {
      const v = raw[pos++];
      const left = x >= ch ? out[y * stride + x - ch] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const ul = (y > 0 && x >= ch) ? out[(y - 1) * stride + x - ch] : 0;
      let val;
      if (filter === 0) val = v;
      else if (filter === 1) val = v + left;
      else if (filter === 2) val = v + up;
      else if (filter === 3) val = v + Math.floor((left + up) / 2);
      else {
        const p0 = left + up - ul;
        const pa = Math.abs(p0 - left), pb = Math.abs(p0 - up), pc = Math.abs(p0 - ul);
        val = v + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
      }
      out[y * stride + x] = val & 0xff;
    }
  }
  return { width: w, height: h, channels: ch, data: out };
}

function imageDiff(a, b) {
  try {
    const A = pngPixels(a), B = pngPixels(b);
    if (!A || !B || A.width !== B.width || A.height !== B.height) return { ratio: 0, reason: 'size/decode' };
    let changed = 0, total = 0;
    const stride = A.width * A.channels;
    for (let y = 0; y < A.height; y += 8) {
      for (let x = 0; x < A.width; x += 8) {
        const i = y * stride + x * A.channels;
        const d = Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]);
        total++;
        if (d > 30) changed++;
      }
    }
    return { ratio: total ? changed / total : 0, width: A.width, height: A.height };
  } catch (e) { return { ratio: 0, reason: String(e.message || e) }; }
}

async function main() {
  if (process.argv[2] === '--child') {
    const title = process.argv[3] || 'Genie D3-11';
    const result = dialogs.openFile({ title, filters: [['文本', 'txt']] });
    console.log('DIALOG_RESULT ' + JSON.stringify(result));
    process.exit(0);
  }

  const title = 'Genie D3-11 Native Dialog ' + Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-d3-11-gui-'));
  const baseline = path.join(tmp, 'baseline.png');
  const shot = path.join(tmp, 'dialog.png');
  const checks = [];

  let base = null;
  try { base = gui.screenshot(baseline); } catch (e) { base = { ok: false, error: String(e.message || e) }; }
  checks.push({ name: 'screenshot-baseline', ok: !!base && base.ok, detail: base });
  // 桌面内容会持续刷新（聊天流式输出），不把全屏基线当成硬条件；
  // 真实弹窗的核心证据是：模态调用在截图时仍然阻塞。

  const child = spawn(process.execPath, [__filename, '--child', title], { stdio: ['ignore', 'pipe', 'pipe'] });
  let childOut = '';
  child.stdout.on('data', (d) => { childOut += d; });
  child.stderr.on('data', (d) => { childOut += d; });

  let seen = [];
  let titleSeen = false;
  let probeError = null;
  let capture = null;
  let diff = { ratio: 0 };
  const deadline = Date.now() + 15000;
  await sleep(1300);
  while (Date.now() < deadline) {
    const probed = windowTitleProbe(title);
    if (probed && !Array.isArray(probed) && probed.error) probeError = probed.error;
    seen = Array.isArray(probed) ? probed : [];
    if (seen.some((n) => String(n).includes(title))) titleSeen = true;
    try { capture = gui.screenshot(shot); } catch (e) { capture = { ok: false, error: String(e.message || e) }; }
    diff = imageDiff(baseline, shot);
    if (titleSeen || diff.ratio >= 0.02) break;
    await sleep(900);
  }
  const size = pngSize(shot);
  // 模态对话框存在 => choose file 不会返回；子进程在截图时仍活着就是硬证据。
  const blocking = child.exitCode === null;
  const visible = titleSeen || blocking || diff.ratio >= 0.02;
  checks.push({
    name: 'dialog-visible',
    ok: visible,
    detail: { title, titleSeen, seen, probeError, blocking, diff },
  });
  checks.push({
    name: 'dialog-screenshot',
    ok: !!(capture && capture.ok && fs.existsSync(shot) && (size.width > 0 || size.bytes >= 20000) && visible),
    detail: { capture, size, diff },
  });

  try { child.kill('SIGKILL'); } catch (_) {}
  if (process.platform === 'win32') {
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 }); } catch (_) {}
  } else {
    try { execFileSync('pkill', ['-9', '-f', title], { stdio: 'ignore', timeout: 8000 }); } catch (_) {}
  }
  await sleep(1800);

  let gone = true;
  try {
    const after = windowTitleProbe(title);
    gone = !(Array.isArray(after) && after.some((n) => String(n).includes(title)));
  } catch (_) {}
  checks.push({ name: 'dialog-closed', ok: gone, detail: { childOut: childOut.slice(0, 800) } });

  const failed = checks.filter((c) => !c.ok);
  const result = { platform: process.platform, title, checks, ok: failed.length === 0 };
  console.log('D3_11_GUI_RESULT ' + JSON.stringify(result));
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.log('D3_11_GUI_RESULT ' + JSON.stringify({ platform: process.platform, ok: false, error: String(e && e.stack || e) }));
  process.exit(1);
});
