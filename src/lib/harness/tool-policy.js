'use strict';
/**
 * 工具权限策略（P0-2，2026-11-21）
 *
 * 解决的问题：以前 `general.permission` 只在 auto-review 打开时被读一次，
 * “只读 / 工作区内修改 / 完全权限”对真正的工具执行没有影响。这里把权限变成
 * 每次工具调用前都必须过的确定性判定：
 *
 *   read-only        : 只允许 read/net/local；write/exec 一律拒
 *   workspace-write  : 区内 write 放行；exec 需用户确认；区外 write 拒
 *   full             : 区内/区外 write 与 exec 都放行（用户显式选择）
 *   ask              : 所有 write/exec 都先问（老 “工作区内修改=ask” 语义）
 *
 * 预设再收一层：minimal 只保留读文件、终端、技能索引，不暴露 Figma/网页/写文件。
 * 这样模型拿到的工具表本身就被裁剪，而不是“先给它看再拒绝”。
 */

const path = require('node:path');

const READ_RISKS = new Set(['read', 'net', 'local']);

const MINIMAL_ALLOW = new Set([
  'fs_list', 'fs_read', 'shell_exec', 'skill_list', 'skill_read',
  'workspace_info', 'todo_write', 'ask_user_question',
]);

// 计划模式的唯一例外：允许维护计划/待办与提问，其它 write/exec 一律拦。
// 不能只靠 prompt——模型完全可能直接调用 fs_write。
const PLAN_ALLOW = new Set(['todo_write', 'ask_user_question']);

function inside(root, target) {
  if (!root || !target) return false;
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

function resolveArgPath(workspace, p) {
  if (!workspace || !workspace.path) return '';
  const s = String(p == null ? '' : p).trim();
  if (!s) return '';
  return path.isAbsolute(s) ? path.resolve(s) : path.resolve(workspace.path, s);
}

function normalizePermission(p, fallback) {
  const vals = ['read-only', 'workspace-write', 'full', 'ask'];
  return vals.includes(p) ? p : (vals.includes(fallback) ? fallback : 'workspace-write');
}

/** 当前这一轮的“有效权限”= 会话权限 ∩ 工作区模式 ∩ 预设。 */
function effective(ctx) {
  const c = ctx || {};
  const session = normalizePermission(c.permission, 'workspace-write');
  const wsMode = String((c.workspace && c.workspace.mode) || 'ask');
  if (session === 'read-only' || wsMode === 'read-only') return 'read-only';
  if (session === 'full') return 'full';
  if (session === 'ask') return 'ask';
  return 'workspace-write';
}

function presetAllows(preset, name) {
  if (preset !== 'minimal') return true;
  return MINIMAL_ALLOW.has(name);
}

/**
 * 判定一个工具调用。
 * @returns {{decision:'allow'|'deny'|'ask', code:string, reason:string, effective:string}}
 */
function decide(spec, args, ctx) {
  const c = ctx || {};
  const name = String((spec && spec.name) || (c && c.name) || '');
  const risk = String((spec && spec.risk) || c.risk || 'write');
  const mode = effective(c);
  const ws = c.workspace || {};
  const deny = (code, reason) => ({ decision: 'deny', code, reason, effective: mode });
  const ask = (code, reason) => ({ decision: 'ask', code, reason, effective: mode });
  const allow = (reason) => ({ decision: 'allow', code: 'ALLOW', reason: reason || '策略允许', effective: mode });

  if (!spec) return deny('UNKNOWN_TOOL', '未知工具：' + name);
  if (!presetAllows(c.preset || 'standard', name)) {
    return deny('PRESET_TOOL_DENIED', '当前预设「' + (c.preset || 'standard') + '」不开放工具 ' + name);
  }
  if (c.planMode && !READ_RISKS.has(risk) && !PLAN_ALLOW.has(name)) {
    return deny('PLAN_MODE_READONLY', '计划模式只允许规划/提问；' + name + ' 有副作用，未执行');
  }
  if (c.webEnabled === false && risk === 'net') {
    return deny('WEB_DISABLED', '网页搜索/获取在设置中被关闭');
  }
  if (mode === 'read-only' && !READ_RISKS.has(risk)) {
    return deny('PERMISSION_READ_ONLY', '当前权限为只读，禁止 ' + name);
  }
  if (risk === 'local' || risk === 'read') {
    if (spec.scope === 'workspace' && !ws.path) return deny('NO_WORKSPACE', '没有活动工作区，不能读工作区文件');
    return allow();
  }
  if (risk === 'net') return allow();

  if (risk === 'write') {
    if (mode === 'ask') return ask('APPROVAL_REQUIRED', name + ' 需要用户确认后写入');
    if (mode === 'full') return allow('完全权限');
    if (mode === 'workspace-write') {
      // 画布写不落文件系统，不受工作区路径约束；只有 fs_write 需要查边界。
      if (name !== 'fs_write') return allow();
      const abs = resolveArgPath(ws, args && args.path);
      if (!abs) return deny('PATH_REQUIRED', 'fs_write 缺少 path');
      if (!inside(ws.path, abs)) {
        return deny('WORKSPACE_BOUNDARY', '只能写工作区内路径；目标在工作区外：' + (args && args.path));
      }
      return allow('工作区内写入');
    }
  }

  if (risk === 'exec') {
    if (mode === 'ask') return ask('APPROVAL_REQUIRED', '执行命令需要用户确认');
    if (mode === 'full') return allow('完全权限');
    if (mode === 'workspace-write') return ask('APPROVAL_REQUIRED', '执行命令需要用户确认（工作区内修改）');
  }
  return deny('PERMISSION_DENIED', '权限策略拒绝 ' + name + '（risk=' + risk + ' mode=' + mode + '）');
}

function visible(spec, ctx) {
  const c = ctx || {};
  const name = String((spec && spec.name) || '');
  if (!spec) return false;
  if (!presetAllows(c.preset || 'standard', name)) return false;
  if (c.planMode && !READ_RISKS.has(spec.risk) && !PLAN_ALLOW.has(name)) return false;
  if (c.webEnabled === false && spec.risk === 'net') return false;
  const mode = effective(c);
  if (mode === 'read-only' && !READ_RISKS.has(spec.risk)) return false;
  return true;
}

/**
 * 交互矩阵（D2-12）
 *
 * 把"权限 + 风险 → 要不要问用户"写成一张表，而不是散在 UI/renderer/审批通道里
 * 各判一次。四档权限 × 四类风险 = 16 格，全部显式：
 *   deny  直接拒（连问都不问）
 *   never 不问，直接做
 *   ask   必须问
 *   allow 权限足够，直接做
 * `workspace-write` 的 write 允许、exec 需要问，是当前产品语义：
 * 改工作区文件是用户明确选的模式；跑任意命令影响面更大。
 */
const INTERACTION_MATRIX = {
  'read-only': { read: 'never', net: 'never', local: 'never', write: 'deny', exec: 'deny' },
  'workspace-write': { read: 'never', net: 'never', local: 'never', write: 'allow', exec: 'ask' },
  ask: { read: 'never', net: 'never', local: 'never', write: 'ask', exec: 'ask' },
  full: { read: 'never', net: 'never', local: 'never', write: 'allow', exec: 'allow' },
};

function interactionFor(spec, ctx) {
  const c = ctx || {};
  const risk = String((spec && spec.risk) || c.risk || 'write');
  const mode = effective(c);
  const row = INTERACTION_MATRIX[mode] || INTERACTION_MATRIX['workspace-write'];
  if (c.planMode && !READ_RISKS.has(risk) && !PLAN_ALLOW.has(String((spec && spec.name) || ''))) {
    return { decision: 'deny', code: 'PLAN_MODE_READONLY', effective: mode };
  }
  if (c.webEnabled === false && risk === 'net') return { decision: 'deny', code: 'WEB_DISABLED', effective: mode };
  return { decision: row[risk] || 'deny', code: 'INTERACTION', effective: mode };
}

module.exports = {
  normalizePermission, effective, decide, visible, interactionFor,
  presetAllows, inside, INTERACTION_MATRIX,
};
