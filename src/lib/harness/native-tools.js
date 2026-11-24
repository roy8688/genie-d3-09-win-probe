'use strict';
/**
 * 原生工具集（P0-2，2026-11-21）
 *
 * 官方 Harness 的 Agent 之所以能“做事”，不是因为模型会写业务分支，而是因为
 * 有一组稳定的 fs / shell / web / skill 工具，且每次调用都经过统一注册表与权限层。
 * 这里补的是最小可用的通用工具；Figma 的 11 个设计工具仍在 agent-tools 里，由注册表合并。
 *
 * 安全边界：
 *  · 所有路径先 resolve，再由 policy 判断是否在工作区内；
 *  · 本模块**再校验一次**（纵深防御），不依赖上层只做一次判断；
 *  · shell 只给 sanitized env（不继承 API Key），cwd 固定工作区；
 *  · web 只允许 http(s)，拒绝 localhost / 169.254 / 私有网段（防 SSRF）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const MAX_OUT = 64 * 1024;
const Sandbox = require('./sandbox');
const Fs = require('./fs');
const ProcessTree = require('./process-tree');
const TimeoutPolicy = require('./timeout-policy');
const Pwsh = require('./pwsh');
const Platform = require('../platform');

function fsOf(ctx) { return (ctx && ctx.fs) || Fs.forContext(ctx); }

const specs = {
  fs_list: {
    description: '列出工作区目录。用于确认文件结构；只读。',
    parameters: {
      type: 'object', properties: {
        path: { type: 'string', description: '相对工作区的目录，默认 .' },
        limit: { type: 'number', description: '最多返回多少项，默认 80，最大 200' },
      }, required: [],
    },
    risk: 'read', scope: 'workspace',
  },
  fs_read: {
    description: '读取工作区内文本文件。返回带行号内容与文件版本；只读，单文件上限 240KB。修改前先读，写回时把 version 作为 expectedVersion 传入。',
    parameters: {
      type: 'object', properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        startLine: { type: 'number', description: '起始行，1 起' },
        endLine: { type: 'number', description: '结束行，含' },
      }, required: ['path'],
    },
    risk: 'read', scope: 'workspace',
  },
  read_image: {
    // 官方 parameter 是 file_path（packages/fs/tool-fs/src/read-image.ts），不是 path。
    description: '读取工作区内的图片，并把真实图片内容块（PNG/JPEG/WEBP/GIF，单图上限 8MB）交给模型；只读。当前模型不支持图片输入时会明确失败，而不是把路径当文本。',
    parameters: {
      type: 'object', properties: {
        file_path: { type: 'string', description: '相对工作区的图片路径' },
      }, required: ['file_path'],
    },
    risk: 'read', scope: 'workspace',
  },
  grep: {
    description: '按正则搜索工作区文件内容。返回按文件分组的行号与匹配行；只读。',
    parameters: {
      type: 'object', properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '相对工作区的目录，默认 .' },
        include: { type: 'string', description: '只搜匹配的文件名，如 *.js' },
      }, required: ['pattern'],
    },
    risk: 'read', scope: 'workspace',
  },
  glob: {
    description: '按 glob 模式列出工作区文件路径；只读。',
    parameters: {
      type: 'object', properties: {
        pattern: { type: 'string', description: 'glob 模式，如 **/*.js' },
        path: { type: 'string', description: '相对工作区的目录，默认 .' },
      }, required: ['pattern'],
    },
    risk: 'read', scope: 'workspace',
  },
  fs_write: {
    description: '写入工作区内文件（整文件覆盖）。覆盖已有文件前必须先 fs_read；打补丁/替换优先用 apply_patch 或 str_replace_editor。会自动创建父目录。读取后文件被改过会返回 STALE_FILE。',
    parameters: {
      type: 'object', properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        content: { type: 'string', description: '完整文件内容' },
        expectedVersion: {
          type: ['string', 'object'],
          description: 'fs_read 返回的 version；覆盖已有文件时必填，新建文件可省略',
        },
      }, required: ['path', 'content'],
    },
    risk: 'write', scope: 'workspace',
  },
  apply_patch: {
    description: '按 Codex 风格补丁修改文件：*** Begin Patch / Add File / Delete File / Update File / @@ hunk / *** End Patch。修改已有文件前必须先 fs_read；补丁不匹配返回 FS_PATCH_MISMATCH，文件被改过返回 STALE_FILE。',
    parameters: {
      type: 'object', properties: {
        patch: { type: 'string', description: '完整补丁文本，含 *** Begin Patch 与 *** End Patch' },
        expectedVersions: {
          type: 'object',
          description: '可选：{ "path": 版本 }（来自 fs_read），用于多文件显式 CAS；未提供的文件按本会话 observation 校验',
        },
      }, required: ['patch'],
    },
    risk: 'write', scope: 'workspace',
  },
  str_replace_editor: {
    description: '查看/创建/编辑文件。command=view 查看（目录最多两层），create 新建，str_replace 替换唯一文本，insert 在指定行后插入。编辑已有文件前必须先 view；old_str 不唯一会拒绝。',
    parameters: {
      type: 'object', properties: {
        command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert'], description: '操作命令' },
        path: { type: 'string', description: '相对工作区或绝对路径（必须落在当前权限允许范围）' },
        view_range: {
          type: 'array', items: { type: 'number' },
          description: 'view 时的行范围 [start, end]；end=-1 表示到文件尾',
        },
        file_text: { type: 'string', description: 'create 时的完整内容' },
        old_str: { type: 'string', description: 'str_replace 时要替换的文本，必须唯一' },
        new_str: { type: 'string', description: 'str_replace 的替换文本，留空即删除' },
        replace_all: { type: 'boolean', description: 'str_replace 是否替换全部匹配，默认 false' },
        insert_line: { type: 'number', description: 'insert 在第几行之后插入；0 表示文件开头' },
        insert_text: { type: 'string', description: 'insert 插入的文本' },
      }, required: ['command', 'path'],
    },
    risk: 'write', scope: 'workspace',
  },
  shell_exec: {
    description: '在工作区执行一条命令（POSIX 走 bash -lc；Windows 走 pwsh -EncodedCommand）。返回退出码、stdout、stderr；默认 120 秒超时、64KB 输出上限。'
      + 'PowerShell 命令中的引号、$、反引号、换行与中文按原样执行，不需要再套一层转义。',
    parameters: {
      type: 'object', properties: {
        command: { type: 'string', description: '要执行的命令' },
        timeoutMs: { type: 'number', description: '超时毫秒，最大 600000' },
      }, required: ['command'],
    },
    risk: 'exec', scope: 'workspace',
  },
  web_search: {
    // 官方是 queries: string[]（1–4 个查询合并），不是单个 query。
    description: '联网搜索。返回标题、链接、摘要与正文证据；用于需要最新事实的问题。',
    parameters: {
      type: 'object', properties: {
        queries: { type: 'array', items: { type: 'string' }, description: '1–4 个搜索词，结果合并去重' },
        limit: { type: 'number', description: '最多返回多少条，默认 6' },
      }, required: ['queries'],
    },
    risk: 'net', scope: 'network',
  },
  web_fetch: {
    description: '抓取一个公网 http(s) 网页并转成纯文本。拒绝 localhost 与私有网段。',
    parameters: {
      type: 'object', properties: {
        url: { type: 'string', description: '完整 http(s) URL' },
        maxChars: { type: 'number', description: '最多返回多少字，默认 12000' },
      }, required: ['url'],
    },
    risk: 'net', scope: 'network',
  },
  skill_list: {
    description: '列出本机技能索引（只返回名称与一句话描述）。',
    parameters: { type: 'object', properties: {}, required: [] },
    risk: 'read', scope: 'local',
  },
  skill_read: {
    description: '读取一个技能的 SKILL.md 正文。先用 skill_list 拿到名称。',
    parameters: {
      type: 'object', properties: {
        name: { type: 'string', description: '技能名称' },
      }, required: ['name'],
    },
    risk: 'read', scope: 'local',
  },
  workspace_info: {
    description: '返回当前工作区名称、路径、权限模式与顶层文件列表。',
    parameters: { type: 'object', properties: {}, required: [] },
    risk: 'read', scope: 'workspace',
  },

  /* ---- D3-08：浏览器 / 电脑操作。都必须先由用户在运行面板显式授权。 ---- */
  browser_open: {
    description: '在会话级浏览器里打开 http(s) 页面（真实 Chrome）。返回标题、地址与 provider 名；'
      + '沿用同一 provider 时会重新导航。未授权时直接拒绝，不会启动 Chrome。',
    parameters: {
      type: 'object', properties: {
        url: { type: 'string', description: 'http/https URL' },
        name: { type: 'string', description: '可选 provider 后缀，同一会话开第二个浏览器时用' },
        headless: { type: 'boolean', description: '默认 true；false 会显示 Chrome 窗口' },
        width: { type: 'number', description: '视口宽度，默认 1280' },
        height: { type: 'number', description: '视口高度，默认 800' },
      }, required: ['url'],
    },
    risk: 'write', scope: 'global',
  },
  browser_read: {
    description: '读取当前浏览器页面的可见文本、表单字段值与链接；可传 selector 只看某个节点。',
    parameters: {
      type: 'object', properties: {
        provider: { type: 'string', description: 'browser_open 返回的 provider；不填用默认' },
        selector: { type: 'string', description: 'CSS selector；不填读整页' },
        maxChars: { type: 'number', description: '文本上限，默认 12000，最大 30000' },
      }, required: [],
    },
    risk: 'read', scope: 'global',
  },
  browser_click: {
    description: '点击页面元素（CSS selector）或坐标。点击后会等网络短暂静默，再返回标题/地址。',
    parameters: {
      type: 'object', properties: {
        provider: { type: 'string' },
        selector: { type: 'string', description: 'CSS selector；与 x/y 二选一' },
        x: { type: 'number', description: '页面坐标 x；无 selector 时必填' },
        y: { type: 'number', description: '页面坐标 y；无 selector 时必填' },
      }, required: [],
    },
    risk: 'write', scope: 'global',
  },
  browser_type: {
    description: '向输入框输入文本（会先全选清空）。submit=true 时输入后按回车。',
    parameters: {
      type: 'object', properties: {
        provider: { type: 'string' },
        selector: { type: 'string', description: '目标输入框 CSS selector' },
        text: { type: 'string', description: '要输入的文本' },
        submit: { type: 'boolean', description: '输入后按回车，默认 false' },
      }, required: ['selector', 'text'],
    },
    risk: 'write', scope: 'global',
  },
  browser_screenshot: {
    description: '截取当前浏览器页面为 PNG，返回真实文件路径与字节数；不是把 HTML 当截图。',
    parameters: {
      type: 'object', properties: {
        provider: { type: 'string' },
        name: { type: 'string', description: '文件名前缀' },
        fullPage: { type: 'boolean', description: '是否整页，默认 false' },
      }, required: [],
    },
    risk: 'read', scope: 'global',
  },
  browser_close: {
    description: '关闭指定/默认浏览器 provider，真正结束 Chrome 进程。',
    parameters: {
      type: 'object', properties: { provider: { type: 'string' } }, required: [],
    },
    risk: 'write', scope: 'global',
  },
  computer_screenshot: {
    description: '截取本机屏幕为 PNG（macOS screencapture），返回真实路径与字节数。需要电脑操作授权。',
    parameters: {
      type: 'object', properties: { name: { type: 'string', description: '文件名前缀' } }, required: [],
    },
    risk: 'read', scope: 'global',
  },
  computer_click: {
    description: '在本机屏幕坐标点击。需要电脑操作授权；未安装 cliclick 时明确失败，不会假装点过。',
    parameters: {
      type: 'object', properties: {
        x: { type: 'number', description: '屏幕坐标 x' },
        y: { type: 'number', description: '屏幕坐标 y' },
      }, required: ['x', 'y'],
    },
    risk: 'write', scope: 'global',
  },
  computer_type: {
    description: '向当前焦点输入文本（AppleScript System Events）。需要电脑操作授权与辅助功能权限。',
    parameters: {
      type: 'object', properties: { text: { type: 'string', description: '要输入的文本' } }, required: ['text'],
    },
    risk: 'write', scope: 'global',
  },
  computer_key: {
    description: '按快捷键，例如 cmd+v。需要电脑操作授权；未安装 cliclick 时明确失败。',
    parameters: {
      type: 'object', properties: { keys: { type: 'string', description: 'cliclick 键名，如 cmd+v' } }, required: ['keys'],
    },
    risk: 'write', scope: 'global',
  },
  computer_open_app: {
    description: '按应用名打开本机应用，例如 Figma。需要电脑操作授权。',
    parameters: {
      type: 'object', properties: { app: { type: 'string', description: '应用名' } }, required: ['app'],
    },
    risk: 'write', scope: 'global',
  },
};

function specList() {
  return Object.entries(specs).map(([name, s]) => Object.assign({ name, local: false, native: true }, s));
}

function inside(root, target) {
  if (!root) return false;
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

function resolveInWorkspace(ctx, relPath, opts) {
  const root = ctx && ctx.workspace && ctx.workspace.path;
  if (!root) throw new Error('没有活动工作区');
  const p = String(relPath == null ? '' : relPath).trim();
  if (!p) throw new Error('缺少路径');
  if (p.includes('\u0000')) throw new Error('路径非法');
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
  const allowOutside = !!(opts && opts.allowOutside);
  if (!allowOutside && !inside(root, abs)) throw new Error('路径越过工作区边界：' + p);
  return abs;
}

function trimOut(s, max) {
  const text = String(s || '');
  const cap = max || MAX_OUT;
  return text.length <= cap ? text : text.slice(0, cap) + '\n…（输出已截断，共 ' + text.length + ' 字符）';
}

function ok(content, raw) {
  return { ok: true, content: String(content || ''), raw: raw || null };
}
function fail(content, code, raw) {
  const r = { ok: false, content: String(content || '工具执行失败'), code: code || 'TOOL_FAILED' };
  if (raw && typeof raw === 'object') r.raw = raw;
  return r;
}

/** 审计结果只留可复核的元数据；页面字段值、输入正文一律不进日志。 */
function interactionAuditSummary(raw) {
  const r = raw || {};
  const out = {};
  for (const k of ['provider', 'id', 'path', 'bytes', 'title', 'url', 'chars', 'typedChars',
    'submitted', 'clicked', 'opened', 'reused', 'closed', 'width', 'height', 'fullPage']) {
    if (r[k] !== undefined && r[k] !== null && typeof r[k] !== 'object') out[k] = r[k];
  }
  if (Array.isArray(r.fields)) out.fieldCount = r.fields.length;
  if (Array.isArray(r.links)) out.linkCount = r.links.length;
  return out;
}

/** D3-08：browser_* / computer_* 的唯一执行入口（授权、审计、失败结构化都在这里）。 */
async function runInteraction(name, args, ctx) {
  const a = args || {};
  const c = ctx || {};
  const owner = String(c.sessionId || 'agent');
  const kind = name.startsWith('browser_') ? 'browser' : 'computer';
  const startedAt = Date.now();
  let raw = null;
  try {
    const Computer = require('./computer-provider');
    const blocked = Computer.sandboxBlockReason(c);
    if (blocked) {
      throw Object.assign(new Error('当前沙箱模式为 ' + blocked + '；交互工具不进沙箱'), { code: 'GUI_SANDBOX_DENIED' });
    }
    let r;
    if (name === 'browser_open') {
      const Browser = require('./browser-provider');
      r = await Browser.open(owner, a);
    } else if (name === 'browser_read') {
      const Browser = require('./browser-provider');
      r = await Browser.read(owner, a);
    } else if (name === 'browser_click') {
      const Browser = require('./browser-provider');
      r = await Browser.click(owner, a);
    } else if (name === 'browser_type') {
      const Browser = require('./browser-provider');
      r = await Browser.type(owner, a);
    } else if (name === 'browser_screenshot') {
      const Browser = require('./browser-provider');
      r = await Browser.screenshot(owner, a);
    } else if (name === 'browser_close') {
      const Browser = require('./browser-provider');
      r = await Browser.close(owner, a);
      r = { content: (r.closed ? '已关闭浏览器：' : '浏览器未在运行：') + (r.provider || ''), raw: r };
    } else if (name === 'computer_screenshot') {
      r = Computer.screenshot(owner, a, c);
    } else if (name === 'computer_click') {
      r = Computer.click(owner, a, c);
    } else if (name === 'computer_type') {
      r = Computer.type(owner, a, c);
    } else if (name === 'computer_key') {
      r = Computer.key(owner, a, c);
    } else if (name === 'computer_open_app') {
      r = Computer.openApp(owner, a, c);
    } else {
      throw Object.assign(new Error('未知交互工具：' + name), { code: 'UNKNOWN_TOOL' });
    }
    raw = r.raw || null;
    require('./interaction-access').audit({
      kind, action: name, owner, ok: true, code: null,
      args: require('./interaction-access').summarize(a),
      result: interactionAuditSummary(raw),
      durationMs: Date.now() - startedAt,
    });
    return ok(r.content, raw);
  } catch (e) {
    const code = (e && e.code) || 'TOOL_FAILED';
    try {
      require('./interaction-access').audit({
        kind, action: name, owner, ok: false, code,
        error: String((e && e.message) || e).slice(0, 240),
        args: require('./interaction-access').summarize(a),
        durationMs: Date.now() - startedAt,
      });
    } catch (_) { /* 审计旁路 */ }
    return fail((e && e.message) || String(e), code, { code });
  }
}

async function runShell(ctx, args) {
  const command = String(args && args.command || '').trim();
  if (!command) throw new Error('缺少 command');
  if (command.length > 20000) throw new Error('命令过长');
  const cwd = ctx.workspace && ctx.workspace.path;
  if (!cwd || !fs.existsSync(cwd)) throw new Error('工作区不存在');
  const cfgTimeout = Number(ctx.terminal && ctx.terminal.timeoutMs);
  const requested = Number(args.timeoutMs || (Number.isFinite(cfgTimeout) ? cfgTimeout : 120000));
  const timeoutMs = TimeoutPolicy.budgetFor('shell_exec', { requested, minMs: 1000 });
  const maxBytes = Number((ctx.terminal && ctx.terminal.maxOutputBytes) || MAX_OUT);
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || cwd,
    LANG: process.env.LANG || 'zh_CN.UTF-8',
    TERM: 'dumb',
    PWD: cwd,
  };

  // D3-04：先解决沙箱前缀，再 spawn。沙箱不可用/配置非法时命令一条都不执行，
  // 而不是“先跑起来再补限制”——那正是逃逸窗口。
  let policy;
  let wrapped;
  try {
    policy = Sandbox.policyFor({
      permission: ctx.permission,
      workspaceRoot: cwd,
      config: ctx.sandbox,
    });
    const isWin = process.platform === 'win32';
    // D3-10：非 Windows 的 shell 由平台层选（$SHELL → /bin/zsh|bash|sh），不写死 /bin/bash。
    const shellSpec = isWin
      ? { command: Pwsh.resolvePwshPath({ configured: process.env.GENIE_PWSH_PATH }), args: Pwsh.argsFor(command) }
      : Platform.shell.shellSpec(command, { allowSubprocess: policy.allowSubprocess });
    const shellCommand = shellSpec.command;
    const shellArgs = shellSpec.args;
    wrapped = Sandbox.prepare({
      command: shellCommand,
      args: shellArgs,
      cwd,
      env,
      policy,
    });
  } catch (e) {
    return fail((e && e.message) || String(e), (e && e.code) || 'SANDBOX_ERROR');
  }

  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let done = false;
    let timer = null;
    let forceTimer = null;
    let hardTimer = null;
    let abortListener = null;

    const cleanupTimers = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (forceTimer) { clearTimeout(forceTimer); forceTimer = null; }
      if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
      if (abortListener && ctx.signal && typeof ctx.signal.removeEventListener === 'function') {
        try { ctx.signal.removeEventListener('abort', abortListener); } catch (_) {}
      }
      abortListener = null;
    };
    const finish = (result) => {
      if (done) return;
      done = true;
      cleanupTimers();
      try { wrapped.cleanup(); } catch (_) {}
      resolve(result);
    };
    const timeoutResult = () => fail(
      '命令超时（' + timeoutMs + 'ms，已终止进程组）\nstdout:\n' + trimOut(stdout) + '\nstderr:\n' + trimOut(stderr),
      TimeoutPolicy.TOOL_TIMEOUT,
      { toolName: 'shell_exec', timeoutMs, code: TimeoutPolicy.TOOL_TIMEOUT, killed: true }
    );

    let child;
    try {
      // POSIX 必须 detached：否则 kill(-pid) 没有进程组可杀，sleep/npm 子进程会留下。
      child = spawn(wrapped.command, wrapped.args, {
        cwd: wrapped.cwd,
        env: wrapped.env,
        detached: !ProcessTree.isWin(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish(fail('命令启动失败：' + e.message, 'SHELL_SPAWN_FAILED'));
      return;
    }

    const requestStop = (why) => {
      if (done) return;
      if (why === 'timeout') timedOut = true; else aborted = true;
      // 先 TERM 整组，1s 后 KILL；硬兜底 3s，避免 close 永远不来把 turn 挂死。
      forceTimer = ProcessTree.terminateTree(child, 1000);
      if (!hardTimer) {
        hardTimer = setTimeout(() => {
          if (done) return;
          finish(why === 'timeout' ? timeoutResult() : fail(
            '工具调用已取消（进程组已终止）', TimeoutPolicy.TOOL_ABORTED,
            { toolName: 'shell_exec', code: TimeoutPolicy.TOOL_ABORTED }
          ));
        }, 3000);
      }
    };

    timer = setTimeout(() => requestStop('timeout'), timeoutMs);
    if (ctx.signal && typeof ctx.signal.addEventListener === 'function') {
      abortListener = () => {
        const reason = ctx.signal.reason || {};
        requestStop(reason.code === TimeoutPolicy.TOOL_TIMEOUT ? 'timeout' : 'abort');
      };
      if (ctx.signal.aborted) abortListener();
      else ctx.signal.addEventListener('abort', abortListener, { once: true });
    }

    child.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > maxBytes) stdout = stdout.slice(0, maxBytes); });
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > maxBytes) stderr = stderr.slice(0, maxBytes); });
    child.on('error', (e) => {
      finish(fail('命令启动失败：' + e.message, 'SHELL_SPAWN_FAILED'));
    });
    child.on('close', (code, signal) => {
      if (done) return;
      if (timedOut) { finish(timeoutResult()); return; }
      if (aborted) {
        finish(fail('工具调用已取消（进程组已终止）\nstdout:\n' + trimOut(stdout) + '\nstderr:\n' + trimOut(stderr),
          TimeoutPolicy.TOOL_ABORTED,
          { toolName: 'shell_exec', code: TimeoutPolicy.TOOL_ABORTED, signal: signal || null }));
        return;
      }
      const denied = wrapped.enforced && code !== 0 && Sandbox.denialOf(stderr, wrapped.backend);
      if (denied) {
        finish(fail('沙箱拒绝执行（' + wrapped.backend + ' / ' + wrapped.mode + '）：\n'
          + (stdout ? 'stdout:\n' + trimOut(stdout) + '\n' : '')
          + (stderr ? 'stderr:\n' + trimOut(stderr) : ''), 'SANDBOX_DENIED'));
        return;
      }
      const content = 'exit=' + (code == null ? '-' : code) + (signal ? ' signal=' + signal : '') + '\n'
        + (stdout ? 'stdout:\n' + trimOut(stdout) + '\n' : '')
        + (stderr ? 'stderr:\n' + trimOut(stderr) : '');
      finish(ok(content.trim(), {
        code, signal, stdout: trimOut(stdout), stderr: trimOut(stderr), timedOut: false,
        sandbox: { backend: wrapped.backend, mode: wrapped.mode, enforced: wrapped.enforced },
      }));
    });
  });
}

function safePublicUrl(url) {
  let u;
  try { u = new URL(String(url || '')); } catch (_) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h.endsWith('.local')) return null;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return null;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return null;
  return u.toString();
}

// ── grep/glob（2026-11-23）────────────────────────────────────────────
// 官方 ui-tool 的 search variant 是 grep/glob 的**结构化结果**，不是 fs_list 的
// 目录清单。这里补上真实后端，让前端 SearchBlock 有东西可渲染；不引入 ripgrep
// 依赖，避免“本机没装 rg”成为功能入口的直接死因。

function doGrep(a, c) {
  const svc = fsOf(c);
  const pattern = String(a.pattern == null ? '' : a.pattern);
  if (!pattern) throw new Error('缺少 pattern');
  const r = svc.search(a.path || '.', pattern, a.include);
  const summary = r.files.length
    ? r.files.map((f) => f.path + '\n' + f.matches.map((m) => '  ' + m.lineNumber + ': ' + m.line).join('\n')).join('\n')
    : '没有匹配。';
  return ok(summary, {
    shape: 'matches', files: r.files, total: r.total, truncated: r.truncated, path: r.base, pattern,
  });
}

function doGlob(a, c) {
  const svc = fsOf(c);
  const pattern = String(a.pattern == null ? '' : a.pattern).trim();
  if (!pattern) throw new Error('缺少 pattern');
  const r = svc.glob(a.path || '.', pattern);
  return ok(r.paths.length ? r.paths.join('\n') : '没有匹配。', {
    shape: 'paths', paths: r.paths, total: r.paths.length, truncated: r.truncated, path: r.base, pattern,
  });
}

// ── read_image ─────────────────────────────────────────────────────────
const IMAGE_MAX = 8 * 1024 * 1024;
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function imageSize(buf, ext) {
  try {
    if (ext === '.png' && buf.length >= 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (ext === '.gif' && buf.length >= 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if ((ext === '.jpg' || ext === '.jpeg') && buf.length > 4) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xc3) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
    }
  } catch (_) {}
  return null;
}

function doReadImage(a, c) {
  // 官方 read_image 的 route gate：模型路由没有显式声明 image 输入时直接拒绝。
  // 不能把路径当文本回给模型——模型读不到磁盘，只会把路径念给用户。
  if (c.native && c.native.supportsImages === false) {
    const e = new Error('当前模型没有声明图片输入能力（MODEL_DOES_NOT_SUPPORT_IMAGES）；请切换视觉模型后重试 read_image');
    e.code = 'MODEL_DOES_NOT_SUPPORT_IMAGES';
    throw e;
  }
  // 官方 schema 是 file_path；老会话/测试里的 path 仍兼容，避免历史调用变死链。
  const given = String(a.file_path || a.path || '').trim();
  if (!given) throw new Error('缺少 file_path');
  const abs = resolveInWorkspace(c, given);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error('不是文件：' + given);
  if (st.size > IMAGE_MAX) throw new Error('图片过大（' + st.size + 'B，上限 ' + IMAGE_MAX + 'B）');
  const ext = path.extname(abs).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) throw new Error('不是支持的图片格式：' + (ext || '无扩展名'));
  const buf = fs.readFileSync(abs);
  const size = imageSize(buf, ext) || {};
  // 官方 AttachmentStore：magic-byte 校验、必要时降采样，并给出 attachmentId。
  // Genie 不走持久附件库，但模型侧仍然必须拿到真实像素；这里生成内容寻址的
  // attachmentId（同一份**实际交付字节**同 id），再由下方 720px JPEG 预览承载。
  const sniffed = sniffImageType(buf);
  if (!sniffed) throw new Error('文件签名不是受支持的图片（PNG/JPEG/WEBP/GIF）');
  const visual = buildVisionPayload(abs, buf, st.size, mime, size);
  // 官方 ref 描述的是「持久化归一化后的图片」，不是源文件：
  // 能原样交付时 mediaType/bytes 用源文件；重编码后必须改成实际交付的 JPEG 字节，
  // 否则 envelope 会写 image/png 120907B 而模型收到的是 46KB image/jpeg（两份事实打架）。
  const deliveredMime = visual.mime;
  const deliveredBytes = visual.bytes;
  const attachmentId = 'sha256:' + crypto.createHash('sha256').update(Buffer.from(visual.data, 'base64')).digest('hex');
  const displayW = visual.width || size.width || 0;
  const displayH = visual.height || size.height || 0;
  const image = {
    attachmentId,
    mediaType: deliveredMime,
    bytes: deliveredBytes,
    name: path.basename(abs),
    width: displayW || size.width || 0,
    height: displayH || size.height || 0,
  };
  if (size.width && size.height && displayW && displayH && (size.width !== displayW || size.height !== displayH)) {
    image.originalDimensions = { width: size.width, height: size.height };
  }
  // 官方 formatImageReadOutput：文本 envelope 只描述，真正给模型的是相邻 image block。
  let scaled = '';
  if (image.originalDimensions) {
    const x = (image.originalDimensions.width / image.width).toFixed(2);
    const y = (image.originalDimensions.height / image.height).toFixed(2);
    const advice = x === y
      ? 'multiply coordinates by ' + x
      : 'multiply x coordinates by ' + x + ' and y coordinates by ' + y;
    scaled = ' (downscaled from ' + image.originalDimensions.width + 'x' + image.originalDimensions.height
      + ' px; ' + advice + ' to locate features in the original file)';
  }
  const texture = image.mediaType + ' image, ' + image.width + 'x' + image.height + ' px, '
    + image.bytes + ' bytes' + scaled;
  const envelope = '<path>' + abs + '</path>\n<type>image</type>\n<content>\n' + texture + '\n</content>';
  const raw = {
    path: abs,
    mime,
    bytes: st.size,
    width: size.width || displayW || 0,
    height: size.height || displayH || 0,
    attachmentId,
    image,
    // 官方 imageReadContent(value) 的两个 ContentBlock；UI/轨迹用结构，
    // agent-loop 用 imageData 把像素真正送进模型请求。
    contentBlocks: [
      { type: 'text', text: envelope },
      { type: 'image', attachment: image },
    ],
    imageData: [{ mime: deliveredMime, data: visual.data, bytes: deliveredBytes, width: displayW, height: displayH }],
  };
  if (image.originalDimensions) raw.originalDimensions = image.originalDimensions;
  return ok(envelope, raw);
}

/** 按 magic bytes 识别图片类型；扩展名只用于挑选同样的四种官方类型。 */
function sniffImageType(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')) return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

/**
 * 生成模型用的真实图片字节。官方附件库会按部署上限降采样；Genie 用同一套
 * 720px / 70 质量策略，避免 8MB 原图直接吃满上下文（实测 1.1MB PNG 会 211 秒空答）。
 */
function buildVisionPayload(abs, buf, bytes, mime, size) {
  const w = Number(size && size.width || 0);
  const h = Number(size && size.height || 0);
  // 官方 canPassThroughNormalization：干净的单帧 8-bit sRGB 且尺寸/字节在限内时原样交付。
  // Genie 的模型侧上限是 720px（1.1MB PNG 直接喂会吃掉整个上下文），
  // 因此 <=720 的 PNG/JPEG/WEBP 不重编码——保留原 mediaType 与源字节，避免
  // envelope 写的格式/字节数和真正发给模型的图片对不上。GIF 先转静态 JPEG。
  if (mime !== 'image/gif' && w && h && Math.max(w, h) <= 720 && bytes <= 3 * 1024 * 1024) {
    return { mime, data: buf.toString('base64'), bytes, width: w, height: h };
  }
  const dst = path.join(os.tmpdir(), 'genie-read-image-' + process.pid + '-' + Date.now().toString(36) + '.jpg');
  try {
    execFileSync('/usr/bin/sips', ['-Z', '720', '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', abs, '--out', dst],
      { timeout: 15000, stdio: 'ignore' });
    if (fs.existsSync(dst)) {
      const out = fs.readFileSync(dst);
      const outSize = imageSize(out, '.jpg') || {};
      if (out.length && out.length <= 3 * 1024 * 1024) {
        return { mime: 'image/jpeg', data: out.toString('base64'), bytes: out.length, width: outSize.width, height: outSize.height };
      }
    }
  } catch (_) { /* sips 不可用/格式不支持 → 下面退回原图 */ }
  finally { try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch (_) {} }
  return { mime, data: buf.toString('base64'), bytes, width: w, height: h };
}


function fsErrorToTool(e) {
  if (!e || !e.code) throw e;
  if (e.code === 'FS_STALE_VERSION') {
    return fail(e.message + '。请重新 fs_read 后再写。', 'STALE_FILE');
  }
  if (e.code === 'FS_NOT_OBSERVED') {
    return fail(e.message + '。请先 fs_read/view，再写。', 'STALE_FILE');
  }
  return fail(e.message, e.code);
}

function editorTypeLabel(type) {
  return type === 'directory' ? 'd' : type === 'file' ? 'f' : '?';
}

function editorListTree(svc, path, depth, rows) {
  const entries = svc.list(path);
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === '__pycache__') continue;
    rows.push(editorTypeLabel(ent.type) + '\t' + ent.target.displayPath);
    if (ent.type === 'directory' && depth < 2) editorListTree(svc, ent.target.displayPath, depth + 1, rows);
  }
}

function doStrReplaceEditor(a, c) {
  const command = String(a.command || '').trim();
  const targetPath = String(a.path == null ? '' : a.path);
  if (!targetPath) throw new Error('缺少 path');
  const svc = fsOf(c);

  if (command === 'view') {
    const { target, info } = svc.stat(targetPath);
    if (!info) throw new Error('路径不存在：' + target.displayPath);
    if (info.type === 'directory') {
      if (a.view_range !== undefined) throw new Error('view_range 不能用于目录');
      const rows = [];
      editorListTree(svc, target.displayPath, 1, rows);
      rows.sort((x, y) => x.slice(x.indexOf('\t') + 1).localeCompare(y.slice(y.indexOf('\t') + 1)));
      return ok(trimOut(rows.join('\n') || '（空目录）', 16000), { path: target.abs, type: 'directory', count: rows.length });
    }
    if (info.type !== 'file') throw new Error('不是普通文件：' + target.displayPath);
    const r = svc.readText(targetPath);
    const all = r.content.split('\n');
    let start = 1;
    let end = all.length;
    if (a.view_range !== undefined) {
      if (!Array.isArray(a.view_range) || a.view_range.length !== 2 || !a.view_range.every(Number.isInteger)) {
        throw new Error('view_range 必须是两个整数');
      }
      start = a.view_range[0];
      end = a.view_range[1] === -1 ? all.length : a.view_range[1];
      if (start < 1 || start > all.length) throw new Error('view_range 起始行越界：' + start);
      if (end > all.length) throw new Error('view_range 结束行越界：' + end);
      if (end < start) throw new Error('view_range 结束行必须不小于起始行');
    }
    const lines = all.slice(start - 1, end);
    const numbered = lines.map((line, i) => String(start + i).padStart(6, ' ') + '  ' + line).join('\n');
    const head = '文件 ' + target.displayPath + ' 共 ' + all.length + ' 行'
      + (a.view_range === undefined ? '' : '（view_range=[' + start + ', ' + (a.view_range[1] === -1 ? -1 : end) + ']）');
    return ok(trimOut(head + '：\n' + numbered, 16000), {
      path: target.abs, lines: lines.length, totalLines: all.length, version: r.info.version,
    });
  }

  if (command === 'create') {
    if (a.file_text === undefined) throw new Error('create 需要 file_text');
    const w = svc.createText(targetPath, String(a.file_text));
    return ok('已创建 ' + w.target.displayPath + '（' + Buffer.byteLength(w.after) + 'B）', {
      path: w.target.abs, bytes: Buffer.byteLength(w.after), version: w.version,
    });
  }

  if (command === 'str_replace') {
    if (a.old_str === undefined || a.old_str === '') throw new Error('str_replace 需要非空 old_str');
    const e = svc.editText(targetPath, {
      oldString: String(a.old_str), newString: String(a.new_str == null ? '' : a.new_str), replaceAll: a.replace_all === true,
    });
    return ok('已替换 ' + e.target.displayPath + '（' + e.replacements + ' 处）', {
      path: e.target.abs, replacements: e.replacements, version: e.version,
    });
  }

  if (command === 'insert') {
    if (!Number.isInteger(a.insert_line) || a.insert_line < 0) throw new Error('insert_line 必须是非负整数');
    if (a.insert_text === undefined) throw new Error('insert 需要 insert_text');
    const r = svc.readText(targetPath);
    const lines = r.content.split('\n');
    const at = Math.min(a.insert_line, lines.length - (lines[lines.length - 1] === '' ? 1 : 0));
    const before = lines.slice(0, at);
    const afterLines = String(a.insert_text).replace(/\n$/, '').split('\n');
    const tail = lines.slice(at);
    const after = before.concat(afterLines, tail).join('\n');
    const w = svc.writeText(targetPath, after, { expectedVersion: r.info.version });
    return ok('已插入 ' + r.target.displayPath + '（第 ' + at + ' 行后，+' + afterLines.length + ' 行）', {
      path: r.target.abs, insertedLines: afterLines.length, version: w.version,
    });
  }

  throw new Error('未知 str_replace_editor command：' + command);
}

function doApplyPatch(a, c) {
  const patch = String(a.patch == null ? '' : a.patch);
  if (!patch.trim()) throw new Error('缺少 patch');
  const svc = fsOf(c);
  const expectedVersions = a.expectedVersions && typeof a.expectedVersions === 'object' ? a.expectedVersions : undefined;
  const r = svc.patchText(null, patch, { expectedVersions });
  const lines = r.operations.map((op) => {
    if (op.kind === 'add') return '新增 ' + op.path + '（' + op.bytes + 'B）';
    if (op.kind === 'delete') return '删除 ' + op.path;
    return '更新 ' + op.path + '（' + op.hunks + ' 个 hunk）';
  });
  return ok(lines.join('\n'), { operations: r.operations });
}

async function execute(name, args, ctx) {
  const a = args || {};
  const c = ctx || {};
  try {
    if (name === 'browser_open' || name === 'browser_read' || name === 'browser_click'
      || name === 'browser_type' || name === 'browser_screenshot' || name === 'browser_close'
      || name === 'computer_screenshot' || name === 'computer_click' || name === 'computer_type'
      || name === 'computer_key' || name === 'computer_open_app') {
      return await runInteraction(name, a, c);
    }
    if (name === 'fs_list') {
      const svc = fsOf(c);
      const limit = Math.min(Math.max(Number(a.limit || 80), 1), 200);
      const entries = svc.list(a.path || '.').sort((x, y) => x.name.localeCompare(y.name)).slice(0, limit);
      const lines = entries.map((e) => (e.type === 'directory' ? '[dir]  ' : e.type === 'file' ? '[file] ' : '[?]    ')
        + e.name + (e.type === 'file' ? '  ' + (e.size || 0) + 'B' : ''));
      return ok((lines.join('\n') || '（空目录）'), { path: svc.resolve(a.path || '.').abs, count: entries.length });
    }

    if (name === 'fs_read') {
      const svc = fsOf(c);
      let r;
      try { r = svc.readText(a.path); } catch (e) {
        if (Fs.isFsError(e) && e.code === 'FS_NOT_FOUND') {
          return fail("ENOENT: no such file or directory, open '" + a.path + "'", 'FS_NOT_FOUND');
        }
        if (Fs.isFsError(e)) return fsErrorToTool(e);
        throw e;
      }
      const all = r.content.split('\n');
      const start = Math.max(1, Number(a.startLine || 1));
      const end = Math.min(all.length, Number(a.endLine || all.length));
      const slice = all.slice(start - 1, end).map((line, i) => String(start + i).padStart(6, ' ') + ' | ' + line).join('\n');
      return ok(slice, { path: r.target.abs, lines: end - start + 1, totalLines: all.length, bytes: r.info.size, version: r.info.version });
    }

    if (name === 'read_image') return doReadImage(a, c);

    if (name === 'grep') return doGrep(a, c);

    if (name === 'glob') return doGlob(a, c);

    if (name === 'fs_write') {
      const svc = fsOf(c);
      try {
        const w = svc.writeText(a.path, a.content, { expectedVersion: a.expectedVersion });
        return ok('已写入 ' + w.target.abs + '（' + Buffer.byteLength(w.after) + 'B）',
          { path: w.target.abs, bytes: Buffer.byteLength(w.after), version: w.version });
      } catch (e) {
        if (Fs.isFsError(e)) return fsErrorToTool(e);
        throw e;
      }
    }

    if (name === 'apply_patch') {
      try { return doApplyPatch(a, c); } catch (e) {
        if (Fs.isFsError(e)) return fsErrorToTool(e);
        throw e;
      }
    }

    if (name === 'str_replace_editor') {
      try { return doStrReplaceEditor(a, c); } catch (e) {
        if (Fs.isFsError(e)) return fsErrorToTool(e);
        throw e;
      }
    }

    if (name === 'shell_exec') return await runShell(c, a);

    if (name === 'web_search') {
      // 官方 WebBlock 的 args 是 queries[]；单个 query 只作为旧调用兼容。
      const queries = Array.isArray(a.queries)
        ? a.queries.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 4)
        : [String(a.query || '').trim()].filter(Boolean);
      if (!queries.length) throw new Error('缺少 queries');
      const online = require('../online');
      const limit = Math.min(Math.max(Number(a.limit || 6), 1), 10);
      const merged = [];
      const allFacts = [];
      const errors = [];
      // D2-10：后端是 seam，不是工具实现。模型只认 web_search；
      // 换 DeepSeek Search / Bing / 企业内网不该改这个文件。
      const WebProviders = require('./web-providers');
      let webRes;
      try {
        webRes = await WebProviders.search({
          queries, limit, timeoutMs: 12000,
          provider: (c && c.webProvider) || undefined,
        });
      } catch (e) {
        return fail('搜索后端不可用：' + (e.message || String(e)), e.code || 'WEB_PROVIDER_ERROR');
      }
      for (const f of (Array.isArray(webRes.facts) ? webRes.facts : [])) allFacts.push(f);
      for (const x of (Array.isArray(webRes.sources) ? webRes.sources : [])) merged.push(x);
      for (const m of (Array.isArray(webRes.errors) ? webRes.errors : [])) errors.push(m);
      if (!allFacts.length && !merged.length) {
        return fail('没有检索到可用结果：' + (errors.join('；') || '无结果'), 'WEB_NO_RESULT');
      }
      const shown = allFacts.slice(0, limit);
      const lines = [];
      for (const f of shown) lines.push('- ' + f.text + (f.from ? '\n  来源：' + f.from : ''));
      // 官方 WebBlock 要的是 { url,title,snippet,publishedAt }，不是内部 facts。
      // 同一条事实的正文就是最贴题的 snippet；标题从 sources 里按 url 取。
      const byUrl = new Map(merged.map((x) => [x.url, x]));
      const seen = new Set();
      const sources = [];
      for (const f of shown) {
        const hit = byUrl.get(f.from) || {};
        const url = f.from || hit.url || '';
        if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
        seen.add(url);
        sources.push({ url, title: hit.title || '', snippet: f.text || '' });
      }
      if (!sources.length) {
        for (const x of merged) {
          const url = String((x && x.url) || '');
          if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
          seen.add(url);
          sources.push({ url, title: x.title || '', snippet: '' });
        }
      }
      return ok(lines.join('\n'), {
        queries, facts: shown, sources,
        truncated: allFacts.length > limit || errors.length > 0,
      });
    }

    if (name === 'web_fetch') {
      const url = safePublicUrl(a.url);
      if (!url) throw new Error('只允许公网 http(s) URL，且不能是 localhost/私有网段');
      const online = require('../online');
      const WebProviders = require('./web-providers');
      let r;
      try {
        r = await WebProviders.fetch({
          url, timeoutMs: 12000, maxBytes: 3 * 1024 * 1024,
          provider: (c && c.webProvider) || undefined,
        });
      } catch (e) {
        return fail('抓取后端不可用：' + (e.message || String(e)), e.code || 'WEB_PROVIDER_ERROR');
      }
      if (!r.ok) return fail('抓取失败：' + (r.reason || '未知'), 'WEB_FETCH_FAILED');
      const fullText = online.stripTags(r.html);
      const max = Math.min(Math.max(Number(a.maxChars || 12000), 200), 30000);
      return ok((r.title ? r.title + '\n\n' : '') + trimOut(fullText, max), {
        url, title: r.title, bytes: r.bytes,
        statusCode: Number.isInteger(r.status) ? r.status : 200,
        truncated: fullText.length > max,
      });
    }

    if (name === 'skill_list') {
      const loader = require('../skills/loader');
      const out = loader.loadAll({ workspacePath: c.workspace && c.workspace.path });
      const meta = { skills: out.skills.map((s) => s.name), roots: out.roots.map((r) => r.kind), shadowed: out.shadowed };
      if (!out.skills.length) {
        return ok('（没有可用技能）'
          + (out.missing.length ? '\n未找到：' + out.missing.map((m) => m.dir).join('；') : '')
          + ((out.errors || []).length ? '\n错误：' + out.errors.map((e) => e.file + ' ' + e.error).join('；') : ''), meta);
      }
      const lines = out.skills.map((s) => '- ' + s.name + '：' + (s.description || '')
        + (s.source && s.source !== 'builtin' ? '（来源：' + s.source + '）' : ''));
      if (out.shadowed.length) lines.push('（同名覆盖：' + out.shadowed.map((s) => s.name + ' ' + s.replaced + '→' + s.kept).join('；') + '）');
      return ok(lines.join('\n'), meta);
    }

    if (name === 'skill_read') {
      const target = String(a.name || '').trim();
      if (!target) throw new Error('缺少 name');
      const loader = require('../skills/loader');
      const skill = loader.read(target, { workspacePath: c.workspace && c.workspace.path });
      if (!skill) throw new Error('没有这个技能：' + target);
      return ok(trimOut(skill.body, 16000), { name: skill.name, path: skill.dir, source: skill.source });
    }

    if (name === 'workspace_info') {
      const ws = c.workspace || {};
      let top = [];
      try { top = fs.readdirSync(ws.path).slice(0, 60); } catch (_) {}
      return ok('名称：' + (ws.name || ws.id || '-') + '\n路径：' + (ws.path || '-')
        + '\n模式：' + (ws.mode || 'ask') + '\n顶层：\n' + top.map((n) => '- ' + n).join('\n'), { workspace: ws });
    }

    return fail('未知原生工具：' + name, 'UNKNOWN_TOOL');
  } catch (e) {
    return fail(e && e.message ? e.message : String(e), e && e.code ? e.code : 'TOOL_FAILED');
  }
}

module.exports = { specs, specList, execute, inside, safePublicUrl, MAX_OUT };
