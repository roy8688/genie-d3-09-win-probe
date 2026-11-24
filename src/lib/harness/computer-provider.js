'use strict';
/**
 * D3-08：电脑操作 provider（截图 / 点击 / 输入 / 快捷键 / 打开应用）
 *
 * 只做三件事：
 *   1) 在触达 GUI 之前判定授权（InteractionAccess.assert）与沙箱边界；
 *   2) 调 gui-controller 的真命令；
 *   3) 把失败原样返回，绝不把“未安装 cliclick / 无辅助功能权限”包装成成功。
 *
 * 停止键：Access.stop() 后这里每个入口都会在 1 个检查点内抛 AUTH_STOPPED；
 * 已经发出的 cliclick 是毫秒级同步命令，无法中途撤回，因此不承诺“打断正在执行的点击”，
 * 只承诺“后续动作一律不再执行”。
 */

const Access = require('./interaction-access');
const Browser = require('./browser-provider');
const GuiController = require('../gui-controller');

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function sandboxBlockReason(ctx) {
  const s = ctx && ctx.sandbox;
  if (!s || typeof s !== 'object') return '';
  if (s.enabled === false) return '';
  const mode = String(s.mode || '');
  if (!mode) return '';
  // danger-full-access 才允许 GUI：截图/点击/输入天然越过工作区边界。
  if (mode !== 'danger-full-access') return mode;
  return '';
}

class ComputerProvider {
  constructor(controller) {
    this.controller = controller || GuiController;
  }

  _ready(ownerKey, ctx) {
    const owner = String(ownerKey || '').trim();
    if (!owner) throw fail('COMPUTER_OWNER_REQUIRED', '缺少会话 owner');
    const blocked = sandboxBlockReason(ctx);
    if (blocked) {
      throw fail('GUI_SANDBOX_DENIED', '当前沙箱模式为 ' + blocked + '；截图/点击/输入不进沙箱，需完全权限且显式授权');
    }
    Access.assert(owner, 'computer');
    return owner;
  }

  capabilities() { return this.controller.capabilities(); }

  screenshot(ownerKey, args, ctx) {
    this._ready(ownerKey, ctx);
    const name = String((args && args.name) || 'computer').slice(0, 60);
    const r = this.controller.screenshot(name);
    if (!r || !r.ok) throw fail((r && r.code) || 'COMPUTER_SCREENSHOT_FAILED', (r && r.error) || '截图失败', r);
    return { content: '电脑截图已保存：' + r.path + '（' + (r.bytes || 0) + ' bytes）', raw: r };
  }

  click(ownerKey, args, ctx) {
    this._ready(ownerKey, ctx);
    const a = args || {};
    const r = this.controller.click(a.x, a.y);
    if (!r || !r.ok) throw fail((r && r.code) || 'COMPUTER_CLICK_FAILED', (r && r.error) || '点击失败', r);
    return { content: '已点击 (' + r.x + ', ' + r.y + ')', raw: r };
  }

  type(ownerKey, args, ctx) {
    this._ready(ownerKey, ctx);
    const a = args || {};
    const text = String(a.text == null ? '' : a.text);
    if (!text) throw fail('COMPUTER_TYPE_ARGS', '输入文本为空');
    if (text.length > 4000) throw fail('COMPUTER_TYPE_TOO_LONG', '单次输入超过 4000 字符');
    const r = this.controller.typeText(text);
    if (!r || !r.ok) throw fail((r && r.code) || 'COMPUTER_TYPE_FAILED', (r && r.error) || '输入失败', r);
    return { content: '已输入 ' + r.chars + ' 个字符', raw: r };
  }

  key(ownerKey, args, ctx) {
    this._ready(ownerKey, ctx);
    const a = args || {};
    const keys = String(a.keys || '').trim();
    if (!keys) throw fail('COMPUTER_KEY_ARGS', '缺少 keys，例如 cmd+v');
    const r = this.controller.pressShortcut(keys);
    if (!r || !r.ok) throw fail((r && r.code) || 'COMPUTER_KEY_FAILED', (r && r.error) || '按键失败', r);
    return { content: '已按快捷键 ' + keys, raw: r };
  }

  openApp(ownerKey, args, ctx) {
    this._ready(ownerKey, ctx);
    const a = args || {};
    const app = String(a.app || '').trim();
    if (!app) throw fail('COMPUTER_APP_REQUIRED', '缺少应用名');
    const r = this.controller.openApp(app);
    if (!r || !r.ok) throw fail((r && r.code) || 'COMPUTER_OPEN_APP_FAILED', (r && r.error) || '打开应用失败', r);
    return { content: '已打开 ' + app, raw: r };
  }

  /**
   * 停止键：先吊销授权（后续所有入口立即失败），再真正关闭浏览器。
   * 放在这里而不是 UI 里，是为了 CLI / 测试 / 其它宿主都走同一条停止路径。
   */
  async stop(ownerKey, reason) {
    const owner = String(ownerKey || '').trim();
    if (!owner) throw fail('COMPUTER_OWNER_REQUIRED', '缺少会话 owner');
    const status = Access.stop(owner, reason || 'user stop');
    const closed = await Browser.closeAll(owner);
    return { status, closed };
  }

  status(ownerKey) {
    return { auth: Access.status(ownerKey), browsers: Browser.list(ownerKey), capabilities: this.capabilities() };
  }
}

module.exports = new ComputerProvider();
module.exports.ComputerProvider = ComputerProvider;
module.exports.sandboxBlockReason = sandboxBlockReason;
