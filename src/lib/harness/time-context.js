'use strict';
/**
 * 时间感知上下文（对标 DeepSeek Harness `context/time-context`）
 *
 * 问题：模型没有时钟。用户说"今天的行情"、"刚才那个错"、"明天九点提醒我"，
 * 模型只能瞎猜当前时间，也无法判断两次交互之间隔了多久（隔了 3 分钟和隔了 3 小时
 * 对"继续刚才那件事"的含义完全不同）。
 *
 * Harness 的做法：在**每个 step 的请求前**注入一条带来源标记的时间快照，
 * 内容包括「当前时间」+「距上一条模型可见消息的间隔」，并按 refreshIntervalMs
 * 节流（默认 10 分钟），避免每步都塞一条把上下文喂胖。
 *
 * 与 Harness 的差异（诚实声明）：
 *  · Harness 有时区协商（浏览器上报时区）与会话投影；Genie 用进程本地时区 + 内存状态，
 *    不做跨设备时区协商——桌面端单机场景无此需求；
 *  · 注入点：Harness 用 agent/pre-step 事件；Genie 在 agent loop 每步构造消息时追加。
 */

/** 默认节流间隔：10 分钟内不重复注入。 */
const DEFAULT_INTERVAL_MS = 600000;

/** 把毫秒差渲染成紧凑的整单位文本（与 Harness formatDuration 同构）。 */
function formatDuration(elapsedMs) {
  const ms = Math.max(0, Number(elapsedMs) || 0);
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const parts = [];
  if (days > 0) parts.push(days + '天');
  if (hours > 0) parts.push(hours + '小时');
  if (minutes > 0) parts.push(minutes + '分');
  parts.push(seconds + '秒');
  return parts.join('');
}

/** 按指定时区格式化时间戳（YYYY-MM-DD HH:mm:ss 周X）。 */
function formatTimestamp(now, timeZone) {
  const d = new Date(now);
  const tz = timeZone || undefined;
  const pad = (n) => String(n).padStart(2, '0');
  let datePart;
  let timePart;
  let weekday;
  try {
    const fmt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short', hour12: false,
    });
    const p = {};
    for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
    datePart = p.year + '-' + p.month + '-' + p.day;
    timePart = pad(p.hour) + ':' + pad(p.minute) + ':' + pad(p.second);
    weekday = p.weekday || '';
  } catch {
    datePart = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    timePart = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    weekday = '';
  }
  return datePart + ' ' + timePart + (weekday ? ' ' + weekday : '');
}

/**
 * 渲染一条时间快照文本。
 * @param {object} p {now, turn, step, previous, timeZone}
 */
function render(p) {
  const o = p || {};
  const now = Number(o.now) || Date.now();
  const turn = o.turn == null ? 1 : o.turn;
  const step = o.step == null ? 1 : o.step;
  const prev = o.previous;
  const elapsed = prev == null ? '不可用（本回合首条消息）' : formatDuration(now - prev);
  const baseline = step <= 1 ? '上一条用户/助手消息' : '上一次时间快照';
  return '当前时间（准备第 ' + turn + ' 回合第 ' + step + ' 步时采样）：' + formatTimestamp(now, o.timeZone) + '\n'
    + '距' + baseline + '已过 ' + elapsed + '。';
}

/**
 * 节流判断。
 * @returns {boolean} 是否应该注入
 */
function shouldInject(p) {
  const o = p || {};
  const interval = Number.isInteger(o.intervalMs) ? o.intervalMs : DEFAULT_INTERVAL_MS;
  if (interval <= 0) return true; // 0 = 每步都注入
  const last = o.lastInjection;
  const now = Number(o.now) || Date.now();
  if (last == null) return true;
  if (now < last) return true; // 时钟回拨：按需注入
  return now - last >= interval;
}

/** 带状态的注入器（一次 agent loop 一个实例）。 */
class TimeContext {
  constructor(opts) {
    const o = opts || {};
    this.intervalMs = o.intervalMs == null ? DEFAULT_INTERVAL_MS : Number(o.intervalMs);
    this.timeZone = o.timeZone;
    this.enabled = o.enabled !== false;
    this.lastInjection = null;
    this.lastMessageTime = null;
    this.lastTurnInjection = null;
    this.turn = 1;
  }

  /** 记录一条模型可见消息的时间（用户/助手/工具结果）。 */
  noteMessage(now) { this.lastMessageTime = Number(now) || Date.now(); }

  /** 进入新回合。 */
  startTurn(turn) {
    this.turn = turn == null ? this.turn + 1 : turn;
    this.lastTurnInjection = null;
  }

  /**
   * 本步是否需要注入；需要则返回文本，否则 null。
   * 返回值同时更新内部状态（注入即记账）。
   */
  tick(step, now) {
    if (!this.enabled) return null;
    const t = Number(now) || Date.now();
    if (!shouldInject({ lastInjection: this.lastInjection || this.lastTurnInjection, now: t, intervalMs: this.intervalMs })) {
      return null;
    }
    const previous = step <= 1 ? (this.lastMessageTime == null ? undefined : this.lastMessageTime) : this.lastTurnInjection;
    const text = render({ now: t, turn: this.turn, step: step, previous: previous, timeZone: this.timeZone });
    this.lastInjection = t;
    this.lastTurnInjection = t;
    return text;
  }

  state() {
    return {
      enabled: this.enabled, intervalMs: this.intervalMs,
      lastInjection: this.lastInjection, lastMessageTime: this.lastMessageTime, turn: this.turn,
    };
  }
}

module.exports = {
  DEFAULT_INTERVAL_MS, TimeContext,
  formatDuration, formatTimestamp, render, shouldInject,
};
