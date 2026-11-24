/**
 * Genie 路径单一入口
 * 所有文件路径必须从这里导入，禁止在业务代码中写死 path.join(cwd, 'xxx')
 * 新增数据目录时，必须在此注册
 */
const path = require('path');

// ── 代码根 与 数据根 是两件事（2026-11-21，Electron 接入）───────────────
//
// 现场：Genie-Electron.app 把整份载荷（src + brain）放在 .app 里当工作目录，
// 于是「设置不保存、PRD 0 项目、知识库 0 节点」——因为读的是 App 内部那份空 brain。
//
// 结论：**代码可以只读地待在 App 里，数据必须待在用户目录**（macOS 惯例，也是
// Swift 版一直在做的事：载荷装到 ~/Library/Application Support/Genie）。
// `GENIE_DATA_ROOT` 只重定向「会写」的东西（brain / config / temp / ota），
// 代码与二进制资产（src / assets / models / capabilities）仍留在 ROOT。
//
// 不设这个变量时 DATA === ROOT，开发态与所有既有测试行为**完全不变**。
const ROOT = process.env.GENIE_ROOT || path.join(__dirname, '..', '..');
const DATA = process.env.GENIE_DATA_ROOT || ROOT;

// 交付物根目录：deliver.js（xlsx/pptx 导出）与 wps-doc.js（docx 写稿）共用一份，
// 避免两处各自 path.join(brain, 'deliverables') 漂移；测试靠 GENIE_DELIVERABLES_DIR 隔离。
const brainDeliverables = process.env.GENIE_DELIVERABLES_DIR || path.join(DATA, 'brain', 'deliverables');

const paths = {
  root: ROOT,            // 代码根：src / assets / models / capabilities 所在
  dataRoot: DATA,        // 数据根：brain / config / temp / ota 所在（不设 GENIE_DATA_ROOT 时等于 root）

  // ===== 大脑（唯一知识中心）=====
  brain: path.join(DATA, 'brain'),
  brainCore: path.join(DATA, 'brain', 'core'),
  brainDraw: path.join(DATA, 'brain', 'draw'),
  brainMeta: path.join(DATA, 'brain', 'meta'),
  brainLearning: path.join(DATA, 'brain', 'learning'),
  brainPrdLib: path.join(DATA, 'brain', 'prd'),
  brainVision: path.join(DATA, 'brain', 'vision-training'),
  // v3.3 本地视觉笔录记忆库（imgHash 去重，RAG 第9源 fetchVisionMemory）
  brainVisionMemory: path.join(DATA, 'brain', 'vision'),
  brainDesignSystems: path.join(DATA, 'brain', 'design-systems'),
  componentIndex: path.join(DATA, 'brain', 'component-index.json'),

  // ===== 自进化系统（P0-P22）=====
  // GENIE_RULES_FILE 是**测试与影子实例的隔离开关**，必须在这里生效。
  // 之前只有 evolve-shadow 认这个变量，rules-engine 仍读真实 brain/core/rules.json，
  // 于是所有"隔离跑"的用例其实在改用户真实规则库（σ-10 的 before 恒等于真实条数）。
  brainRules: process.env.GENIE_RULES_FILE || path.join(DATA, 'brain', 'core', 'rules.json'),
  // ===== 记忆查询入口（2026-11-16）=====
  // 用户问「我记住了你什么」，之前整个项目**没有一个地方能回答**：库里有 248 条教训，
  // 用户看不到、也删不掉。这三条路径是那个入口的唯一真源。
  //
  // ⚠️ lessons 有两份：`brain/learning/lessons.jsonl`（在写，248 行）与
  // `brain/lessons.jsonl`（2KB，10-10 之后没动过，已被取代）。代码里
  // reasoning-engine 的注释还写着后者，但它的实际代码读的是 brainLearning ——
  // **注释过期了，不要按注释走**。
  brainLessons: process.env.GENIE_LESSONS_FILE || path.join(DATA, 'brain', 'learning', 'lessons.jsonl'),
  brainCanon: process.env.GENIE_CANON_FILE || path.join(DATA, 'brain', 'learning', 'canon.jsonl'),
  brainPreferencesJsonl: process.env.GENIE_PREFS_FILE || path.join(DATA, 'brain', 'learning', 'preferences.jsonl'),
  brainCorePrompts: path.join(DATA, 'brain', 'core', 'prompts'),
  brainDrafts: path.join(DATA, 'brain', 'learning', 'draft'),
  brainLearningDraft: path.join(DATA, 'brain', 'learning', 'draft'),
  pendingThinking: path.join(DATA, 'brain', 'meta', 'pending-thinking'),
  brainKnowledgeGraph: path.join(DATA, 'brain', 'core', 'knowledge-graph'),
  brainEvolutionLog: path.join(DATA, 'brain', 'learning', 'evolution-log.jsonl'),
  brainGoals: path.join(DATA, 'brain', 'meta', 'goals.json'),
  // 交付物登记册（2026-11-12）：生成的 docx/xlsx/pptx 的统一目录，
  // 解决「AI 交付了东西却没有任何地方承认它交付过」——用户滚两屏就找不到文件。
  brainArtifacts: process.env.GENIE_ARTIFACTS_FILE || path.join(DATA, 'brain', 'meta', 'artifacts.json'),
  // 交付物落地盘（2026-11-12 二次修订）：**绝不能再放 temp/**。
  // 现场：docx 落 temp/prd<日期>/，而「清理缓存」的动作就是 rm -rf temp/*，
  // 用户点一下按钮，所有生成过的 PRD 全没了；实测 -11-04/-09/-10 三个目录全是空的。
  // 交付物属于知识产出，归 brain；temp 只放截图、浏览器 profile、日志这类可再生数据。
  brainDeliverables,
  brainDeliverablesDocs: path.join(brainDeliverables, 'docs'),
  brainInternalState: path.join(DATA, 'brain', 'meta', 'internal-state.json'),
  brainDiscussions: path.join(DATA, 'brain', 'learning', 'discussions.jsonl'),
  brainStuckPoints: path.join(DATA, 'brain', 'meta', 'stuck-points.jsonl'),
  brainDomains: path.join(DATA, 'brain', 'meta', 'domains.json'),
  brainArchiveIndex: path.join(DATA, 'brain', 'core', 'archive-index.json'),
  brainSharedKnowledge: path.join(DATA, 'brain', 'shared-knowledge'),

  // ===== PRD 录入任务（M1：项目隔离 + 异步入库 + 状态追踪）=====
  brainPrdIngestTasks: path.join(DATA, 'brain', 'meta', 'prd-ingest-tasks.json'),

  // ===== M1 私有记忆体系（五层：L0工作/L1情景/L2语义/L3程序/L4偏好）=====
  // 统一容器目录，经 docs/06-app-governance.md 登记。每层一个文件：
  //   l0-working.json（内存态快照，小而快）/ l1-episodic.jsonl（情景事件流）
  //   l2-semantic.json（提炼后的事实与规则）/ l3-procedural.json（技能与工作流）
  //   l4-preferences.json（关于用户的偏好画像）
  brainPrivateMemory: path.join(DATA, 'brain', 'private-memory'),

  // ===== 案例库（阶段①：设计/练习产出结构化沉淀，统一入口 src/lib/case-library.js）=====
  brainCases: path.join(DATA, 'brain', 'cases'),

  // ===== 参考素材（人读版）=====
  references: path.join(DATA, 'references'),
  refsImages: path.join(DATA, 'references', 'images'),
  refsPrd: path.join(DATA, 'references', 'prd'),
  refsIcons: path.join(DATA, 'references', 'icons'),

  // ===== 运行时状态 =====
  ota: path.join(DATA, 'ota'),
  otaInbox: path.join(DATA, 'ota', 'inbox.jsonl'),
  otaOutbox: path.join(DATA, 'ota', 'outbox.jsonl'),
  otaFeedback: path.join(DATA, 'ota', 'feedback.jsonl'),
  otaLastProcessed: path.join(DATA, 'ota', 'last-processed.txt'),
  otaPostdraw: path.join(DATA, 'ota', 'ai-postdraw-last.json'),

  // ===== 临时文件（可随时清空）=====
  temp: path.join(DATA, 'temp'),
  tempScreenshots: path.join(DATA, 'temp', 'screenshots'),
  tempBrowser: path.join(DATA, 'temp', 'browser-profile'),
  tempArchive: path.join(DATA, 'temp', 'archive'),

  // ===== 能力资产分层（2026-11-20，参照 WorkBuddy binaries/.cache/registry.json）=====
  // L3 按需能力包的运行时注册表在这里生成；静态清单在 assets/capabilities.json。
  capabilities: path.join(ROOT, 'capabilities'),
  capabilitiesRegistry: path.join(ROOT, 'capabilities', 'registry.json'),
  capabilitiesLocks: path.join(ROOT, 'capabilities', '.locks'),
  capabilitiesManifest: path.join(ROOT, 'assets', 'capabilities.json'),

  // ===== 内嵌真实资产（2026-11-20，用户要求三项生态随 Genie 源码树一起走）=====
  // 全部是工程真源里的实体文件，不是软链、不是按需下载。换机拷 Genie 目录即可用。
  // 打包态由载荷脚本按相同相对落点复制到数据目录根，定位统一走 src/lib/embedded-assets.js。
  assets: path.join(ROOT, 'assets'),
  embeddedPython: path.join(ROOT, 'assets', 'python', 'runtime', 'bin', 'python3'),
  embeddedPythonPackages: path.join(ROOT, 'assets', 'python', 'site-packages'),
  embeddedPdftools: path.join(ROOT, 'assets', 'pdftools'),
  embeddedPdfExtractSource: path.join(ROOT, 'assets', 'pdftools', 'pdf-extract.py'),
  embeddedPdf2docxSource: path.join(ROOT, 'assets', 'pdftools', 'pdf2docx_convert.py'),
  embeddedOllamaBin: path.join(ROOT, 'assets', 'ollama', 'bin', 'ollama'),
  embeddedOllamaLib: path.join(ROOT, 'assets', 'ollama', 'lib'),
  embeddedModels: path.join(ROOT, 'models', 'ollama'),
  // ===== 配置/密钥 =====
  config: path.join(DATA, 'config'),
};

// ── 全新安装的目录骨架（2026-11-19，S1）──────────────────────────────────
// 为什么需要这一步：开发机上 brain/ 早已被历史数据填满，
// 所以「第一次安装到空目录」这条路从来没被走过。打包后实测第一次启动直接死在
//   src/lib/experience-loop.js: fs.writeFileSync(brain/learning/lessons.jsonl)
// —— 父目录不存在，ENOENT，中继没起来，用户看到的仍然是「中继未连接」。
// 与其在每个写入点各补一句 mkdir（55 处，补不全），不如在启动前一次性建好骨架。
// mkdir recursive 幂等，代价约 1ms，放在中继启动路径上是值得的。
const DIR_KEYS = [
  'brain', 'brainCore', 'brainDraw', 'brainMeta', 'brainLearning', 'brainPrdLib',
  'brainVision', 'brainVisionMemory', 'brainDesignSystems', 'brainCases',
  'brainSharedKnowledge', 'brainPrivateMemory', 'brainCorePrompts', 'brainDrafts',
  'pendingThinking', 'brainKnowledgeGraph', 'temp', 'tempScreenshots',
  'tempBrowser', 'tempArchive', 'ota', 'config', 'references',
  'refsImages', 'refsPrd', 'refsIcons', 'capabilities', 'capabilitiesLocks',
];

function ensureDirs() {
  const fs = require('fs');
  const created = [];
  for (const key of DIR_KEYS) {
    const dir = paths[key];
    if (!dir) continue;
    try {
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); created.push(dir); }
    } catch (e) {
      // 建不出来不该让中继起不来：交给真正用到它的模块去报更具体的错
      console.error('[paths] 无法创建目录 ' + dir + '：' + e.message);
    }
  }
  return created;
}

// ── P2-1: 路径硬校验（防漂移护栏）──
function assertSafePath(absPath) {
  if (!absPath || typeof absPath !== 'string') {
    throw new Error('安全违规：路径为空或不是字符串');
  }
  const inCode = absPath.startsWith(ROOT);
  const inData = absPath.startsWith(DATA);
  if (!inCode && !inData) {
    throw new Error('安全违规：路径在Genie目录外: ' + absPath);
  }
  return absPath;
}

module.exports = paths;
module.exports.assertSafePath = assertSafePath;
module.exports.ensureDirs = ensureDirs;
module.exports.DIR_KEYS = DIR_KEYS;
