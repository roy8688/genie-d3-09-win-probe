'use strict';
const fs = require('node:fs');
const path = require('node:path');
const native = require('./native-tools');
const Sandbox = require('./sandbox');
const TimeoutPolicy = require('./timeout-policy');
const Pwsh = require('./pwsh');
const Platform = require('../platform');
const Envelope = require('./tool-envelope');

/**
 * Harness S4：Agent Loop 的工具集与执行适配（对标 DSH `core/tools`）
 *
 * 职责边界（刻意收窄，便于审计）：
 *  · 只做两件事：① 把 Genie 已有能力声明成 OpenAI function 工具；
 *                ② 把模型返回的 tool_call 映射回现有执行入口。
 *  · 不自带执行器：真正的副作用仍走 relay 的 `_dispatchToPlugin`（gate/hooks/guardian/审计都在那），
 *    工具执行函数由调用方注入，本模块零 require relay、纯数据 + 纯映射，独立可测。
 *
 * 为什么工具集从 nl-op-mapping.json 派生的固定清单，而不是自动暴露全部 38 个 op：
 *  · 38 个 op 里有 delete_node / undo / 退出类高风险动作，让模型自由调用代价太大；
 *  · agent loop 首版只放"读 + 低风险写"子集，高风险动作仍走原有确定性路由。
 *  · 清单是白名单，改这里即可扩权，不需要动 relay。
 */

/** 工具白名单：name → { op, build, risk }。build(args) 把模型参数转成 _dispatchToPlugin 的 params。 */
const TOOL_SPECS = {  get_document_info: {
    op: 'get_document_info',
    description: '读取当前 Figma 文档的基本信息（页面数、文件名、选中节点数）。不修改任何内容。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    build: () => ({}),
  },
  list_pages: {
    op: 'list_pages',
    description: '列出当前 Figma 文档的所有页面（名称与 id）。只读。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    build: () => ({}),
  },
  scan_nodes: {
    op: 'scan_nodes',
    description: '扫描当前页面或选中范围的节点结构（类型、名称、尺寸）。只读，用于了解画布现状。',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['page', 'selection'], description: '扫描范围，默认 page' },
        maxNodes: { type: 'integer', minimum: 1, maximum: 200, description: '最多返回节点数，默认 50' },
      },
      additionalProperties: false,
    },
    build: (a) => {
      const p = {};
      if (a && a.scope) p.scope = a.scope;
      if (a && a.maxNodes) p.maxNodes = Math.min(200, Math.max(1, Number(a.maxNodes) || 50));
      return p;
    },
  },
  audit_layout: {
    op: 'audit_layout',
    description: '对当前选中元素或页面做布局审查，返回发现的问题清单。只读。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    build: () => ({}),
  },
  audit_spacing: {
    op: 'audit_spacing',
    description: '审查当前页面元素的间距一致性，返回问题清单。只读。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    build: () => ({}),
  },
  check_naming: {
    op: 'check_naming',
    description: '检查图层命名是否规范，返回不规范图层清单。只读。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    build: () => ({}),
  },
  create_frame: {
    op: 'create_frame',
    description: '新建一个画板（Frame）。仅在用户明确要求新建画板时调用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '画板名称' },
        width: { type: 'integer', minimum: 1, maximum: 10000 },
        height: { type: 'integer', minimum: 1, maximum: 10000 },
      },
      additionalProperties: false,
    },
    build: (a) => {
      const p = {};
      if (a && a.name) p.name = String(a.name);
      if (a && a.width) p.width = Math.min(10000, Math.max(1, Number(a.width) || 375));
      if (a && a.height) p.height = Math.min(10000, Math.max(1, Number(a.height) || 812));
      return p;
    },
  },
  create_text: {
    op: 'create_text',
    description: '在画布上新建文本节点。仅在用户明确要求添加文字时调用。',
    parameters: {
      type: 'object',
      properties: { content: { type: 'string', description: '要显示的文字内容' } },
      required: ['content'],
      additionalProperties: false,
    },
    build: (a) => ({ content: String((a && a.content) || '') }),
  },

  /* ---- 以下是本地工具（不落到 Figma 指令通道，由 agent loop 进程内处理） ---- */

  todo_write: {
    local: true,
    risk: 'local',
    description: '记录并更新任务清单，用于规划多步工作、展示进度；单步小事不必用。'
      + '开工前为每个具体步骤加一条待办。工作未完时保持正在进行的那项为 in_progress'
      + '（默认同一时间只能有一项 in_progress）。每完成一项立即标记 completed。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '完整的任务清单，会整体替换之前的清单。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              content: { type: 'string', description: '任务内容，一句简短的祈使句。' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'pending 未开始 / in_progress 进行中 / completed 已完成' },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
  },

  ask_user_question: {
    local: true,
    risk: 'local',
    description: '在需要确认、需要用户做选择、或缺少关键信息才能继续时，向用户提出简洁的问题。'
      + '用户会看到选项卡片；若推荐某个选项，把它放在第一位并在标签后加"（推荐）"。',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: '要继续之前需要问用户的问题。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: '该问题的稳定 id，会回显在答案里。' },
              question: { type: 'string', description: '要问用户的具体问题。' },
              header: { type: 'string', description: '可选的短标题，例如"确认"或"选择模式"。' },
              options: {
                type: 'array',
                description: '可选的选择项。',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    label: { type: 'string', description: '简短的用户可见选项标签。' },
                    description: { type: 'string', description: '一句话说明该选项的取舍或影响。' },
                  },
                  required: ['label'],
                },
              },
              multi_select: { type: 'boolean', description: '是否允许多选，默认 false。' },
            },
            required: ['id', 'question'],
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
  },

  /** P1：子智能体。任务要具体；子会话只有自己的工具作用域，不继承整段聊天历史。 */
  spawn_subagent: {
    local: true,
    risk: 'read',
    description: '把一个明确的子任务交给独立子智能体执行，返回它的结论。'
      + '适合并行调研、独立审查、拆解长任务；子智能体看不到父会话全部历史，所以任务要写清楚目标、输入与验收标准。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '子任务：目标、已知输入、要交付什么，写具体。' },
        title: { type: 'string', description: '可选的短标题，用于状态列表。' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },

  // ── D2：交付 / 目标 / 定时 / 后台任务 / 历史检索 ─────────────────────
  // 这些工具都算 local：它们不碰 Figma，也不经过原生工具表；但**必须**走同一条
  // ToolRegistry → ToolPolicy → ToolPipeline，否则"模型能调"和"权限能拦"会分成两套。

  present_files: {
    local: true,
    risk: 'read',
    description: '把一个或多个已经存在的文件交付给用户（聊天里出现可点开的文件卡）。'
      + '只登记真实存在的文件，不复制、不改内容；文件已不存在时明确标 missing。',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: '文件绝对路径或相对工作区的路径', minItems: 1 },
        title: { type: 'string', description: '可选的交付标题，例如“VW PRD 终稿”' },
      },
      required: ['paths'],
      additionalProperties: false,
    },
  },
  present_deliverable: {
    local: true,
    risk: 'read',
    description: '交付单个文件，并带上标题与来源（docx/xlsx/pptx/pdf/image/code…）。'
      + '与 present_files 等价，适合只有一个产物的场景。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径或相对工作区的路径' },
        title: { type: 'string', description: '交付标题' },
        source: { type: 'string', description: '产物来源，如 prd / sheets / slides / draw / shell' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },

  goal_update: {
    local: true,
    risk: 'local',
    description: '创建、推进、完成或阻塞当前会话目标。目标要是一句可验收的结果，不是待办清单。'
      + '同一会话只保留一个当前目标；状态变化会写进事件日志，重启后仍在。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'completed', 'blocked', 'cleared'], description: '目标状态；cleared 表示清除目标' },
        text: { type: 'string', description: '目标正文（可验收的结果）。completed/blocked 时可省略，沿用当前目标' },
        progress: { type: 'string', description: '可选：一句话进展或阻塞原因' },
      },
      required: ['status'],
      additionalProperties: false,
    },
  },

  schedule_create: {
    local: true,
    risk: 'write',
    description: '创建定时任务/提醒。scheduleType 支持 cron（周期）、at（一次性时间）、rrule（日历规则）。'
      + '时间表达式算不出下一次会直接失败，不会存一个永远不会响的任务。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '任务标题，用户能一眼看懂' },
        query: { type: 'string', description: '到点时要执行/提醒的话' },
        scheduleType: { type: 'string', enum: ['cron', 'at', 'rrule'] },
        schedule: { type: 'string', description: 'cron 表达式 / at 的 ISO 时间 / rrule 规则' },
        enable: { type: 'boolean', description: '是否立即启用，默认 true' },
      },
      required: ['title', 'query', 'scheduleType', 'schedule'],
      additionalProperties: false,
    },
  },
  schedule_list: {
    local: true,
    risk: 'read',
    description: '列出定时任务（含下次触发时间、状态）。只读。',
    parameters: {
      type: 'object',
      properties: {
        enabledOnly: { type: 'boolean', description: '只看启用中的任务' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      }, additionalProperties: false,
    },
  },
  schedule_view: {
    local: true,
    risk: 'read',
    description: '查看单个定时任务的完整信息：标题、内容、时间表达式、下次触发、运行次数与最后结果。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '任务 id' } },
      required: ['id'], additionalProperties: false,
    },
  },
  schedule_update: {
    local: true,
    risk: 'write',
    description: '修改定时任务的标题/内容/时间/启停。id 来自 schedule_list。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id' },
        title: { type: 'string' },
        query: { type: 'string' },
        scheduleType: { type: 'string', enum: ['cron', 'at', 'rrule'] },
        schedule: { type: 'string' },
        enable: { type: 'boolean' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  schedule_cancel: {
    local: true,
    risk: 'write',
    description: '删除定时任务。id 来自 schedule_list；删除不可恢复。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '任务 id' } },
      required: ['id'], additionalProperties: false,
    },
  },

  job_start: {
    local: true,
    risk: 'exec',
    description: '启动一个后台任务（真实子进程），立即返回 job id。stdout/stderr 分开记录，结束后有真实退出码。'
      + '用于长构建、长测试、批量转换；短命令直接用 shell_exec。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        title: { type: 'string', description: '短标题，用于列表' },
        cwd: { type: 'string', description: '工作目录，默认当前工作区' },
        timeoutMs: { type: 'integer', description: '超时毫秒，默认 30 分钟，最大 24 小时' },
      },
      required: ['command'], additionalProperties: false,
    },
  },
  job_list: {
    local: true,
    risk: 'read',
    description: '列出后台任务（运行中/完成/失败/停止），含 pid、退出码与时长。只读。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['running', 'done', 'failed', 'killed', 'timeout', 'lost'] },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      }, additionalProperties: false,
    },
  },
  job_output: {
    local: true,
    risk: 'read',
    description: '读取后台任务的 stdout/stderr 尾部与退出码。任务还在跑时也能读当前输出。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        maxBytes: { type: 'integer', minimum: 256, maximum: 131072, description: '每个流最多返回多少字节，默认 16000' },
      },
      required: ['id'], additionalProperties: false,
    },
  },
  job_wait: {
    local: true,
    risk: 'read',
    description: '等待后台任务结束（或等够 timeoutMs 后返回当前状态）。不会把“还没结束”说成完成。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 500, maximum: 60000, description: '最多等多久，默认 30000' },
      },
      required: ['id'], additionalProperties: false,
    },
  },
  job_kill: {
    local: true,
    risk: 'write',
    description: '停止后台任务。先终止整个进程组，避免子进程残留。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'], additionalProperties: false,
    },
  },

  mcp_server_status: {
    local: true,
    risk: 'read',
    description: '列出已配置的 MCP server、连接状态、工具/资源/prompt 数量与凭证是否就绪（绝不回传 token）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  mcp_list_resources: {
    local: true,
    risk: 'read',
    description: '列出一个已连接 MCP server 暴露的资源（uri/name/mimeType）。',
    parameters: {
      type: 'object',
      properties: { server: { type: 'string', description: 'MCP server 名' } },
      required: ['server'], additionalProperties: false,
    },
  },
  mcp_read_resource: {
    local: true,
    risk: 'read',
    description: '读取 MCP server 的一个资源 URI，返回文本内容（二进制只报 mimeType）。',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        uri: { type: 'string', description: '资源 uri，来自 mcp_list_resources' },
      },
      required: ['server', 'uri'], additionalProperties: false,
    },
  },
  mcp_get_prompt: {
    local: true,
    risk: 'read',
    description: '取一个 MCP prompt 展开后的消息文本（不是执行工具）。',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        name: { type: 'string', description: 'prompt 名' },
        arguments: { type: 'object', description: 'prompt 参数', additionalProperties: true },
      },
      required: ['server', 'name'], additionalProperties: false,
    },
  },

  lsp: {
    local: true,
    risk: 'read',
    description: '用语言服务器做语义级代码导航：goToDefinition / findReferences / goToImplementation / hover / diagnostics。'
      + '文本搜索有歧义、或修改前要确认真实定义/引用时用它；普通浏览仍优先 search/read。'
      + '位置是从 1 开始的 line/character（UTF-16）；diagnostics 只看文件，不需要位置。',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['goToDefinition', 'findReferences', 'goToImplementation', 'hover', 'diagnostics'],
          description: '查询类型',
        },
        file_path: { type: 'string', description: '工作区内的相对路径或绝对路径' },
        line: { type: 'integer', minimum: 1, description: '1-based 行号；导航/悬停必填' },
        character: { type: 'integer', minimum: 1, description: '1-based UTF-16 列号；导航/悬停必填' },
      },
      required: ['operation', 'file_path'], additionalProperties: false,
    },
  },

  terminal_start: {
    local: true,
    risk: 'exec',
    description: '开一个持久终端（同一会话里保留 cd/export/环境变量）。返回 terminal id；'
      + '后续用 terminal_exec 连着跑命令。POSIX 优先真 PTY；Windows 走持久 pwsh 管道（pty:false，不冒充 ConPTY）。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '终端名，便于 list/区分' },
        cwd: { type: 'string', description: '起始目录，必须是工作区内相对/绝对路径' },
        shell: { type: 'string', description: '默认 bash（Windows 为 pwsh）' },
      },
      additionalProperties: false,
    },
  },
  terminal_exec: {
    local: true,
    risk: 'exec',
    description: '在持久终端里执行一条命令并等到提示符返回：保留 cd/export，返回真实 exitCode、cwd 与输出。'
      + '不是交互式全屏程序（vim/top）时优先用它；要持续喂 stdin 用 terminal_write。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'terminal id；不填用当前会话最近开的终端' },
        command: { type: 'string', description: '要执行的命令' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000, description: '默认 120000；超时返回已有输出' },
        maxBytes: { type: 'integer', minimum: 1024, maximum: 65536, description: '输出上限，默认 64KB，只保留末尾' },
      },
      required: ['command'], additionalProperties: false,
    },
  },
  terminal_write: {
    local: true,
    risk: 'exec',
    description: '向持久终端写原始输入，用于交互式程序或分多段提交。默认提交（补回车）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        text: { type: 'string', description: '要写入的文本' },
        submit: { type: 'boolean', description: '是否补一个回车，默认 true' },
      },
      required: ['text'], additionalProperties: false,
    },
  },
  terminal_read: {
    local: true,
    risk: 'read',
    description: '增量读取终端输出（按 chunk seq）。返回 status/cwd/exitCode，便于判断进程是否还在跑。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        since: { type: 'integer', minimum: 0, description: '上次读到的 seq；0 表示从头（最多 80 个 chunk）' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多读多少个 chunk，默认 80' },
        maxBytes: { type: 'integer', minimum: 1024, maximum: 65536 },
      },
      additionalProperties: false,
    },
  },
  terminal_kill: {
    local: true,
    risk: 'exec',
    description: '结束持久终端（连同前台进程）。SIGTERM 默认，必要时 SIGKILL。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        signal: { type: 'string', enum: ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP'], description: '默认 SIGTERM' },
      },
      additionalProperties: false,
    },
  },

  session_query: {
    local: true,
    risk: 'read',
    description: '在当前会话或全部历史会话里做全文检索，定位“上次那个决定/之前定的方案”的原话。'
      + '返回来源会话、角色、时间与命中片段；不复制附件与大文件。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要找的原话或关键词' },
        scope: { type: 'string', enum: ['all', 'session'], description: '默认 all；session 只看当前会话' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '默认 8' },
      },
      required: ['query'], additionalProperties: false,
    },
  },
  session_list: {
    local: true,
    risk: 'read',
    description: '列出历史会话（标题、更新时间、消息数）。按标题过滤只用于找某一个会话，不等同全文检索。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选：按标题包含的字过滤' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '默认 20' },
      }, additionalProperties: false,
    },
  },
  session_read: {
    local: true,
    risk: 'read',
    description: '读取某个历史会话的尾部消息（默认 20 条）。session_query 命中后用它回到原话上下文。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 id，来自 session_list / session_query' },
        limit: { type: 'integer', minimum: 2, maximum: 100, description: '默认 20' },
      },
      required: ['sessionId'], additionalProperties: false,
    },
  },
};

// 原生工具（fs/shell/web/skill）与 Figma 工具统一进同一张白名单。
// 不把 native specs 直接塞进 TOOL_SPECS：后者被测试与旧调用方当作“Figma + 本地工具”的原表，
// 混入会改变 `LOCAL_TOOLS` 的含义。这里单独合并，执行时再分派。
// **必须带 name**：策略层用 spec.name 判断 fs_write 是否越界。
// native.specs 是按工具名索引的对象，值里原本没有 name；直接合并会让 spec.name 为空，
// `name !== 'fs_write'` 恒真 → 工作区外写入被误判成“画布写”直接放行。
// 用 specList()（已补 name/native）重建，策略层与执行层看到的是同一张表。
const NATIVE_SPECS = Object.fromEntries(native.specList().map((s) => [s.name, s]));
const ALL_SPECS = Object.assign({}, TOOL_SPECS, NATIVE_SPECS);

/** 生成给模型的 OpenAI function 工具定义（每次返回新数组，避免被调用方改脏）。 */
function definitions() {
  return Object.keys(ALL_SPECS).map((name) => {
    const s = ALL_SPECS[name];
    return {
      type: 'function',
      function: {
        name,
        description: s.description,
        parameters: JSON.parse(JSON.stringify(s.parameters)),
      },
    };
  });
}

/** 白名单判断：模型只能调清单内的工具。 */
function knows(name) { return Object.prototype.hasOwnProperty.call(ALL_SPECS, String(name || '')); }

/** 本地工具（不落 Figma 指令通道）。 */
const LOCAL_TOOLS = new Set(Object.keys(TOOL_SPECS).filter((k) => TOOL_SPECS[k].local));

/** 把 LSP 规范结果排成模型可读行；位置统一回到 1-based。 */
function formatLspContent(r) {
  if (!r) return '（LSP 没有返回结果）';
  if (r.kind === 'hover') {
    return r.hover && r.hover.contents ? r.hover.contents : '这个位置没有悬停信息。';
  }
  if (r.kind === 'diagnostics') {
    if (!r.diagnostics.length) {
      return r.complete ? '没有诊断问题。' : '诊断未在超时内返回（语言服务器可能仍在索引），不能据此断定没有问题。';
    }
    const lines = r.diagnostics.map((d) => d.path + ':' + (d.range.start.line + 1) + ':' + (d.range.start.character + 1)
      + ' [' + d.severity + '] ' + d.message + (d.source ? ' (' + d.source + (d.code != null ? ' ' + d.code : '') + ')' : ''));
    return lines.join('\n') + (r.truncated ? '\n…诊断已截断，共 ' + r.total + ' 条' : '');
  }
  const label = ({ goToDefinition: '定义', findReferences: '引用', goToImplementation: '实现' })[r.operation] || '位置';
  if (!r.locations.length) return '没有找到' + label + '。';
  const lines = [];
  let chars = 0;
  for (const loc of r.locations) {
    const line = loc.path + ':' + (loc.range.start.line + 1) + ':' + (loc.range.start.character + 1);
    if (chars + line.length > 16000) { lines.push('…结果已截断，共 ' + r.total + ' 个' + label); break; }
    chars += line.length + 1;
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * 执行本地工具。
 * @param {string} name
 * @param {object} args
 * @param {object} deps  {onTodo(list), askUser(questions)}
 */
async function executeLocal(name, args, deps) {
  const o = deps || {};
  if (name === 'todo_write') {
    const Todo = require('./todo-store');
    let list;
    try {
      list = Todo.toTodoList(args && args.todos, !!o.allowParallelTodos);
    } catch (e) {
      return { ok: false, content: '待办校验未通过：' + String((e && e.message) || e), command: null };
    }
    let persisted = false;
    if (typeof o.onTodo === 'function') {
      try { await o.onTodo(list); persisted = true; }
      catch (e) { return { ok: false, content: '待办保存失败：' + String((e && e.message) || e), command: null }; }
    }
    const c = Todo.counts(list);
    return {
      ok: true,
      content: Todo.renderSummary(list) + '（清单：' + list.map((t) => t.content + '[' + t.status + ']').join('；') + '）',
      command: null,
      raw: { todos: list, counts: c, persisted: persisted },
    };
  }
  if (name === 'ask_user_question') {
    const qs = Array.isArray(args && args.questions) ? args.questions : [];
    if (!qs.length) return { ok: false, content: 'questions 不能为空', command: null };
    if (typeof o.askUser !== 'function') {
      return { ok: false, content: '当前环境无法向用户提问（提问通道未接入），请基于已知信息继续或直接说明缺少什么。', command: null };
    }
    try {
      const answers = await o.askUser(qs);
      // raw 必须是对象，才能被 uiMeta 的字段透传拾取；旧版直接把数组当 raw，
      // 结果里带着答案，UI 却一张问题卡也回放不出来。
      return { ok: true, content: JSON.stringify({ answers: answers || [] }), command: null, raw: { answers: answers || [] } };
    } catch (e) {
      return { ok: false, content: '提问未完成：' + String((e && e.message) || e), command: null };
    }
  }
  if (name === 'spawn_subagent') {
    if (typeof o.spawnSubagent !== 'function') {
      return { ok: false, content: '当前环境没有子智能体运行时，无法派发。', command: null, code: 'SUBAGENT_UNAVAILABLE' };
    }
    const task = String((args && args.task) || '').trim();
    if (!task) return { ok: false, content: 'task 不能为空', command: null };
    try {
      const r = await o.spawnSubagent({
        task,
        title: String((args && args.title) || '').slice(0, 80),
      });
      return {
        ok: !!(r && r.ok),
        content: String((r && r.content) || '子智能体没有返回内容'),
        command: null,
        code: (r && r.code) || null,
        raw: r || null,
      };
    } catch (e) {
      return { ok: false, content: '子智能体执行失败：' + String((e && e.message) || e), command: null };
    }
  }
  if (name === 'present_files' || name === 'present_deliverable') {
    const Artifacts = require('../artifacts');
    const root = String((o.native && o.native.workspace && o.native.workspace.path) || '');
    let list = [];
    if (name === 'present_deliverable') list = [args && args.path];
    else if (Array.isArray(args && args.paths)) list = args.paths;
    else if (args && args.paths != null) list = [args.paths];
    list = list.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20);
    if (!list.length) return { ok: false, content: '没有要交付的文件路径', command: null, code: 'NO_PATH' };
    const items = [];
    const missing = [];
    for (const p of list) {
      const abs = path.isAbsolute(p) ? path.resolve(p) : (root ? path.resolve(root, p) : '');
      if (!abs) { missing.push({ path: p, reason: '没有工作区，无法解析相对路径' }); continue; }
      let st = null;
      try { st = fs.statSync(abs); } catch (_) { st = null; }
      if (!st || !st.isFile()) { missing.push({ path: abs, reason: '文件不存在或不是普通文件' }); continue; }
      const title = String((args && args.title) || '').trim();
      const entry = Artifacts.record({
        path: abs,
        title: list.length === 1 ? title : '',
        sessionId: String(o.sessionId || ''),
        msgId: String(o.msgId || ''),
        source: String((args && args.source) || 'agent-present'),
      });
      items.push({
        path: abs,
        name: path.basename(abs),
        kind: Artifacts.kindOf(abs),
        size: st.size,
        bytes: Artifacts.humanSize(st.size),
        title: (entry && entry.title) || path.basename(abs).replace(/\.[^.]+$/, ''),
        sessionId: String(o.sessionId || ''),
      });
    }
    if (!items.length) {
      return { ok: false, content: '没有可交付的文件：' + missing.map((m) => m.path + '（' + m.reason + '）').join('；'), command: null, raw: { items, missing }, code: 'FILE_NOT_FOUND' };
    }
    // D2-03：交付是会话事实，不只是工具结果。切走会话/重启后，
    // 历史必须能回答"这轮交付了什么"，而不是只剩一句路径文本。
    if (o.sessionId) {
      try {
        require('../conversation').eventLog(String(o.sessionId)).append('deliverable/presented', {
          items: items.map((x) => ({ path: x.path, name: x.name, kind: x.kind, bytes: x.bytes, title: x.title })),
          count: items.length,
          msgId: String(o.msgId || ''),
        });
      } catch (_) { /* 事件写失败不影响当轮可点：登记册与 tool/result 已经落盘 */ }
    }
    const content = '已交付 ' + items.length + ' 个文件：\n'
      + items.map((x) => '- ' + x.name + '（' + x.kind + '，' + x.bytes + '）\n  ' + x.path).join('\n')
      + (missing.length ? '\n未交付：' + missing.map((m) => m.path + '（' + m.reason + '）').join('；') : '');
    return { ok: true, content, command: null, raw: { items, missing, count: items.length } };
  }

  if (name === 'goal_update') {
    const Conversation = require('../conversation');
    const sid = String(o.sessionId || '');
    if (!sid) return { ok: false, content: '当前没有会话上下文，无法写目标', command: null, code: 'NO_SESSION' };
    let state;
    try { state = Conversation.sessionState(sid); } catch (e) { state = null; }
    if (!state) return { ok: false, content: '找不到当前会话：' + sid, command: null, code: 'NO_SESSION' };
    const status = String((args && args.status) || 'active');
    if (!['active', 'completed', 'blocked', 'cleared'].includes(status)) {
      return { ok: false, content: 'status 只能是 active / completed / blocked / cleared', command: null };
    }
    const cur = state.goal || {};
    const text = status === 'cleared' ? '' : String((args && args.text) || cur.text || '').trim();
    if (status !== 'cleared' && !text) return { ok: false, content: '目标是空的：active/completed/blocked 必须给出 text（或已有目标）', command: null };
    const goal = Conversation.setGoal(sid, { text, status });
    const progress = String((args && args.progress) || '').trim();
    return {
      ok: true,
      content: '目标已更新：' + (text || '（已清除）') + ' [' + status + ']' + (progress ? '\n进展：' + progress : ''),
      command: null,
      raw: { goal, progress },
    };
  }

  if (name === 'schedule_create' || name === 'schedule_list' || name === 'schedule_view' || name === 'schedule_update' || name === 'schedule_cancel') {
    const CronJobs = require('../cron-jobs');
    if (name === 'schedule_list') {
      const opts = {};
      if (args && args.enabledOnly) opts.enabledOnly = true;
      if (args && args.limit) opts.limit = Math.min(50, Math.max(1, Number(args.limit)));
      const jobs = CronJobs.list(opts);
      if (!jobs.length) return { ok: true, content: '（没有定时任务）', command: null, raw: { jobs: [] } };
      const content = jobs.map((j) => '- ' + j.id + ' · ' + j.title + '\n  '
        + (j.enable ? '下次 ' + CronJobs.describeNext(j.nextRunAt) : '已停用')
        + ' · ' + j.scheduleType + ' ' + j.schedule).join('\n');
      return { ok: true, content, command: null, raw: { jobs } };
    }
    if (name === 'schedule_view') {
      const id = String((args && args.id) || '').trim();
      const job = id ? CronJobs.get(id) : null;
      if (!job) return { ok: false, content: '没有这个任务：' + (id || '（空 id）'), command: null, code: 'NOT_FOUND' };
      return {
        ok: true,
        content: job.title + '（' + job.id + '）\n· 内容：' + job.query
          + '\n· 时间：' + job.scheduleType + ' ' + job.schedule
          + '\n· 下次：' + (job.enable ? CronJobs.describeNext(job.nextRunAt) : '已停用')
          + '\n· 已运行：' + (job.runs || 0) + ' 次'
          + (job.lastResult ? '\n· 上次结果：' + job.lastResult : ''),
        command: null, raw: { job },
      };
    }
    if (name === 'schedule_create') {
      const a = args || {};
      // 模型习惯给 ISO（2026-11-23T09:00:00Z），而 cron-schedule 的 at 只认
      // "2026-11-23 09:00" 这类人读本地时间。这里在工具边界做一次归一，
      // 不让"格式差一个 T"变成用户看到的一句"看不懂的时间"。
      let schedule = String(a.schedule || '').trim();
      if (String(a.scheduleType || '') === 'at' && /^\d{4}-\d{2}-\d{2}T/.test(schedule)) {
        const d = new Date(schedule);
        if (!isNaN(d.getTime())) {
          const p = (n) => String(n).padStart(2, '0');
          schedule = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
            + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
        }
      }
      let job;
      try {
        job = CronJobs.add({
          title: a.title, query: a.query, scheduleType: a.scheduleType, schedule,
          enable: a.enable !== false,
        });
      } catch (e) {
        return { ok: false, content: '创建定时任务失败：' + e.message, command: null, code: 'SCHEDULE_INVALID' };
      }
      try {
        CronJobs.update(job.id, { originSessionId: String(o.sessionId || ''), originTitle: String(o.msgTitle || '') });
      } catch (_) {}
      const saved = CronJobs.get(job.id) || job;
      return {
        ok: true,
        content: '已创建定时任务：' + saved.title + '\n· id：' + saved.id
          + '\n· 类型：' + saved.scheduleType + ' ' + saved.schedule
          + '\n· 下次：' + CronJobs.describeNext(saved.nextRunAt),
        command: null,
        raw: { job: saved },
      };
    }
    if (name === 'schedule_update') {
      const id = String((args && args.id) || '').trim();
      if (!id) return { ok: false, content: '缺少 id', command: null };
      const patch = {};
      for (const k of ['title', 'query', 'scheduleType', 'schedule']) {
        if (args && args[k] !== undefined) patch[k] = String(args[k]);
      }
      if (args && args.enable !== undefined) patch.enable = !!args.enable;
      let job;
      try { job = CronJobs.update(id, patch); }
      catch (e) { return { ok: false, content: '修改失败：' + e.message, command: null, code: 'SCHEDULE_INVALID' }; }
      if (!job) return { ok: false, content: '没有这个任务：' + id, command: null, code: 'NOT_FOUND' };
      return {
        ok: true,
        content: '已更新：' + job.title + ' · ' + (job.enable ? '下次 ' + CronJobs.describeNext(job.nextRunAt) : '已停用'),
        command: null, raw: { job },
      };
    }
    const id = String((args && args.id) || '').trim();
    if (!id) return { ok: false, content: '缺少 id', command: null };
    const removed = CronJobs.remove(id);
    return removed
      ? { ok: true, content: '已删除定时任务：' + id, command: null, raw: { id } }
      : { ok: false, content: '没有这个任务：' + id, command: null, code: 'NOT_FOUND' };
  }

  if (name === 'job_start' || name === 'job_list' || name === 'job_output' || name === 'job_wait' || name === 'job_kill') {
    const Jobs = require('./job-store');
    const root = String((o.native && o.native.workspace && o.native.workspace.path) || '');
    if (name === 'job_start') {
      const a = args || {};
      let cwd = String(a.cwd || root || '').trim();
      if (!cwd) return { ok: false, content: '没有工作目录：请先选择工作区，或显式给 cwd', command: null, code: 'NO_WORKSPACE' };
      if (!path.isAbsolute(cwd)) {
        if (!root) return { ok: false, content: '相对 cwd 需要工作区', command: null, code: 'NO_WORKSPACE' };
        cwd = path.resolve(root, cwd);
      }
      if (root) {
        const absRoot = path.resolve(root);
        if (!(cwd === absRoot || cwd.startsWith(absRoot + path.sep))) {
          return { ok: false, content: 'cwd 越过工作区边界：' + cwd, command: null, code: 'OUTSIDE_WORKSPACE' };
        }
      }
      // D3-04：后台任务和前台命令走同一个沙箱前缀；准备失败就不启动，
      // 不能出现“前台有沙箱、后台绕过去”的第二个执行面。
      let exec = null;
      let sandboxMeta = null;
      try {
        const policy = Sandbox.policyFor({
          permission: o.native && o.native.permission,
          workspaceRoot: root || cwd,
          config: o.native && o.native.sandbox,
        });
        const isWin = process.platform === 'win32';
        // D3-10：POSIX shell 由平台层选；Windows 仍走 pwsh 的编码入口。
        const shellSpec = isWin
          ? { command: Pwsh.resolvePwshPath({ configured: process.env.GENIE_PWSH_PATH }), args: Pwsh.argsFor(String(a.command || '')) }
          : Platform.shell.shellSpec(String(a.command || ''), { allowSubprocess: policy.allowSubprocess });
        const shellCommand = shellSpec.command;
        const shellArgs = shellSpec.args;
        const wrapped = Sandbox.prepare({
          command: shellCommand,
          args: shellArgs,
          cwd,
          env: process.env,
          policy,
        });
        sandboxMeta = { backend: wrapped.backend, mode: wrapped.mode, enforced: wrapped.enforced };
        exec = {
          command: wrapped.command,
          args: wrapped.args,
          env: wrapped.env,
          cleanup: wrapped.cleanup,
          sandbox: sandboxMeta,
        };
      } catch (e) {
        return { ok: false, content: (e && e.message) || String(e), command: null, code: (e && e.code) || 'SANDBOX_ERROR' };
      }
      let job;
      try {
        job = Jobs.start({
          command: a.command, cwd, title: a.title,
          timeoutMs: a.timeoutMs,
          sessionId: String(o.sessionId || ''),
          source: 'agent',
          exec,
        });
      } catch (e) {
        if (exec && typeof exec.cleanup === 'function') { try { exec.cleanup(); } catch (_) {} }
        return { ok: false, content: '后台任务启动失败：' + e.message, command: null, code: 'JOB_START_FAILED' };
      }
      return {
        ok: true,
        content: '后台任务已启动：' + job.id + '\n· ' + job.title + '\n· pid：' + (job.pid || '-')
          + '\n· 超时：' + Math.round(job.timeoutMs / 1000) + 's'
          + '\n· 沙箱：' + (sandboxMeta ? (sandboxMeta.backend + ' / ' + sandboxMeta.mode) : 'none')
          + '\n用 job_output 读输出，job_wait 等结束。',
        command: null, raw: { job },
      };
    }
    if (name === 'job_list') {
      const jobs = Jobs.list({ status: args && args.status, limit: (args && args.limit) || 20 });
      if (!jobs.length) return { ok: true, content: '（没有后台任务）', command: null, raw: { jobs: [] } };
      const content = jobs.map((j) => '- ' + j.id + ' · ' + j.title + '\n  ' + j.status
        + (j.exitCode != null ? ' · exit ' + j.exitCode : '')
        + ' · ' + Math.round((Number(j.durationMs || (Date.now() - j.startedAt)) || 0) / 1000) + 's'
        + ' · pid ' + (j.pid || '-')).join('\n');
      return { ok: true, content, command: null, raw: { jobs } };
    }
    if (name === 'job_output') {
      const id = String((args && args.id) || '').trim();
      const out = Jobs.output(id, { maxBytes: args && args.maxBytes });
      if (!out) return { ok: false, content: '没有这个任务：' + id, command: null, code: 'NOT_FOUND' };
      const j = out.job;
      const content = '任务 ' + j.id + ' · ' + j.status + (j.exitCode != null ? '（exit ' + j.exitCode + '）' : '')
        + '\n--- stdout ---\n' + (out.stdout || '（空）')
        + '\n--- stderr ---\n' + (out.stderr || '（空）');
      return { ok: true, content, command: null, raw: out };
    }
    if (name === 'job_wait') {
      const id = String((args && args.id) || '').trim();
      const r = await Jobs.wait(id, (args && args.timeoutMs) || 30000);
      if (!r.ok && r.error) return { ok: false, content: r.error, command: null, code: 'NOT_FOUND' };
      const j = r.job;
      return {
        ok: true,
        content: j.status === 'running'
          ? '任务仍在运行（已等 ' + Math.round((r.waitedMs || 0) / 1000) + 's）；用 job_output 看当前输出。'
          : '任务已结束：' + j.status + (j.exitCode != null ? '（exit ' + j.exitCode + '）' : ''),
        command: null, raw: r,
      };
    }
    const id = String((args && args.id) || '').trim();
    const r = Jobs.kill(id, 'stop');
    return { ok: !!r.ok, content: r.ok ? '正在停止任务：' + id : (r.error || '停止失败'), command: null, raw: r };
  }

  if (name === 'mcp_server_status' || name === 'mcp_list_resources' || name === 'mcp_read_resource' || name === 'mcp_get_prompt') {
    const Mcp = require('./mcp-manager');
    const a = args || {};
    try {
      if (name === 'mcp_server_status') {
        const st = Mcp.status();
        const lines = st.servers.length
          ? st.servers.map((x) => '- ' + x.name + ' · ' + x.state + ' · tools ' + x.toolCount + ' · resources ' + x.resourceCount
            + ' · prompts ' + x.promptCount + (x.error ? '\n  ' + x.error : '')).join('\n')
          : '（没有配置 MCP server；在 config/mcp.json 的 servers 里添加）';
        return { ok: true, content: lines, command: null, raw: st };
      }
      if (name === 'mcp_list_resources') {
        const summary = await Mcp.listResources(a.server);
        if (!summary.count && !summary.templateCount) return { ok: true, content: '（这个 server 没有暴露资源）', command: null, raw: summary };
        return { ok: true, content: summary.text, command: null, raw: summary };
      }
      if (name === 'mcp_read_resource') {
        const r = await Mcp.readResource(a.server, a.uri);
        return { ok: true, content: r.text || '（资源没有文本内容）', command: null, raw: r };
      }
      const r = await Mcp.getPrompt(a.server, a.name, a.arguments);
      return { ok: true, content: r.text || '（prompt 没有文本消息）', command: null, raw: r };
    } catch (e) {
      return { ok: false, content: String((e && e.message) || e), command: null, code: (e && e.code) || 'MCP_ERROR' };
    }
  }

  if (String(name).startsWith('mcp__')) {
    const Mcp = require('./mcp-manager');
    try {
      const r = await Mcp.executePublicTool(name, args || {});
      return Object.assign({ command: null }, r);
    } catch (e) {
      return { ok: false, content: String((e && e.message) || e), command: null, code: (e && e.code) || 'MCP_TOOL_FAILED' };
    }
  }

  if (name === 'lsp') {
    const a = args || {};
    const Lsp = require('./lsp-manager');
    const op = String(a.operation || '').trim();
    const nav = op !== 'diagnostics';
    if (!Lsp || !op) return { ok: false, content: 'operation 不能为空', command: null, code: 'LSP_INVALID_ARGS' };
    if (nav && (!Number.isInteger(a.line) || a.line < 1 || !Number.isInteger(a.character) || a.character < 1)) {
      return { ok: false, content: '导航/悬停需要从 1 开始的 line 与 character', command: null, code: 'LSP_INVALID_ARGS' };
    }
    const ws = o.native && o.native.workspace;
    const workspaceRoot = String((ws && (ws.path || ws.root)) || '').trim();
    if (!workspaceRoot) {
      return { ok: false, content: 'LSP 需要当前会话工作区；请先打开一个工作区', command: null, code: 'LSP_WORKSPACE_REQUIRED' };
    }
    try {
      const r = await Lsp.query({
        operation: op,
        filePath: String(a.file_path || ''),
        workspaceRoot,
        position: nav ? { line: a.line - 1, character: a.character - 1 } : undefined,
      });
      return { ok: true, content: formatLspContent(r), command: null, code: null, raw: r };
    } catch (e) {
      return { ok: false, content: String((e && e.message) || e), command: null, code: (e && e.code) || 'LSP_ERROR' };
    }
  }

  if (name === 'terminal_start' || name === 'terminal_exec' || name === 'terminal_write'
    || name === 'terminal_read' || name === 'terminal_kill') {
    const Terminal = require('./terminal');
    const ownerKey = String(o.sessionId || 'agent');
    const a = args || {};
    try {
      if (name === 'terminal_start') {
        const snap = await Terminal.start({
          workspace: o.native && o.native.workspace,
          permission: o.native && o.native.permission,
          sandbox: o.native && o.native.sandbox,
          ownerKey, cwd: a.cwd, name: a.name, shell: a.shell,
        });
        return {
          ok: true,
          content: '终端已启动：' + snap.id + '（pty=' + (snap.pty ? 'true' : 'false') + '，cwd=' + snap.cwd + '\n'
            + 'pty 说明：' + snap.ptyReason
            + '\n沙箱：' + (snap.sandbox ? (snap.sandbox.backend + ' / ' + snap.sandbox.mode) : 'none')
            + '）\n用 terminal_exec 执行命令，id 可省略（默认最近一个）。',
          command: null, raw: snap,
        };
      }
      const session = Terminal.resolveSession(a.id, ownerKey);
      if (name === 'terminal_exec') {
        const signal = (o.native && o.native.signal) || o.signal || null;
        const r = await session.exec(a.command, { timeoutMs: a.timeoutMs, maxBytes: a.maxBytes, signal });
        const timedOut = r.waitReason === 'timeout';
        const aborted = r.waitReason === 'abort';
        const statusLine = 'exit=' + (r.exitCode == null ? '?' : r.exitCode)
          + ' · cwd=' + r.cwd + ' · ' + Math.round(r.durationMs / 1000) + 's'
          + (timedOut ? ' · 超时（已发送 Ctrl-C 停前台命令；用 terminal_read 继续看或 terminal_kill）' : '')
          + (aborted ? ' · 已取消（已发送 Ctrl-C 停前台命令）' : '')
          + (r.waitReason === 'session_exit' ? ' · 终端已退出' : '');
        return {
          ok: !timedOut && !aborted,
          code: timedOut ? TimeoutPolicy.TOOL_TIMEOUT : (aborted ? TimeoutPolicy.TOOL_ABORTED : undefined),
          content: statusLine + '\n' + (r.output || '（无输出）'),
          command: null, raw: Object.assign({ id: session.id }, r),
        };
      }
      if (name === 'terminal_write') {
        const r = session.write(a.text, { submit: a.submit !== false });
        return { ok: true, content: '已写入 ' + session.id + '（提交=' + r.submitted + '）', command: null, raw: Object.assign({ id: session.id }, r) };
      }
      if (name === 'terminal_read') {
        const r = session.read(a.since || 0, { limit: a.limit, maxBytes: a.maxBytes });
        return {
          ok: true,
          content: r.text || '（没有新输出）',
          command: null, raw: Object.assign({ id: session.id, status: session.status, cwd: r.cwd, exitCode: r.exitCode, seq: r.seq, pty: r.pty }, r),
        };
      }
      const r = await Terminal.kill(a.id || session.id, ownerKey, a.signal || 'SIGTERM');
      return {
        ok: true,
        content: '终端已结束：' + r.id + '（' + r.signal + '）'
          + (r.status && r.status.exitCode != null ? '，exit=' + r.status.exitCode : ''),
        command: null, raw: r,
      };
    } catch (e) {
      return { ok: false, content: String((e && e.message) || e), command: null, code: (e && e.code) || 'TERMINAL_FAILED' };
    }
  }

  if (name === 'session_query' || name === 'session_list' || name === 'session_read') {
    const Index = require('./session-index');
    if (name === 'session_list') {
      try {
        const r = Index.listSessions({ query: args && args.query, limit: (args && args.limit) || 20 });
        if (!r.sessions.length) return { ok: true, content: '（没有历史会话）', command: null, raw: r };
        const content = r.sessions.map((s) => '- ' + s.sessionId + ' · ' + s.title
          + '（' + s.messages + ' 条，' + (s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '-') + '）').join('\n');
        return { ok: true, content, command: null, raw: r };
      } catch (e) {
        return { ok: false, content: '会话列表失败：' + e.message, command: null, code: e.code || 'SESSION_LIST_FAILED' };
      }
    }
    if (name === 'session_read') {
      try {
        const r = Index.readSession(args && args.sessionId, { limit: (args && args.limit) || 20 });
        if (!r.ok) return { ok: false, content: r.error, command: null, code: 'NOT_FOUND' };
        const content = r.title + '（' + r.sessionId + ' · 显示最后 ' + r.messages.length + '/' + r.total + ' 条）\n'
          + r.messages.map((m) => '[' + m.role + '] ' + m.content).join('\n');
        return { ok: true, content, command: null, raw: r };
      } catch (e) {
        return { ok: false, content: '读取会话失败：' + e.message, command: null, code: e.code || 'SESSION_READ_FAILED' };
      }
    }
    const q = String((args && args.query) || '').trim();
    if (!q) return { ok: false, content: '缺少 query', command: null };
    try {
      const result = Index.search(q, { limit: (args && args.limit) || 8 });
      let hits = result.hits || [];
      if (args && args.scope === 'session' && o.sessionId) hits = hits.filter((h) => h.sessionId === String(o.sessionId));
      if (!hits.length) {
        return { ok: true, content: '没有找到与「' + q + '」匹配的历史原话。', command: null, raw: { query: q, hits: [], engine: result.engine } };
      }
      const content = '找到 ' + hits.length + ' 条（' + result.engine + '）：\n' + hits.map((h) => {
        const d = h.ts ? new Date(h.ts).toLocaleString('zh-CN', { hour12: false }) : '';
        return '- [' + h.sessionId + '] ' + (h.title ? h.title + ' · ' : '') + h.role + ' · ' + d + '\n  ' + h.snippet;
      }).join('\n');
      return { ok: true, content, command: null, raw: { query: q, hits, engine: result.engine } };
    } catch (e) {
      return { ok: false, content: '会话检索失败：' + e.message, command: null, code: e.code || 'SESSION_QUERY_FAILED' };
    }
  }

  return { ok: false, content: '未实现的本地工具：' + name, command: null };
}

/**
 * 把一个 tool_call 适配成 relay 指令 + 执行。
 * @param {object} call    {id, name, args}
 * @param {object} deps
 *   deps.dispatchTool(command, opts) async —— 通常是 (cmd) => relay._dispatchToPlugin(cmd, {via:'agent-loop'})
 *   deps.onTodo(list)       可选：todo_write 落盘 + 推 UI
 *   deps.askUser(questions) 可选：向用户提问并等待回答
 * @returns {Promise<{ok, content, command, raw}>}  content 是可回喂模型的字符串
 */
async function executeInner(call, deps) {
  const o = deps || {};
  const name = String((call && call.name) || '');
  const id = String((call && call.id) || ('agent_' + Date.now().toString(36)));
  if (!knows(name)) {
    return { ok: false, content: '未知工具：' + name + '。可用工具：' + Object.keys(ALL_SPECS).join('、'), command: null };
  }
  if (NATIVE_SPECS[name]) {
    const nr = await native.execute(name, call && call.args, o.native || {});
    return {
      ok: !!(nr && nr.ok), content: String((nr && nr.content) || ''),
      command: null, raw: (nr && nr.raw) || null, code: (nr && nr.code) || null,
    };
  }
  if (LOCAL_TOOLS.has(name)) return executeLocal(name, call && call.args, o);
  if (typeof o.dispatchTool !== 'function') {
    return { ok: false, content: '工具执行器未注入（dispatchTool 缺失）', command: null };
  }
  const spec = TOOL_SPECS[name];
  let params;
  try { params = spec.build(call && call.args); }
  catch (e) { return { ok: false, content: '工具参数非法：' + e.message, command: null }; }
  const command = { id, op: spec.op, params };
  try {
    const raw = await o.dispatchTool(command, { via: 'agent-loop', host: 'figma' });
    // 工具结果可能很大（scan_nodes 最多 200 节点）：截断到 12KB，足够模型判断又不撑爆上下文。
    let content = (raw && typeof raw === 'object') ? JSON.stringify(raw) : String(raw == null ? '' : raw);
    if (content.length > 12000) content = content.slice(0, 12000) + '\n…（结果过长已截断）';
    return { ok: true, content: content || '（工具已执行，无返回内容）', command, raw };
  } catch (e) {
    // 失败也回喂模型：让它知道工具失败并决定重试/改用别的方式，而不是让整个 turn 挂掉。
    return { ok: false, content: '工具执行失败：' + String((e && e.message) || e), command, error: e };
  }
}

/**
 * 对外唯一执行入口：所有工具结果先过契约。
 *
 * 内层保持旧返回形态（`{ok,content,command,raw}`），因为 Figma 分发与
 * 原生工具都按它写；仅在边界处补齐 `contentBlocks/evidence/error/meta`。
 * 这样 UI 不必知道是哪个工具、模型也不必看见结构字段。
 */
async function execute(call, deps) {
  const startedAt = Date.now();
  const name = String((call && call.name) || '');
  const callId = String((call && call.id) || '');
  const raw = await executeInner(call, deps);
  return Envelope.normalize(raw, { name, callId, startedAt, endedAt: Date.now() });
}

function riskOf(name) {
  const n = String(name || '');
  if (NATIVE_SPECS[n] && NATIVE_SPECS[n].risk) return NATIVE_SPECS[n].risk;
  if (TOOL_SPECS[n] && TOOL_SPECS[n].risk) return TOOL_SPECS[n].risk;
  // D3-02：MCP 动态工具只存在于 ALL_SPECS；漏这一层会把 readOnlyHint 全判成 write。
  if (ALL_SPECS[n] && ALL_SPECS[n].risk) return ALL_SPECS[n].risk;
  // Figma 读操作固定白名单；写操作只放 create_frame/create_text（当前 TOOL_SPECS 里其余全是读）。
  if (['get_document_info', 'list_pages', 'scan_nodes', 'audit_layout', 'audit_spacing', 'check_naming'].includes(n)) return 'read';
  return 'write';
}
function specOf(name) { return ALL_SPECS[String(name || '')] || null; }

module.exports = {
  definitions, knows, execute, executeLocal,
  TOOL_SPECS, NATIVE_SPECS, ALL_SPECS, LOCAL_TOOLS, riskOf, specOf,
};
