/**
 * @dsh-external/dsh-liubian —— 流变系统 DSH 移植版（实现主体）
 * 单文件实现：入口壳 main.mjs 用 `?t=<时间戳>` 动态导入本文件，单文件 =
 * 单个 URL = 整张依赖图一次刷新，改完代码热注入即生效（不用重启 DSH）。
 * 结构对照 @openviking/dsh-memory-plugin（DSH 的记忆插件）：
 *   它 = MCP 代理 + 技能提供方 + 生命周期钩子，把 OpenViking 接进 DSH；
 *   本插件 = 原生工具面 + 技能落盘，把 Codex 侧的流变系统接进 DSH。
 * 差别在于流变系统的后端是一组 Python CLI（memory.py / liubian.py / 通路二），
 * 不是常驻服务，所以不需要 MCP 代理这一跳。
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineTool } from '@deepseek-ai/dsh-tools'

/* ──────────────────────────────────────────────────────────────────────────
 * 1. 路径与身份（对应 DSH 记忆插件的 config.mjs / shared/credentials.mjs）
 * ────────────────────────────────────────────────────────────────────────── */

const HOME = process.env.USERPROFILE || process.env.HOME || 'C:/Users/Feng'

/** 版本号（同时写进挂载日志，方便确认热注入拿到的是新代码而不是 ESM 缓存里的旧模块）。 */
export const PLUGIN_VERSION = '1.0.0'

/** DSH 家目录（身份文件落在这里，与 Codex 侧凭据互不干扰）。 */
export const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh')

/** Codex 侧技能根目录（记忆系统 / 流变系统的源码与数据都在那边）。 */
export const CODEX_SKILLS = join(HOME, '.codex', 'skills')

const MEMORY_SKILL = join(CODEX_SKILLS, 'memory-skill')
const LIUBIAN_SKILL = join(CODEX_SKILLS, 'liubian')

/** 全部默认值。可被 <DSH_HOME>/liubian/config.json 或宿主传入的 config 覆盖。 */
export const DEFAULTS = {
  python: 'E:/python/python.exe',
  memoryScript: join(MEMORY_SKILL, 'scripts', 'memory.py'),
  semanticScripts: join(MEMORY_SKILL, 'scripts'),
  path2Script: join(LIUBIAN_SKILL, 'scripts', '通路2', 'liubian_path2.py'),
  liubianCli: join(LIUBIAN_SKILL, 'scripts', 'liubian.py'),
  panelExe: join(LIUBIAN_SKILL, 'dist', 'liubian_panel.exe'),
  panelPy: join(LIUBIAN_SKILL, 'scripts', 'liubian_panel_qt.py'),
  codexSkills: CODEX_SKILLS,
  liubianRoot: 'E:/DSH_data',
  registryDir: 'E:/DSH_data/.memory_registry',
  workspace: '工作组',
  installSkills: true,
  // ── DSH 侧身份策略：不需要用户管密码/KEY ──
  // 写日记走匿名（memory.py 的 write 在无 -u 时完全不鉴权，也不受工作区归属限制）。
  // 检索走 helper 的直连 DB 读取（无需身份）。
  // 向量服务的配置与生命周期已拆到独立插件 dsh-liubian-embed
  timeoutMs: 180000,
  // ── 上下文插入（对照 @openviking/dsh-memory-plugin） ──
  profileInject: true,
  profileTokenBudget: 700,
  memoryMinChars: 8,         // 查询文本短于这个就不检索（太低会把"嗯""好的"也拿去搜）
  // ── 联合检索注入（tag 一路 + 语义一路，融合后注入前 N 篇全文）──
  // 用户规格：查询 = 最新轮用户问题 + 上一轮回答；
  //   ① 语义一路：拼成一段文本嵌入 → 与库里日记向量算余弦；
  //   ② tag 一路：同一段文本 + 标签候选表送外部 API → 模型挑 5 个 tag → 字面检索；
  //   ③ 融合取综合得分最高的 N 篇，**注入全文**。
  // 用户规格（2026-09-13）：两级检索 ——
  //   ① 联合检索（tag+语义融合）取前 memorySeedTop 篇作**主线**；
  //   ② 用主线各自的向量各找回 memoryRelatedPerSeed 篇**关联**日记（第二跳）；
  //   ③ 主线 + 关联合并，总篇数封顶 memoryTopN，**一起注入全文**。
  memoryInject: true,        // 关掉 = 本轮不注入记忆（旧的"只注入检索摘要"已整体删除，没有回退路径）
  memoryScope: 'global',     // 'global' = 跨全部工作区检索（推荐）｜'workspace' = 只查当前工作区
  memoryTopN: 30,            // 总注入篇数上限（主线 + 关联）
  memorySeedTop: 5,          // 第一跳取前几篇作主线
  memoryRelatedPerSeed: 5,   // 每条主线找回几篇关联（第二跳）
  memoryWTags: 0.5,          // 融合权重：tag 一路占多少（其余给语义）
  memoryQueryChars: 6000,    // 查询文本上限（用户问题 + 上一轮回答）
  memoryContentChars: 3000,  // 单篇注入正文上限（超长截断）
  memoryTotalChars: 60000,   // 整块注入上限（30 篇全文，防一次吃掉太多上下文）
  // ── 全局通用教训（每次会话开始注入；跨领域通用，不含特定领域内容）──
  lessonsInject: true,       // 关掉 = 会话开始不注入教训块
  lessonsMax: 20,            // 最多注入几条
  lessonsChars: 2400,        // 教训块总字符上限
  lessonsEveryTurns: 10,     // 每 N 轮重注一次教训块（0 = 只在会话开始注一次）
  // ── 技能自动装载：语义命中超阈值 → 直接注入 SKILL.md 全文并建议使用 ──
  skillAutoLoad: true,       // 总开关
  skillAutoLoadThreshold: 0.6,  // 语义相似度阈值（skillHitsFor 返回的 score）
  skillAutoLoadMax: 1,       // 每轮最多自动注入几个技能（防上下文膨胀）
  skillAutoLoadChars: 8000,  // 单个技能正文注入上限（超长截断）
  // ── 能力卡：已装插件/MCP 的"什么时候用什么"清单，会话开始 + 每 N 轮提醒 ──
  capabilitiesInject: true,  // 总开关
  profileDir: 'C:/Users/Feng/.dsh/profiles/desktop',  // profile 目录（自动发现已装插件/MCP 用）
  // ── 反反驳自查提醒：每一轮对话都注入（一次一轮，不做内容去重）──
  turnReminderInject: true,
  turnReminderText: '如果你打算反驳用户，那就先看看你自己的结论有没有证据支持、证据充不充分，不要为了反驳而反驳。',
  memoryTagTopN: 5,          // 让模型挑几个 tag
  memorySkillTopN: 3,        // 每轮注入几个**命中的技能**（只给名字+摘要，不给全文）
  memorySkillTimeoutMs: 30000,
  memoryTagHints: 100,       // 送给模型的标签候选个数（写日记同款：语义选前 N）
  memoryTimeoutMs: 120000,   // 本地向量 + helper 的超时（helper 首次要读 6114 篇向量，给足）
  // ── 检索侧外部 API（与写日记**分开的 key**）──
  // 用途只有一处：联合检索里"让模型从候选标签里挑 N 个 tag"那一次调用（screenQueryTags）。
  // 用户 2026-09-12 要求检索走另一把 key（基址同 DeepSeek）。留空则回退用写日记那把 key。
  memoryApiKey: '',
  memoryApiUrl: 'https://api.deepseek.com/chat/completions',
  memoryApiModel: 'deepseek-flash',
  memoryApiTimeoutMs: 60000,
  memoryApiJsonMode: true,
  // ── 自动日记（外部 API 撰写，下一轮写上一轮）──
  // 开关与 key 放在独立文件 ~/.dsh/liubian/diary.json，避免和主配置混在一起
  diaryMaxChars: 500,        // 每篇日记正文上限（字）；一轮要写几篇由内容决定，不设上限
  diaryMaxInputChars: 12000, // 送 API 的上一轮对话上限（超出按需截断并标注；不含标签表）
  diaryTagHints: 0,          // 0 = 全量标签表；>0 = 只取前 N 个字符（防超长端点）
  diaryTagSelect: 'semantic',// 'semantic'=助手正文向量 → 标签向量余弦取前 N｜'all'=整张表｜'none'=不给
  diaryTagTopN: 100,         // semantic 模式取前几个标签
  diaryTagEmbedUrl: 'http://127.0.0.1:8082/v1/embeddings',
  diaryTagEmbedModel: 'qwen3-emb',
  diaryTagEmbedDim: 1024,
  diaryTagEmbedBatch: 32,    // 建缓存时每批多少个标签（一次性，约 1~2 分钟）
  diaryIncludeTools: true,   // 是否把工具轨迹（工具名）写进输入
  diaryWorkspace: 'auto',    // 'auto' = 按会话 cwd 推导；也可写死工作区名
  diaryRetryLimit: 5,        // 单条 pending 最多重试次数
  diaryTimeoutMs: 120000,
}

export function configFile() {
  return join(DSH_HOME, 'liubian', 'config.json')
}

function readJson(file) {
  try {
    // 去掉 BOM：记事本 / Windows PowerShell 的 UTF8 都会带 BOM，
    // 直接 JSON.parse 会抛错，配置文件就被静默忽略了。
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

/**
 * 兜底合并：即使宿主没传 schema 默认值，也保证每个键都有值，
 * 并把「字符串形式的布尔/数字」（配置文件常见）纠偏成真类型。
 */
export function resolveConfig(input = {}) {
  const merged = { ...DEFAULTS, ...readJson(configFile()) }
  const src = input && typeof input === 'object' ? input : {}
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined || v === null || v === '') continue
    merged[k] = v
  }
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = merged[k]
    if (typeof def === 'boolean' && typeof v === 'string') merged[k] = v.trim().toLowerCase() !== 'false'
    if (typeof def === 'number' && typeof v === 'string' && v.trim() !== '') {
      const n = Number(v)
      if (Number.isFinite(n)) merged[k] = n
    }
  }
  return merged
}

/** 注册表 SQLite 路径。 */
export function registryDb(cfg) {
  return join(cfg.registryDir, 'liubian.db')
}

/* ──────────────────────────────────────────────────────────────────────────
 * 2. 子进程桥 —— 把 Codex 侧已跑通的 Python 实现原样接进来
 *    （Codex 侧等价物是 mcp/_common.py 里的 subprocess.run）
 * ────────────────────────────────────────────────────────────────────────── */

/** 插件自带 python helper 目录（读注册表 / 技能文档索引）。 */
const HELPER_DIR = fileURLToPath(new URL('../helper/', import.meta.url))

/**
 * memory.py 用 `Path.cwd().name` 判定当前工作区，所以必须显式指定 cwd。
 * 工作区目录不存在时退回工作区根目录，避免 cwd 指向不存在的路径。
 */
export function workspaceDir(cfg, workspace) {
  const ws = String(workspace || cfg.workspace || '').trim()
  if (ws) {
    const dir = join(cfg.liubianRoot, ws)
    if (existsSync(dir)) return dir
  }
  return cfg.liubianRoot
}

function decode(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  try {
    return value.toString('utf8')
  } catch {
    return ''
  }
}

/** 把子进程失败折算成模型能读懂的文本（优先 stdout —— python 侧错误都打在 stdout）。 */
function describeFailure(err) {
  const stdout = decode(err && err.stdout).trim()
  const stderr = decode(err && err.stderr).trim()
  const parts = []
  if (stdout) parts.push(stdout)
  if (stderr) parts.push('[stderr] ' + stderr)
  if (parts.length === 0) {
    if (err && err.killed) parts.push('[错误] 子进程超时被终止')
    else if (err && err.code === 'ENOENT') parts.push('[错误] 找不到可执行文件或脚本：' + (err.path || '?'))
    else parts.push('[错误] ' + ((err && err.message) || String(err)))
  }
  return parts.join('\n')
}

function baseEnv(extra) {
  return { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...(extra || {}) }
}

/**
 * 同步跑一个 python 脚本。
 * stdio 显式设成 ['ignore','pipe','pipe']：不把 stdin 接管道，
 * 免得 python 侧任何 stdin 探测把调用挂住（Codex 侧用 stdin=DEVNULL，同源）。
 */
export function runPython(cfg, script, args, opts = {}) {
  try {
    const out = execFileSync(cfg.python, [script, ...args], {
      cwd: opts.cwd || cfg.liubianRoot,
      timeout: opts.timeoutMs || cfg.timeoutMs,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: baseEnv(opts.env),
    })
    return (out || '').trim() || '(无输出)'
  } catch (err) {
    return describeFailure(err)
  }
}

/**
 * 异步版：面板 / 嵌入服务等子进程用。同步的 execFileSync 会把 DSH 宿主
 * （Electron 主进程）事件循环卡住，所以监听链路一律走这里。
 */
function runPythonAsync(cfg, script, args, opts = {}) {
  return new Promise(resolve => {
    const child = execFile(cfg.python, [script, ...args], {
      cwd: opts.cwd || cfg.liubianRoot,
      timeout: opts.timeoutMs || cfg.timeoutMs,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      env: baseEnv(opts.env),
    }, (err, stdout) => {
      if (err) resolve(describeFailure(err))
      else resolve((stdout || '').trim() || '(无输出)')
    })
    // ⚠️ execFile 默认给子进程一个打开着的 stdin 管道。不写不关的话，
    // 子进程（如 helper 里的 sys.stdin.buffer.read()）会一直等输入 → 直到超时。
    // 有 payload 就写进去并关掉；没有就立刻关掉，让子进程的 read() 立刻返回空。
    if (child.stdin) {
      try {
        if (typeof opts.stdin === 'string') child.stdin.end(opts.stdin, 'utf8')
        else child.stdin.end()
      } catch { /* 忽略 */ }
    }
  })
}

/** 透传 memory.py（记忆 / 更新 的全部子命令）。 */
export function runMemory(cfg, args, opts = {}) {
  return runPython(cfg, cfg.memoryScript, args, {
    ...opts,
    cwd: opts.cwd || workspaceDir(cfg, opts.workspace),
  })
}

export function runMemoryAsync(cfg, args, opts = {}) {
  return runPythonAsync(cfg, cfg.memoryScript, args, {
    ...opts,
    cwd: opts.cwd || workspaceDir(cfg, opts.workspace),
  })
}

function helperEnv(cfg, extra) {
  return {
    LU_DB: registryDb(cfg),
    LU_ROOM_DIR: join(cfg.registryDir, 'kotatsu_rooms'),
    ...(extra || {}),
  }
}

/** 跑插件自带 helper（helper/<name>.py）。 */
export function runHelper(cfg, name, args, opts = {}) {
  return runPython(cfg, join(HELPER_DIR, name + '.py'), args, { ...opts, env: helperEnv(cfg, opts.env) })
}

export function runHelperAsync(cfg, name, args, opts = {}) {
  return runPythonAsync(cfg, join(HELPER_DIR, name + '.py'), args, { ...opts, env: helperEnv(cfg, opts.env) })
}

/** 通路二：无上下文双 API（初始回答 + 五维校验）。 */
export function runPath2(cfg, question, outPath) {
  const args = [question]
  if (outPath) args.push('--out', outPath)
  return runPython(cfg, cfg.path2Script, args, { timeoutMs: 300000 })
}

/** 流变统一 CLI（status / 旧命令透传）。 */
export function runLiubianCli(cfg, args, opts = {}) {
  return runPython(cfg, cfg.liubianCli, args, { cwd: workspaceDir(cfg, opts.workspace), ...opts })
}

/** 无窗口后台启动（面板 / 嵌入服务），不阻塞主对话。 */
export function launchDetached(cmd, args, cwd) {
  try {
    // ⚠️ 不要加 detached: true —— 它会被 Node 升级成 CREATE_NEW_CONSOLE，
    //    控制台窗口会**真的弹出来**（2026-09-12 实测：向量服务的 llama-server
    //    就是这么被拉起来的，窗口枚举里一直是 VISIBLE）。
    //    stdio:'ignore' + windowsHide 已经是「无窗后台」，足够用。
    const child = spawn(cmd, args, {
      cwd: cwd && existsSync(cwd) ? cwd : undefined,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return '已启动'
  } catch (err) {
    return '[错误] ' + ((err && err.message) || String(err))
  }
}

/**
 * Windows 命令行上限约 32KB，日记正文很容易超。
 * 超长正文改走 memory.py 的 --file 通道（临时文件，用完即删），
 * 这是相对 Codex ?MCP 封装的一处加固 */
export function withTempPayload(text, fn) {
  if (Buffer.byteLength(text, 'utf8') < 20000) return fn(null)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-liubian-'))
  const file = join(dir, 'payload.txt')
  try {
    writeFileSync(file, text, 'utf8')
    return fn(file)
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 3. 工具面 —— 覆盖 Codex 侧 MCP 服务器的能力
 *    mcp-memory-core / write / search / validate / panel / update / skill-index，
 *    外加 liubian.py status。
 *    （向量服务已拆出去，见独立插件 dsh-liubian-embed）
 * ────────────────────────────────────────────────────────────────────────── */

export const TOOL_PREFIX = '_dsh_external_dsh_liubian_'

/** 所有工具的统一输出契约：一个字符串，渲染成单个 text 块。 */
const OUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

const ARG_WORKSPACE = { type: 'string', description: '工作区名，如 工作组 / 银砂纪年（默认取插件配置）' }

/** 插件日志器（apply 时注入），让自动注册这类副作用在日志里可见。 */
let activeLogger = null

function register(ctx, def) {
  // 注意：name / output 必须放在展开之后 —— def 自身带 name 字段，
  // 写成 { name: PREFIX + def.name, output: OUT, ...def } 会被 def.name 覆盖。
  // 工具就会以裸名（write / read / search…）注册，撞上 DSH 内置工具并被遮蔽。
  ctx.effect(
    () => ctx.tools.register(defineTool({ ...def, name: TOOL_PREFIX + def.name, output: OUT })),
    `${TOOL_PREFIX}${def.name}`,
  )
}

export function registerTools(ctx, cfg) {
  /* - 流变·记忆：写日记（mcp-memory-write?------------------------------------------------------------ */
  register(ctx, {
    name: 'write',
    description: '写一篇流变记忆日记（每轮对话结束记录要点）。**匿名写入**，不需要任何身份 / 密码 / KEY。'
      + 'tags 至少 5 个细小标签；返回 [OK] Dxxxx',
    parameters: {
      tags: { type: 'string', required: true, description: '标签，逗号分隔，至少 5 个；细小标签优先于宽泛词（"记忆skill-标签优化"优于"经验"）' },
      summary: { type: 'string', required: true, description: '句话摘要' },
      content: { type: 'string', required: true, description: '正文（覆盖本轮对话要点；超 20KB 自动改走临时文件通道，不受命令行长度限制' },
      kind: { type: 'string', enum: ['diary', 'log'], description: 'diary=日常日记（默认）；log=工作流/实践日志' },
      workspace: ARG_WORKSPACE,
    },
    async execute(args) {
      const tags = String(args.tags || '')
      const tagCount = tags.split(',').filter(t => t.trim()).length
      if (tagCount < 5) return `[错误] 写日记需要至少 5 个标签（当前 ${tagCount} 个）。`
      const content = String(args.content || '')
      return withTempPayload(content, file => {
        // 关键：**不带 -u**。memory.py 的 write 整段被 `if username:` 包着，
        // 不带 username 时完全不鉴权，也不校验工作区归属 —— DSH 侧写日记因此零身份。
        const argv = ['write', '-t', tags, '-s', String(args.summary || '')]
        if (file) argv.push('--file', file)
        else argv.push('--content', content)
        if (String(args.kind || 'diary') === 'log') argv.push('-k', 'log')
        return runMemory(cfg, argv, { workspace: args.workspace })
      })
    },
  })

  /* - 流变·记忆：检索（mcp-memory-search?------------------------------------------------------------ */
  register(ctx, {
    name: 'search',
    description: '显式检索记忆（两级配方，与自动注入同源）：tag + 语义融合取前 5 篇主线，'
      + '再沿主线各扩 5 篇关联，至多 30 篇。返回**摘要列表**保证广度，'
      + '看中哪篇用 _dsh_external_dsh_liubian_read Dxxxx@工作区 取全文。tags 至少 4 个。无需身份。',
    parameters: {
      tags: { type: 'string', required: true, description: '检索标签，逗号分隔，至少 4 个（与日记标签一致；语义路会兜底相近内容）' },
      query: { type: 'string', description: '可选：自由文本，增强语义一路（默认用 tags 拼接）' },
      workspace: ARG_WORKSPACE,
    },
    async execute(args) {
      const tags = String(args.tags || '').split(',').map(t => t.trim()).filter(Boolean)
      if (tags.length < 4) return `[错误] 检索需要至少 4 个标签（当前 ${tags.length} 个）。`
      const scope = String(args.workspace || '').trim()
      const query = String(args.query || '').trim() || tags.join(' ')
      const vec = await queryEmbedding(cfg, query)
      const ranked = await jointQuery(cfg, { workspace: scope, tags, vec, top: 50, full: false, mode: 'rank' })
      if (!ranked || !ranked.ok) return `[错误] 检索失败：${ranked.error || '未知'}`
      const seedTop = Math.max(1, Number(cfg.memorySeedTop) || 5)
      const perSeed = Math.max(1, Number(cfg.memoryRelatedPerSeed) || 5)
      const seeds = (ranked.results || []).slice(0, seedTop)
      if (!seeds.length) return '[无命中] 没有检索到匹配的日记。'
      // 第二跳：沿主线向量找关联（失败只退回主线）
      const seen = new Set(seeds.map(r => `${r.ws}#${r.id}`))
      const related = []
      const rel = await jointQuery(cfg, {
        workspace: scope, mode: 'related', top: perSeed, full: false,
        seeds: seeds.map(r => `${r.ws}|${r.id}`),
      })
      if (rel && rel.ok && rel.related) {
        for (const s of seeds) {
          for (const r of (rel.related[`${s.ws}|${s.id}`] || [])) {
            const k = `${r.ws}#${r.id}`
            if (seen.has(k)) continue
            seen.add(k)
            related.push({ ws: r.ws, id: r.id, sem: Number(r.sem) || 0 })
          }
        }
      }
      const winners = [
        ...seeds.map(r => ({ ...r, hop: '主线' })),
        ...related.map(r => ({ ...r, hop: '关联' })),
      ]
      // 只回摘要（广度优先），全文按需 read
      const detail = await jointQuery(cfg, {
        workspace: scope, mode: 'ids', top: winners.length, full: true,
        ids: winners.map(r => `${r.ws}|${r.id}`),
      })
      const got = new Map(((detail && detail.results) || []).map(r => [`${r.ws}#${r.id}`, r]))
      const skillHits = await skillHitsFor(cfg, query)
      const lines = winners.map((w, i) => {
        const d = got.get(`${w.ws}#${w.id}`) || {}
        const sum = clipText(String(d.summary || '').trim() || String(d.content || '').trim().slice(0, 120), 120) || '(无摘要)'
        const tagTxt = w.hop === '主线' ? `综合${Number(w.score).toFixed(2)}` : `关联·语义${Number(w.sem || 0).toFixed(2)}`
        return `${i + 1}. 【${w.hop}】${w.id}@${w.ws}（${tagTxt}）${sum}`
      })
      const skillLines = skillHits.length
        ? ['', '[技能命中] ' + skillHits.map(h => `${h.skill}(${h.score.toFixed(2)})`).join('、')
          + '——需要细节去 ~/.codex/skills 或 ~/.dsh/skills 读对应技能的 SKILL.md。']
        : []
      return [
        `[OK] 两级检索命中 ${winners.length} 篇（主线 ${seeds.length} + 关联 ${winners.length - seeds.length}），已按相关度排序返回摘要。`,
        '看中哪篇用 _dsh_external_dsh_liubian_read Dxxxx@工作区 取全文。',
        '',
        ...lines,
        ...skillLines,
      ].join('\n')
    },
  })

  register(ctx, {
    name: 'read',
    description: '读取记忆日记正文。diary_ids 支持 D0932 或 D0932@工作区（带工作区精确读取）。',
    parameters: {
      diary_ids: { type: 'string', required: true, description: '日记 ID，如 D0932 或 D0932@银砂纪年；可空格分隔多个' },
      workspace: ARG_WORKSPACE,
    },
    async execute(args) {
      return runMemory(cfg, ['read', String(args.diary_ids || '')], { workspace: args.workspace })
    },
  })

  register(ctx, {
    name: 'tags',
    description: '列出指定工作区（或全）已使用的全部标签及使用次数 —— 写日记前先看这里，优先复用已有细小标签。',
    parameters: { workspace: ARG_WORKSPACE },
    async execute(args) {
      return runMemory(cfg, ['tags'], { workspace: args.workspace })
    },
  })

  register(ctx, {
    name: 'info',
    description: '查看当前工作区的记忆统计（日记数 / 标签数 / 索引条目 / 用户数）。',
    parameters: { workspace: ARG_WORKSPACE },
    async execute(args) {
      return runMemory(cfg, ['info'], { workspace: args.workspace })
    },
  })

  /* - 能文档语义索引（mcp-skill-index?------------------------------------------------------------ */
  register(ctx, {
    name: 'skill_index',
    description: '把技能总揽（SKILL.md）加入语义检索库，之后检索会自动命中该技能。'
      + 'action: index 定向索引一个技能（配 skill）｜all 全量增量刷新｜status 查看已索引文档｜'
      + 'prune 清理"目录里已不存在"的失效条目（技能被删/被移走后会残留，用这个清；跨全部根判断，不会误删）。'
      + 'root: codex=~/.codex/skills（默认）｜dsh=~/.dsh/skills。',
    parameters: {
      action: { type: 'string', required: true, enum: ['index', 'all', 'status', 'prune'], description: '索引操作' },
      skill: { type: 'string', description: '技能文件夹名（index 必填，status 可）' },
      root: { type: 'string', enum: ['codex', 'dsh'], description: '扫描根：codex=~/.codex/skills（默认）｜dsh=~/.dsh/skills' },
    },
    async execute(args) {
      const action = String(args.action || 'status').toLowerCase()
      if (action === 'index' && !String(args.skill || '').trim()) return '[错误] index 需要 skill 参数'
      const root = String(args.root || 'codex').toLowerCase() === 'dsh'
        ? join(DSH_HOME, 'skills')
        : cfg.codexSkills
      const out = runHelper(cfg, 'skill_index', [action, String(args.skill || '')], {
        env: {
          LU_SCRIPTS: cfg.semanticScripts,
          LU_SKILLS_ROOT: root,
          // all/prune 要跨全部根：单个根做全量刷新时，会把另一个根已索引的技能
          // 当成"失效"整片删掉（2026-09-12 实测：库从 35 掉到 33）。
          LU_ALL_ROOTS: `${join(DSH_HOME, 'skills')};${cfg.codexSkills}`,
        },
        timeoutMs: 300000,
      })
      return action === 'status' ? out : out + `\n[扫描根] ${root}`
    },
  })

  /* - 流变·通路二（mcp-memory-validate?------------------------------------------------------------ */
  register(ctx, {
    name: 'path2',
    description: '流变·通路二：无上下文外部双 API 校验。API-A 生成初始回答，API-B 按五维度'
      + '（逻辑断裂 / 未回答问题 / 证据缺失 / 过度声称 / 答非所问）列出问题清单，返回 {initial_answer, problems[]}。'
      + '不检索记忆不写日记不继承上下文；事实核对由主智能体对照通路一的记忆总结裁决。',
    parameters: {
      question: { type: 'string', required: true, description: '要校验的问题或待审文' },
      out_path: { type: 'string', description: '可选：把 JSON 结果同时写入指定文件' },
    },
    async execute(args) {
      return runPath2(cfg, String(args.question || ''), args.out_path ? String(args.out_path) : undefined)
    },
  })

  /* - 全局通用教训 -------------------------------------------------------- */
  register(ctx, {
    name: 'lessons',
    description: '**通用教训**清单（全局一份 + 当前工作区一份，每次会话开始自动注入 <liubian-lessons> 块）。只收跨领域通用的条目'
      + '（工程纪律 / 流程与协作 / 验证与诊断方法），不含特定领域内容。'
      + 'action: list 查看｜add 新增（text=教训一句话）｜remove 移除（id=序号）｜generate 从记忆库蒸馏通用教训（LLM）。'
      + 'scope=global｜workspace 选清单（默认 global）。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'add', 'remove', 'generate'], description: '操作' },
      scope: { type: 'string', enum: ['global', 'workspace'], description: '清单范围：global=全局（默认）；workspace=当前工作区' },
      text: { type: 'string', description: 'add 时：教训内容（一句话，跨领域通用）' },
      id: { type: 'number', description: 'remove 时：序号（list 输出的编号，1 起）' },
      count: { type: 'number', description: 'generate 时：希望蒸馏几条（默认 8，最多 30）' },
    },
    async execute(args, exec) {
      const action = String(args.action || 'list').toLowerCase()
      const scope = String(args.scope || 'global').toLowerCase() === 'workspace' ? 'workspace' : 'global'
      const ws = scope === 'workspace' ? resolveDiaryWorkspace(cfg, exec?.agent) : ''
      if (scope === 'workspace' && !ws) {
        return '[错误] 无法解析当前会话的工作区（scope=workspace 需要会话有工作目录）。先用 scope=global。'
      }
      if (action === 'list') {
        const list = loadLessons(scope, ws)
        if (!list.length) {
          return scope === 'workspace'
            ? `（工作区「${ws}」的清单为空。用 action=add scope=workspace 添加，或 action=generate scope=workspace 从该工作区日记蒸馏。）`
            : '（全局清单为空。用 action=add 添加，或 action=generate 从记忆库蒸馏通用教训。）'
        }
        return list.map((t, i) => `${i + 1}. ${t}`).join('\n')
      }
      if (action === 'add') {
        const text = String(args.text || '').trim()
        if (!text) return '[错误] add 需要 text（一句话教训，跨领域通用）'
        const list = loadLessons(scope, ws)
        if (list.length >= 200) return '[错误] 清单已满（200 条），先 remove 再加'
        if (list.some(t => normLesson(t) === normLesson(text))) {
          return `[重复] 这条教训已在${scope === 'workspace' ? '工作区' : '全局'}清单里（现共 ${list.length} 条）。`
        }
        list.push(text)
        saveLessons(list, scope, ws)
        return `[OK] 已添加到${scope === 'workspace' ? '工作区' : '全局'}清单（现共 ${list.length} 条），下次会话开始自动注入。`
      }
      if (action === 'remove') {
        const id = Number(args.id)
        const list = loadLessons(scope, ws)
        if (!Number.isFinite(id) || id < 1 || id > list.length) return `[错误] remove 需要 id（1~${list.length}）`
        const gone = list.splice(id - 1, 1)
        saveLessons(list, scope, ws)
        return `[OK] 已移除：${gone[0]}\n（现共 ${list.length} 条）`
      }
      if (action === 'generate') {
        const r = await generateLessons(cfg, { count: args.count, log: ctx.logger, scope, ws })
        if (!r.ok) return `[错误] ${r.error}`
        if (!r.added) return `[无新增] ${r.note || '没有产出新条目'}`
        return `[OK] 新增 ${r.added} 条通用教训（现共 ${r.total} 条），下次会话开始自动注入：\n`
          + r.lessons.map((t, i) => `${i + 1}. ${t}`).join('\n')
      }
      return `[错误] 未知 action: ${action}`
    },
  })

  /* - 系统总览 ------------------------------------------------------------ */
  register(ctx, {
    name: 'status',
    description: '流变系统总览：DSH 侧接入状态（写入模式 / 系统账号）+ 注册表统计 + 统一 CLI status。',
    parameters: { workspace: ARG_WORKSPACE },
    async execute(args) {
      const stats = runHelper(cfg, 'registry_stats', [], { timeoutMs: 60000 })
      const cli = runLiubianCli(cfg, ['status'], { workspace: args.workspace })
      return [
        '[DSH 侧接入]',
        '  写日记：匿名写入（无身份 / 无密码 / 无 KEY）',
        '  向量服务：由独立插件 dsh-liubian-embed 负责（用 _dsh_external_dsh_liubian_embed action=status 查看）',
        '',
        '[注册表统计]',
        stats,
        '',
        '[liubian.py status]',
        cli,
      ].join('\n')
    },
  })

  /* ── 自动日记（外部 API 撰写，下一轮写上一轮） ────────────────────────── */
  register(ctx, {
    name: 'diary',
    description: '自动日记的查看与运维：外部 API 按上一轮完整对话撰写日记，下一轮开始时写上一轮。'
      + 'action: status 看开关/key/待补队列/最近日志｜preview 预览将要发给 API 的完整输入（不调用 API）'
      + '｜run 立刻补写当前未写的轮次｜retry 重试待补队列｜enable / disable。'
      + '（enable 时若还没配 key，用 api_key=… 带上；也支持 url= / model= 覆盖）',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'preview', 'run', 'retry', 'enable', 'disable'], description: '操作' },
      api_key: { type: 'string', description: 'enable 时可选：新 API key（只落本地 diary.json，不回显全文）' },
      url: { type: 'string', description: 'enable 时可选：API 端点' },
      model: { type: 'string', description: 'enable 时可选：模型' },
      workspace: ARG_WORKSPACE,
    },
    async execute(args, exec) {
      const action = String(args.action || 'status').toLowerCase()
      const agent = exec && exec.agent
      const sessionId = String((agent && agent.session && agent.session.id) || 'default')

      if (action === 'enable' || action === 'disable') {
        const dc0 = diaryConfig()
        const patch = { enabled: action === 'enable' }
        if (args.api_key) patch.apiKey = String(args.api_key).trim()
        if (args.url) patch.url = String(args.url).trim()
        if (args.model) patch.model = String(args.model).trim()
        if (action === 'enable' && !(patch.apiKey || dc0.apiKey)) {
          return '[错误] 还没配置 API key：enable 时请带 api_key=…（或用 url= / model= 覆盖端点与模型）'
        }
        if (patch.url) patch.url = normalizeDiaryUrl(patch.url)
        saveDiaryConfig(patch)
        const dc = diaryConfig()
        // 刚开启：立刻把标签向量缓存热起来（约 0.2 秒）。
        // 否则要等下一轮用到才懒加载，status 也会显示"未命中"误导人。
        if (dc.enabled) void warmTagVectors(ctx, cfg)
        return `[OK] 自动日记已${action === 'enable' ? '开启' : '关闭'}`
          + `\n[端点] ${dc.url}\n[模型] ${dc.model}\n[key] ${maskKey(dc.apiKey)}`
          + `\n[规则] 下一轮写上一轮｜每篇 ≤${cfg.diaryMaxChars} 字，超出新建一篇（篇数不限）｜标签${String(cfg.diaryTagSelect) === 'semantic' ? `用助手正文向量相似度取前 ${cfg.diaryTagTopN} 个` : '用整张表'}随对话送入｜工作区 ${cfg.diaryWorkspace}`
          + (action === 'enable' ? '\n[提示] 开启后不要再手动 write，否则同一轮会写两遍。' : '')
      }

      if (action === 'retry') {
        const r = await flushPending(ctx, cfg, 10)
        return `[OK] 待补队列：尝试 ${r.tried} 条，成功 ${r.done || 0} 条，剩余 ${r.left} 条`
      }

      if (action === 'run') {
        const buf = turnBuffers.get(sessionId)
        const sealed = buf ? buf.sealed.length : 0
        const turn = takeUnwrittenTurn(sessionId)
        if (!turn) return `[无] 当前会话没有"已封口且未写"的轮次（已封口 ${sealed} 轮）`
        const r = await writeTurnDiary(ctx, cfg, agent, turn)
        if (r.skipped) return `[跳过] ${r.skipped}`
        if (r.error) return `[失败] ${r.error}（已入待补队列；用 action=retry 重试）`
        return `[OK] 已写 turn=${turn.turn}：${r.written.map(w => `${w.id || '(失败)'}`).join('、')}`
          + `\n${r.written.map(w => `  ${w.id} [${w.tags.join(',')}] ${w.summary}`).join('\n')}`
      }

      if (action === 'preview') {
        const buf = turnBuffers.get(sessionId)
        const turn = (buf && buf.sealed.length) ? buf.sealed[buf.sealed.length - 1] : null
        if (!turn) return `[无] 当前会话还没有已封口的轮次（正在进行的轮次结束后才有）｜已封口 ${buf ? buf.sealed.length : 0} 轮`
        const workspace = resolveDiaryWorkspace(cfg, agent)
        const picked = await selectDiaryTags(cfg, turn, ctx.logger)
        const hints = picked.tags
        const payload = await buildDiaryPayload(cfg, turn, hints, workspace)
        const head = s => String(s).length > 2600 ? String(s).slice(0, 2600) + `\n…（共 ${String(s).length} 字，此处截断展示）` : String(s)
        const scored = (picked.scored || []).slice(0, 12)
          .map(h => `${h.tag}(${h.score.toFixed(3)})`).join('、')
        return [
          `[预览] turn=${turn.turn}｜工作区 ${workspace}｜结束状态 ${turn.reason}`,
          `[采集] 提问 ${turn.human.length} 段｜助手正文 ${turn.assistant.length} 段｜工具 ${[...new Set(turn.tools)].join('、') || '无'}`,
          `[选标签] 模式 ${picked.mode}｜${hints.length} 个${scored ? `｜相似度前 12：${scored}` : ''}`,
          `[体量] 对话原文 ${turnText(turn).length} 字｜送 API 输入 ${payload.messages[1].content.length} 字`,
          '[提示] 以下是**将要发送给外部 API 的完整输入**（未调用 API）：',
          '',
          '------------- system -------------',
          head(payload.messages[0].content),
          '',
          '------------- user -------------',
          head(payload.messages[1].content),
        ].join('\n')
      }

      // status
      const dc = diaryConfig()
      const buf = turnBuffers.get(sessionId)
      const pending = readPending()
      const tagN = (await allTagsFor(cfg)).length
      const mode = String(cfg.diaryTagSelect || 'semantic')
      const svc = mode === 'semantic'
        ? `语义取前 ${cfg.diaryTagTopN}（${
          tagVecMemo ? `向量缓存已就绪 ${tagVecMemo.names.length} 个/${tagVecMemo.dim} 维`
            : (dc.enabled ? '向量缓存未命中，本轮退回整张表（正在建）' : '日记关着，缓存按需加载')
        }）`
        : (mode === 'all' ? '整张表' : '不给')
      let logTail = []
      try {
        logTail = readFileSync(diaryLogFile(), 'utf8').replace(/^\uFEFF/, '').split('\n').filter(l => l.trim()).slice(-5)
          .map(l => { const o = JSON.parse(l); return `  ${o.at} turn=${o.turn} @${o.workspace} → ${(o.entries || []).map(e => e.id || '(失败)').join('、')}` })
      } catch { /* 还没有日志 */ }
      return [
        `[开关] ${dc.enabled ? '开' : '关'}　[key] ${maskKey(dc.apiKey)}`,
        `[端点] ${dc.url}　[模型] ${dc.model}　[temperature] ${dc.temperature}　[maxTokens] ${dc.maxTokens}`,
        `[规则] 下一轮写上一轮｜每篇 ≤${cfg.diaryMaxChars} 字（超出新建，篇数不限）`,
        `[标签] ${svc}｜字典 ${tagN} 个｜[工作区] ${cfg.diaryWorkspace}`,
        `[检索侧 API] ${(() => {
          const api = retrievalApiConfig(cfg, dc)
          return `${api.model}　key ${maskKey(api.apiKey)}　来源 ${api.source}`
        })()}`,
        `[本会话] 已封口 ${buf ? buf.sealed.length : 0} 轮｜待写 ${takeUnwrittenTurn(sessionId) ? '有' : '无'}`,
        `[待补队列] ${pending.length} 条`,
        `[已写日志] ${writtenKeys.size} 条`,
        logTail.length ? '[最近日志]\n' + logTail.join('\n') : '[最近日志] （空）',
        `[文件] ${diaryConfigFile()}`,
      ].join('\n')
    },
  })

  /* - 面板（mcp-memory-panel） ------------------------------------------------------------ */
  register(ctx, {
    name: 'panel',
    description: '打开本地管理界面（仅本机真人使用）：流变系统管理面板（用户 / 记忆 / skill 管理）。',
    parameters: {
      target: { type: 'string', enum: ['admin'], required: true, description: 'admin=管理面板' },
      workspace: ARG_WORKSPACE,
    },
    async execute(args) {
      if (existsSync(cfg.panelExe)) return `${launchDetached(cfg.panelExe, [])}：流变系统管理面板`
      if (existsSync(cfg.panelPy)) return `${launchDetached(cfg.python, [cfg.panelPy])}：流变系统管理面板（PyQt）`
      return '[错误] 未找到面板程序（panelExe / panelPy 都不存在'
    },
  })

  /* 语义向量服务（mcp-embed-model）已拆到独立插件 dsh-liubian-embed：
     本插件不再持有它的配置、工具与生命周期，检索侧只依赖「HTTP 调不到就回退纯 tag」。 */
}

/* ──────────────────────────────────────────────────────────────────────────
 * 5. 上下文插入 —— 对照 @openviking/dsh-memory-plugin 的接线方式
 * 那个插件用两条钩子把记忆塞进上下文：
 *   agent/session-start → agent.inject(profileMessage)  会话开头塞「用户画像 + 可用记忆」
 *   agent/pre-step      → 在 next() 返回的消息尾部追加 recallMessage，每轮按 prompt 自动召回
 * 本插件照搬同一套接线：「画像」换成流变身份卡，「召回」换成 memory.py search
 * （tag + 语义 1:1 融合，顺带命中技能总揽），于是和 Codex 侧 #m 流程用的是同一条检索链路。
 *
 * 没有移植 capture：OpenViking 把每轮都写进它自己的会话库，而流变日记是用户精心
 * 打标签的记忆资产 —— 自动把原始对话灌进去只会污染检索，写日记仍由技能流程显式
 * 调用 write 完成。
 * ────────────────────────────────────────────────────────────────────────── */

export const PLUGIN_SOURCE = 'dsh-liubian'

/**
 * dsh 自己的消息构造器。拿不到（老版本宿主 / 解析不到 @deepseek-ai/dsh-llm）就退回
 * 等价的最小结构 —— 免得为了一个构造函数把整个插件拖垮。
 * ⚠️ id 是硬性要求，不是可选项：DSH 的 user/message 事件在从磁盘冷读重放时要过
 * dsh-session 的 adoptSessionEvent() 校验（`data.id` 必须是非空字符串），缺 id 会抛
 *   SessionPersistenceCorruptionError: session event at seq N lacks an identified message
 * 整个会话的历史就此打不开（GUI 显示「历史加载失败」）。本插件的 node_modules 里没有
 * @deepseek-ai/dsh-llm，import 必然失败，所以之前永远走手搓分支、每条注入消息都缺 id，
 * 把宿主会话日志写坏了。回退分支必须自己补 uuid（与宿主 createMessage 的
 * MessageId(crypto.randomUUID()) 同形）。
 */
let createUserMessageFn = null
try {
  const llm = await import('@deepseek-ai/dsh-llm')
  if (typeof llm.createUserMessage === 'function') createUserMessageFn = llm.createUserMessage
} catch {
  createUserMessageFn = null
}

function pluginMessage(content, form) {
  const source = { kind: 'plugin', plugin: PLUGIN_SOURCE, form }
  if (createUserMessageFn) {
    return createUserMessageFn({ content: [{ type: 'text', text: content }], source })
  }
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text: content }], source }
}

function messageText(message) {
  if (!message || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** 自己注入的块要认出来，否则会拿自己的召回结果当查询、越滚越多。 */
function isOurMessage(message) {
  return message?.source?.kind === 'plugin' && message.source.plugin === PLUGIN_SOURCE
}

/** 任何插件注入的块（本插件的、OpenViking 的、别的插件的）都是合成内容，不是人说的话。 */
function isPluginMessage(message) {
  return message?.source?.kind === 'plugin'
}

/**
 * 真正的人话 = role 为 user 且 source.kind 为空 / 'user'。
 * 实测（recallDebug 打出来的真实消息表）这一层至少有四种「非人」的 user 消息：
 *   kind='plugin'（本插件的身份卡/召回块、OpenViking 的画像块、system-prompt 的运行时快照）
 *   kind='skill-catalog'（技能目录 system-reminder，长度可达 6900 字）
 *   kind='tool'（工具结果）
 *   role='assistant'
 * 早先只排除了 kind='plugin'，结果查询落在 6900 字的技能目录上，
 * 选出来的 tag 变成「音频特征 / 触发条件 / 蒸馏」这类噪声 —— 用户问的第76章、
 * 米娅、莉诺尔一个都没进标签。
 */
function isHumanMessage(message) {
  if (!message || message.role !== 'user') return false
  const kind = message.source?.kind
  return kind === undefined || kind === null || kind === 'user'
}

function promptText(messages) {
  return (messages || [])
    .filter(m => !isOurMessage(m))
    .map(messageText)
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

/**
 * 本轮真正的人话 —— 倒着找第一条人类消息。
 * 遇到助手消息或工具结果就停：说明新一轮提问还没发生，本轮不该重复召回。
 */
function currentPrompt(messages) {
  const list = messages || []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i]
    if (isHumanMessage(message)) return messageText(message).trim()
    if (!message || message.role === 'assistant') return ''
    if (message.source?.kind === 'tool') return ''
  }
  return ''
}

/** 是否存在一条值得召回的新人类输入。 */
function isFreshUserPrompt(messages) {
  return currentPrompt(messages) !== ''
}

/** CJK 感知的 token 估算（同 OpenViking：CJK 1.5 token/字，其余 chars/4）。 */
function estimateTokens(text) {
  if (!text) return 0
  let cjk = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) >= 0x3000) cjk += 1
  }
  return Math.ceil(cjk * 1.5 + (text.length - cjk) / 4)
}

function clipText(text, maxChars) {
  const s = String(text || '').trim()
  if (s.length <= maxChars) return s
  return s.slice(0, maxChars) + '\n…（已截断）'
}

/* - 标签字典：召回挑 tag ?------------------------------------------------------------ */

let tagDict = null

async function tagDictionary(cfg) {
  if (tagDict && Date.now() - tagDict.at < 600000) return tagDict
  try {
    const raw = await runHelperAsync(cfg, 'registry_stats', ['--tag-list'], { timeoutMs: 60000 })
    const parsed = JSON.parse(raw)
    // 兼容两种返回：新}${names, counts}（按次数降序）与旧的纯数。
    const names = Array.isArray(parsed) ? parsed : (parsed && parsed.names)
    const countsArr = (!Array.isArray(parsed) && parsed && parsed.counts) || null
    if (Array.isArray(names) && names.length > 0) {
      // 预先把标签的-?2~4 元组放进 Set，挑 tag ?O(1) 判定。
      // 避免每个候选元组去扫 1.3 万个标签。
      const grams = new Set()
      for (const name of names) {
        const s = String(name)
        for (let len = 2; len <= 4; len += 1) {
          for (let i = 0; i + len <= s.length; i += 1) grams.add(s.slice(i, i + len))
        }
      }
      const counts = new Map()
      if (countsArr) names.forEach((n, i) => counts.set(String(n), Number(countsArr[i]) || 0))
      // total = 全部标签出现次数之和（日记/召回估算规模用）
      let total = 0
      for (const v of counts.values()) total += v
      tagDict = { at: Date.now(), names, grams, counts, total }
      // 标签表重新拉了：语义选标签的向量缓存跟着失效（签名判定，见 tagVectors）。
      if (tagVecMemo && tagVecMemo.names.length !== names.length) tagVecMemo = null
    }
  } catch {
    /* 拿不到字典就回不过滤，检索仍能跑 */
  }
  return tagDict
}

/** 高频虚词（含 记忆技能 明令禁止的宽泛词），作为 tag 只会稀释命中率。 */
const RECALL_STOP = new Set([
  '什么', '这个', '那个', '我们', '你们', '他们', '可以', '已经', '因为', '所以',
  '但是', '如果', '现在', '需要', '问题', '一个', '没有', '就是', '这样', '那样',
  '时候', '还是', '或者', '以及', '然后', '而且', '不是', '这些', '那些', '自己',
  '上面', '下面', '里面', '东西', '方法', '情况', '一直', '应该', '可能', '知道',
  '觉得', '看看', '一下', '一点', '这么', '那么', '怎么', '为了', '不过', '这里',
  // 宽泛到没有区分度的词（记忆技能也明令禁止用它们做标签）
  '技能', '规则', '经验', '讨论', '实现', '设计', '测试', '配置',
  '用户', '记忆', '内容', '时间', '系统', '工作', '文件', '项目', '数据',
  '结果', '需求', '功能', '版本', '方式', '状态', '信息', '结构', '过程',
])

/** 英文虚词：常作为子串混进标签字典，但对召回没有信息量。 */
const RECALL_STOP_EN = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'you', 'your', 'are', 'was', 'were',
  'has', 'have', 'had', 'not', 'but', 'can', 'could', 'should', 'would', 'about',
  'from', 'into', 'than', 'then', 'them', 'they', 'there', 'here', 'what', 'when',
  'where', 'which', 'while', 'will', 'just', 'only', 'also', 'any', 'all', 'our',
  'out', 'one', 'two', 'how', 'why', 'who', 'its', 'does', 'did', 'yes', 'more',
  'most', 'some', 'such', 'very', 'each', 'both', 'been', 'being', 'over', 'under',
])

/**
 * 从 prompt 挑候选 tag：CJK（含数字，这样「第76章」这类章节号才拿得到）+ 拉丁词，
 * 先按「是否出现在真实标签字典里」筛选，再按元组长度加权排序。
 * 挑出来的 tag 交给 memory.py search 做模糊扩展 —— 与 Codex 侧 #m 流程同一条链路，
 * 和 Codex 侧 #m 流程同一条链路，因此 tag 命中与语义向量仍然是 1:1 融合。
 */
function candidateTags(text, gramSet, max) {
  const grams = new Map()
  const bump = (s, w) => {
    if (s.length >= 2) grams.set(s, (grams.get(s) || 0) + w)
  }
  // 含数字的 CJK 串整体成 run，否则第76章会被数字切断成「第」章」两个短片段
  for (const run of String(text).match(/[\u4e00-\u9fff0-9]+/g) || []) {
    for (let len = 2; len <= 4; len += 1) {
      for (let i = 0; i + len <= run.length; i += 1) bump(run.slice(i, i + len), len)
    }
  }
  for (const word of String(text).match(/[A-Za-z][A-Za-z0-9_.-]{3,}/g) || []) {
    if (RECALL_STOP_EN.has(word.toLowerCase())) continue
    bump(word, 4)
  }

  const scored = []
  for (const [gram, weight] of grams) {
    if (RECALL_STOP.has(gram)) continue
    if (gramSet && !gramSet.has(gram)) continue
    scored.push([gram, weight + gram.length * 2])
  }
  scored.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
  // 去掉互为子串的候选（银砂纪年 命中后，银砂纪/砂纪年/银砂/纪年 都是浪费配额），
  // 最多留 max 个 tag 位，避免同概念的子串候选吃掉配额。
  const picked = []
  for (const [gram] of scored) {
    if (picked.some(kept => kept.includes(gram) || gram.includes(kept))) continue
    picked.push(gram)
    if (picked.length >= max) break
  }
  return picked
}

/* - 身份卡（会话启动注入）------------------------------------------------------------ */

const profileCache = { at: 0, block: '' }

function profileBlockCached(cfg) {
  if (!cfg.profileInject) return Promise.resolve('')
  if (Date.now() - profileCache.at < 60000) return Promise.resolve(profileCache.block)
  return buildProfileBlock(cfg)
    .then(block => {
      profileCache.at = Date.now()
      profileCache.block = block
      return block
    })
    .catch(() => profileCache.block)
}

async function buildProfileBlock(cfg) {
  let data = null
  try {
    const raw = await runHelperAsync(cfg, 'registry_stats', [], { timeoutMs: 60000 })
    data = JSON.parse(raw)
  } catch {
    return ''
  }
  if (!data || data.error) return ''

  const lines = []
  const card = data.card

  lines.push('[流变·记忆] 写日记走匿名（无身份）'
    + `｜默认工作区：${cfg.workspace}`)

  const dc = diaryConfig()
  lines.push(dc.enabled && dc.apiKey
    ? '[自动日记] 已开启：下一轮会自动写上一轮（外部 API 撰写）。**不要再手动 write，会写重**'
    : '[自动日记] 未开启：按技能流程手动 write（至少 5 个细小标签）。')
  if (card?.last_diary) {
    const d = card.last_diary
    lines.push(`[最近记忆] ${d.id}@${d.workspace} ${d.date} — ${clipText(d.summary, 80)}`)
  }

  lines.push(`[记忆规模] ${data.user_count} 用户 / ${data.workspace_count} 工作区 / `
    + `${data.tag_entries} 条 tag 索引 / ${data.tag_names} 个标签`)
  lines.push('[检索] ' + (cfg.memoryInject
    ? `每轮已自动注入 ${cfg.memoryTopN} 篇相关日记全文（前 ${cfg.memorySeedTop} 篇主线 + 各 ${cfg.memoryRelatedPerSeed} 篇关联）——不用再重复搜；`
      + '只有第一轮 / 无命中 / 想换角度时才用 _dsh_external_dsh_liubian_search（至少 4 个标签）。'
    : '本轮无自动注入，需要时用 _dsh_external_dsh_liubian_search（至少 4 个标签）。'))

  // 预算裁剪：超预算就条丢，先丢末尾的说明行。
  const budget = Number(cfg.profileTokenBudget) || 700
  while (lines.length > 1 && estimateTokens(lines.join('\n')) > budget) lines.pop()

  const body = lines.join('\n')
  return `<liubian-context source="profile">\n${body}\n</liubian-context>`
}

/* - 每轮记忆注入 ------------------------------------------------------------
 *
 * 旧的"自动召回"（从 prompt 挑 tag → 调 memory.py search → 只注入**检索摘要**）
 * 已于 2026-09-12 整体删除，用户要求"把那个全是简介的注入删掉"。
 * 现在唯一的一条是 `memoryRetrieval()`（见第 8 节）：tag 一路 + 语义一路融合，
 * 注入前 N 篇**正文全文**。旧的 tag 挑选函数 `candidateTags` 保留 ——
 * 标签向量缓存没建好时，语义选标签会退回它做字面兜底。
 */

/* - 接线 ------------------------------------------------------------ */

const contextStates = new Map()

function contextStateFor(session) {
  const id = String(session?.id ?? 'default')
  let state = contextStates.get(id)
  if (!state) {
    state = { profileDelivered: false, profilePromise: null, lastRecallKey: '', recallCount: 0, lessonsCounter: 0, lessonsLastKey: '', autoLoadedSkills: [], turnReminderCount: 0 }
    contextStates.set(id, state)
  }
  return state
}

/* ── 全局通用教训（会话开始注入，跨领域共享）──────────────────────────────
 *  存储：~/.dsh/liubian/lessons.json（全局一份，所有会话共享）。
 *  只收**通用**教训：工程纪律 / 流程与协作 / 验证与诊断方法这类"换个领域依然成立"的；
 *  特定领域内容（某部小说、某个模型或比赛的专属结论）不收 —— 那是记忆检索的职责。
 */

/** scope='global'：全局一份（lessons.json）；scope='workspace'：每工作区一份
 *  （lessons-<工作区>.json），两份互不影响、注入时都给。 */
function lessonsFile(scope = 'global', ws = '') {
  return scope === 'workspace' && ws
    ? join(DSH_HOME, 'liubian', `lessons-${ws}.json`)
    : join(DSH_HOME, 'liubian', 'lessons.json')
}

function loadLessons(scope = 'global', ws = '') {
  try {
    const meta = JSON.parse(readFileSync(lessonsFile(scope, ws), 'utf8').replace(/^\uFEFF/, ''))
    const list = Array.isArray(meta && meta.lessons) ? meta.lessons : []
    return list.map(t => String(t || '').trim()).filter(Boolean)
  } catch {
    return []
  }
}

function saveLessons(list, scope = 'global', ws = '') {
  const file = lessonsFile(scope, ws)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString(), lessons: list }, null, 2), 'utf8')
}

const normLesson = t => String(t || '').replace(/\s+/g, '').trim()

/** 注入块：条数与总长有上限；空清单返回 ''（不注入）。 */
function buildLessonsBlock(cfg, scope = 'global', ws = '') {
  if (!cfg.lessonsInject) return ''
  const lessons = loadLessons(scope, ws)
  if (!lessons.length) return ''
  const label = scope === 'workspace' ? `工作区「${ws}」` : '全局'
  const maxN = Math.max(1, Number(cfg.lessonsMax) || 20)
  const budget = Math.max(400, Number(cfg.lessonsChars) || 2400)
  const shown = lessons.slice(0, maxN).map(t => clipText(String(t), 120))
  const items = []
  let used = 0
  for (let i = 0; i < shown.length; i += 1) {
    const seg = `${i + 1}. ${shown[i]}`
    if (used + seg.length > budget) {
      items.push(`（还有 ${shown.length - i} 条未展示，完整清单用 _dsh_external_dsh_liubian_lessons action=list 查看）`)
      break
    }
    items.push(seg)
    used += seg.length
  }
  return [
    `<liubian-lessons scope="${label}" n="${shown.length}">`,
    '说明：以下是**通用教训**（跨领域沉淀，只含通用项，不含特定领域细节）。处理任务前先对照，避免重蹈覆辙；不要在回答里复述这份清单。',
    ...items,
    '──',
    `主动检索入口：需要跨会话查历史结论时，用 _dsh_external_dsh_liubian_search（tags 至少 4 个，返回两级摘要列表，看中哪篇用 _dsh_external_dsh_liubian_read 取全文）——自动注入只覆盖当前话题，主动搜索才能拉到检索块没命中的记忆。`,
    `教训沉淀入口：发现跨领域通用的新教训时，用 _dsh_external_dsh_liubian_lessons action=add（scope=global 全局 / workspace 当前工作区，text=一句话教训）写入清单；也可以 action=generate 让 LLM 从记忆库自动蒸馏。`,
    '</liubian-lessons>',
  ].join('\n')
}

/* ── 能力卡：已装插件 / MCP 的"什么时候用什么"清单 ────────────────────────
 *  模型看不见"我有哪些扩展能力"——工具表里有 mcp__* 但注意力顾不上。
 *  清单 = 手工维护的 capabilities.json（含使用指引）∪ 自动发现（profile 的
 *  patch.yml 扫 MCP serverName、package.json 扫插件名），会话开始 + 每 N 轮提醒。
 */

function capabilitiesFile() {
  return join(DSH_HOME, 'liubian', 'capabilities.json')
}

function loadCapabilities() {
  try {
    const meta = JSON.parse(readFileSync(capabilitiesFile(), 'utf8').replace(/^\uFEFF/, ''))
    return Array.isArray(meta && meta.capabilities) ? meta.capabilities : []
  } catch {
    return []
  }
}

/** 从 profile 配置自动发现：patch.yml 扫 MCP serverName，package.json 扫插件名。 */
function discoverInstalled(cfg) {
  const mcps = new Set()
  const plugins = new Set()
  const dir = String(cfg.profileDir || '').trim()
  if (dir) {
    try {
      const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
      for (const m of patch.matchAll(/^\s*serverName:\s*(\S+)/gm)) mcps.add(m[1])
    } catch { /* patch 读不到就跳过 */ }
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      for (const name of Object.keys(pkg.dependencies || {})) {
        if (/dsh-|liubian|mcp/i.test(name)) plugins.add(name)
      }
    } catch { /* package.json 读不到就跳过 */ }
  }
  return { mcps: [...mcps], plugins: [...plugins] }
}

function buildCapabilitiesBlock(cfg) {
  if (!cfg.capabilitiesInject) return ''
  const curated = loadCapabilities()
  const known = new Set(curated.map(c => String(c.name || '').toLowerCase()))
  const disc = discoverInstalled(cfg)
  const extraMcp = disc.mcps.filter(n => ![...known].some(k => k.includes(n.toLowerCase())))
  const extraPlugins = disc.plugins.filter(n => !known.has(n.toLowerCase()))
  if (!curated.length && !extraMcp.length && !extraPlugins.length) return ''
  const lines = [
    '<liubian-capabilities>',
    '说明：以下是本会话可用的扩展能力（插件工具与 MCP 服务器）。它们已在你的工具表里，遇到匹配场景时**主动调用**，不要等用户点名。',
    ...curated.map((c, i) => {
      const head = `${i + 1}. ${c.name}${c.tools ? `｜工具：${c.tools}` : ''}`
      const when = c.when ? `\n   何时用：${c.when}` : ''
      const how = c.how ? `\n   怎么用：${c.how}` : ''
      return head + when + how
    }),
  ]
  if (extraMcp.length) lines.push(`其他已接 MCP 服务器：${extraMcp.join('、')}（工具名形如 mcp__<服务器>__<工具>，详见工具表）`)
  if (extraPlugins.length) lines.push(`其他已装插件：${extraPlugins.join('、')}`)
  lines.push('</liubian-capabilities>')
  return lines.join('\n')
}

/** 每轮注入的反反驳自查提醒（一次一轮，按人类消息条数计轮，不做内容去重）。 */
function buildTurnReminder(cfg) {
  if (!cfg.turnReminderInject) return ''
  const text = String(cfg.turnReminderText || '').trim()
  if (!text) return ''
  return ['<liubian-turn-check>', text, '</liubian-turn-check>'].join('\n')
}

/** 从记忆库蒸馏**通用**教训（LLM）：检索教训/经验/规则类日记 → 模型提炼跨领域条目
 *  → 与现有清单去重后合并。检索或蒸馏失败只返回错误，绝不动现有清单。 */
export async function generateLessons(cfg, { count = 8, log, scope = 'global', ws = '' } = {}) {
  const want = Math.max(1, Math.min(30, Number(count) || 8))
  const qws = scope === 'workspace' ? ws : ''   // 工作区教训：候选只取该工作区的日记
  const dc = diaryConfig()
  const api = retrievalApiConfig(cfg, dc)
  if (!api.apiKey) return { ok: false, error: '未配置检索侧外部 API（memoryApiKey / 写日记 key）' }

  const query = '通用教训：跨领域适用的工作经验、踩坑记录、工程纪律、流程规则与诊断方法'
  const vec = await queryEmbedding(cfg, query)
  const ranked = await jointQuery(cfg, {
    tags: ['教训', '经验', '规则', '坑', '流程', '协作'],
    vec, top: 24, full: false, mode: 'rank', workspace: qws,
  })
  if (!ranked || !ranked.ok) return { ok: false, error: (ranked && ranked.error) || '记忆检索失败' }
  // rank 模式只回 id+分数（无正文）：按 id 精确取正文（与 memoryRetrieval 同款两段式）
  const picked = (ranked.results || []).slice(0, 24)
  if (!picked.length) return { ok: false, error: '没有检索到候选日记' }
  const detail = await jointQuery(cfg, {
    workspace: qws, mode: 'ids', top: picked.length, full: true,
    ids: picked.map(r => `${r.ws}|${r.id}`),
  })
  const got = new Map(((detail && detail.results) || []).map(r => [`${r.ws}#${r.id}`, r]))
  const rows = picked.map(p => {
    const d = got.get(`${p.ws}#${p.id}`) || {}
    return { ws: p.ws, id: p.id, content: String(d.content || d.summary || '').trim() }
  }).filter(r => r.content)
  if (!rows.length) return { ok: false, error: '候选日记正文为空' }

  const material = rows
    .map((r, i) => `【${i + 1}】${r.id}@${r.ws}\n${r.content.slice(0, 700)}`)
    .join('\n\n')

  const sys = [
    '你负责从智能体的历史记忆里**蒸馏通用教训**，形成一份全局共享的清单。',
    '硬规则：',
    '1. 只收**跨领域通用**的条目：工程纪律、流程与协作、验证与诊断方法、资源配置这类"换一个领域依然成立"的教训。',
    '2. 丢弃一切**特定领域**内容：某部小说或某个角色的写法、某个模型或比赛的专属参数与结论、某台机器的临时处置 —— 这些不属于通用教训。',
    `3. 输出**恰好 ${want} 条**，每条一句话、具体可对照（不要空话，也不要照抄材料里的领域名词）。`,
    '4. 与已有清单重复或意思相同的条目不要输出（已有清单附在最后供查重）。',
    '5. 只输出 JSON，不要代码块围栏、不要解释：',
    '{"lessons":["教训1","教训2", ...]}',
  ].join('\n')
  const existing = loadLessons(scope, ws)
  const user = `[历史记忆候选]\n${material}\n\n[已有清单（查重用，不要重复）]\n${existing.length ? existing.map((t, i) => `${i + 1}. ${t}`).join('\n') : '（空）'}`
  const res = await callDiaryApi(cfg, api, { messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] })
  if (!res.ok) return { ok: false, error: res.error || 'LLM 调用失败' }

  let list = res.lessons || res.entries || []
  if (!Array.isArray(list)) list = []
  const have = new Set(existing.map(normLesson))
  const added = []
  for (const t of list.map(x => String(x || '').trim()).filter(Boolean)) {
    const k = normLesson(t)
    if (!k || have.has(k)) continue
    have.add(k)
    added.push(t)
    if (added.length >= want) break
  }
  if (!added.length) return { ok: true, added: 0, total: existing.length, note: '模型没有给出新条目（可能与现有清单全部重复）' }
  const next = existing.concat(added)
  saveLessons(next, scope, ws)
  return { ok: true, added: added.length, total: next.length, lessons: added }
}

async function takeProfileMessage(cfg, agent) {
  const state = contextStateFor(agent?.session)
  if (state.profileDelivered) return null
  if (!state.profilePromise) state.profilePromise = profileBlockCached(cfg)
  const block = await state.profilePromise
  const ws = resolveDiaryWorkspace(cfg, agent)
  const lessons = [
    buildLessonsBlock(cfg, 'global'),
    buildLessonsBlock(cfg, 'workspace', ws),   // 工作区局部教训：只发给对应会话
    buildCapabilitiesBlock(cfg),               // 能力卡：会话开始提醒有哪些扩展能力
  ].filter(Boolean)
  if (!block && !lessons.length) return null
  state.profileDelivered = true
  state.lessonsCounter = 0   // 首次注入后开始计轮，每 N 轮重注一次
  return pluginMessage([block, ...lessons].filter(Boolean).join('\n\n'), 'recall')
}

/* ──────────────────────────────────────────────────────────────────────────
 * 8. 联合检索注入 —— tag 一路 + 语义一路，加权融合，注入前 N 篇**全文**
 *
 * 用户定的规格（2026-09-12）：
 *   查询 = **最新轮的用户问题 + 上一轮的回答**
 *   ①语义路：把查询文本嵌入（同一个本地 qwen3-emb）→ 与库里每篇日记的向量算余弦
 *   ②tag 路：把**同一段查询文本 + 标签候选表**送外部 API，由模型挑 5 个 tag 做字面检索
 *   ③两路加权融合，取综合得分高的 10 篇，以**全文**注入上下文
 *
 * 标签候选表的取法与写日记完全同款：语义选前 memoryTagHints 个（同一份向量缓存）。
 * （旧的 recall —— 从 prompt 挑字面 tag、只注入检索摘要 —— 已于同日整体删除。）
 * ────────────────────────────────────────────────────────────────────────── */

/** 外部 API：从标签候选里挑出与本轮最相关的 N 个（与写日记同一个端点/key/模型）。 */
export async function screenQueryTags(cfg, text, hints, log) {
  // 检索侧用**独立的外部 API**（memoryApiKey），与写日记的 key 分开。
  // 没配 memoryApiKey 时回退到写日记那把 key（dc），保证单独部署也能用。
  const dc = diaryConfig()
  const api = retrievalApiConfig(cfg, dc)
  if (!api.apiKey) {
    return { tags: [], why: '检索侧外部 API 未配置（memoryApiKey 与写日记 key 都为空）' }
  }
  if (!hints.length) return { tags: [], why: '标签候选为空' }
  const n = Math.max(1, Number(cfg.memoryTagTopN) || 5)
  const sys = [
    `你是记忆检索的查询标签生成器。从给定的候选标签里挑出**恰好 ${n} 个**最能代表下面这段对话内容的标签，用于在记忆库里做字面检索。`,
    '',
    '硬规则：',
    `1. 必须**恰好 ${n} 个**，从候选列表里**原样逐字复制**，不要改写、不要新建、不要加 # 前缀。`,
    '2. **专名优先于通名**：优先挑这一轮特有的具体词（如"联合检索""标签向量""余弦相似度"这种一眼看出在说这件事的），',
    '   **避开跨领域同名的泛词**——例如"联合""融合""候选""方案""整合""确认""检索"这类，',
    '   它们在别的领域（模型训练/音画匹配/写作）的日记里也到处出现，挑它们等于没筛。',
    '3. 不要挑"标签""规则""技能""经验"这类在库里命中成百上千篇的词。',
    '4. 只输出 JSON，不要代码块围栏、不要解释：',
    `{"tags":["标签1", ..., "标签${n}"]}`,
  ].join('\n')
  const user = `[候选标签（按相似度降序）]\n${hints.join('、')}\n\n[本轮内容]\n${String(text).slice(0, Number(cfg.memoryQueryChars) || 6000)}`
  const payload = { messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }
  const res = await callDiaryApi(cfg, api, payload)
  if (!res.ok) return { tags: [], why: `挑标签失败：${res.error}` }
  // ⚠️ 这里不能用 res.entries：callDiaryApi 只认写日记的 {"diaries":[...]} 形状，
  // 而本接口返回的是 {"tags":[...]} —— 之前就是因为这个被当成"未返回预期 JSON"。
  let list = []
  if (Array.isArray(res.tags)) list = res.tags
  else if (Array.isArray(res.entries)) list = res.entries            // 兜底：万一模型套了 diaries
  list = list.map(t => String(t || '').trim().replace(/^#/, '')).filter(Boolean)
  const cand = new Set(hints)
  // ⚠️ 只认候选里真有的：模型经常自己造词（实测挑出"联合/候选融合"这类不在表里的），
  // 那种标签在检索时会被二次模糊扩展，反而比它替代掉的真标签更差。
  const valid = [...new Set(list.filter(t => cand.has(t)))]
  const rejected = list.filter(t => !cand.has(t))
  if (!valid.length) {
    return { tags: [], why: `模型给的都不在候选表里（${list.slice(0, 6).join('/')}）`, rejected }
  }
  return { tags: valid.slice(0, n), rejected, usage: res.usage || null }
}

/** 联合检索（helper/memory_query.py，只读 liubian.db）。
 *  mode: 'rank' 融合排序后只回 id+分数（默认）｜'semantic' 只回语义榜元数据
 *        ｜'ids' 按 ids 精确取正文｜'full' 直接回带正文的完整融合榜。 */
export async function jointQuery(cfg, { workspace, tags, vec, top, full, mode, ids, seeds, exclude }) {
  try {
    const req = {
      workspace: workspace || '',
      tags: tags || [],
      vec: vec || [],
      top: Math.max(1, Number(top) || Number(cfg.memoryTopN) || 30),
      wTag: Number(cfg.memoryWTags),
      full: full !== false,
      mode: mode || 'rank',
      ids: ids || [],
      seeds: seeds || [],
      exclude: exclude || [],
    }
    const raw = await runHelperAsync(cfg, 'memory_query', [], {
      timeoutMs: Math.max(15000, Number(cfg.memoryTimeoutMs) || 60000),
      stdin: JSON.stringify(req),
    })
    return JSON.parse(String(raw || '').trim())
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

/**
 * 在 Node 侧做加权融合（与 helper 的公式**必须一致**）：
 *   score = 语义余弦 + tagBonus · (命中标签数 / 查询标签数)
 * tagBonus 取 memoryWTags（默认 0.5）。为什么不是线性加权：见 helper 里那段长注释
 * （线性加权下 1/5 命中就抵得上 cos 意义上的 0.2，会把语义 0.31 的无关日记顶进前三）。
 */
export function fuseScores(cfg, semResults, pickedTags, tagMap) {
  const wRaw = Number(cfg.memoryWTags)
  const bonus = Number.isFinite(wRaw) ? Math.max(0, wRaw) : 0.5
  const qset = new Set((pickedTags || []).map(t => String(t).trim()).filter(Boolean))
  const out = []
  for (const r of semResults || []) {
    const own = new Set(tagMap?.get(`${r.ws}#${r.id}`) || r.tags || [])
    const matched = [...qset].filter(t => own.has(t))
    const tagScore = qset.size ? matched.length / qset.size : 0
    const sem = Math.max(0, Number(r.sem) || 0)
    out.push({
      ws: r.ws,
      id: r.id,
      sem: +sem.toFixed(4),
      tag: +tagScore.toFixed(4),
      score: +(sem + bonus * tagScore).toFixed(4),
      matchedTags: matched.slice(0, 8),
      tags: [...own].slice(0, 8),
    })
  }
  out.sort((a, b) => b.score - a.score || b.sem - a.sem)
  return out
}

/** 把命中条目拼成注入块（全文优先，超预算就降级为摘要）。 */
function formatMemoryBlock(results, cfg) {
  const perEntry = Math.max(500, Number(cfg.memoryContentChars) || 3000)
  const total = Math.max(2000, Number(cfg.memoryTotalChars) || 30000)
  const head = [
    `<liubian-memory hits="${results.length}" score="cos+tag">`,
    '说明：以下是本地记忆库里与本轮最相关的日记（前几篇为**主线**=联合检索命中，其余为**关联**=沿主线语义邻域扩展的第二跳），',
    '已给出**正文全文**供你直接参考，不要逐条复述。',
  ]
  const parts = []
  let used = head.join('\n').length
  for (const r of results) {
    const meta = `【${r.id}@${r.ws}】${r.date ? r.date + ' ' : ''}`
      + (r.source === 'related'
        ? `关联（语义 ${Number(r.sem).toFixed(2)}）`
        : `综合${Number(r.score).toFixed(2)}（语义 ${Number(r.sem).toFixed(2)}${Number(r.tag) > 0
          ? ` + 标签${Number(r.tag).toFixed(2)}：${(r.matchedTags || []).join('/')}`
          : '，无标签命中'}）`)
    const body = String(r.content || '').trim()
    const text = body
      ? (body.length > perEntry ? body.slice(0, perEntry) + '……（正文截断）' : body)
      : String(r.summary || '').trim()
    const seg = `\n${meta}\n${text}`
    if (used + seg.length > total) {
      if (parts.length === 0) parts.push(seg.slice(0, total))   // 第一篇再长也要给点
      break
    }
    parts.push(seg)
    used += seg.length
  }
  return head.join('\n') + parts.join('\n') + '\n</liubian-memory>'
}

/** 技能注入块：每轮只注入**命中的前 N 个技能的摘要行**（不给全文，控 token）。
 *  用户规格（2026-09-12）：每次输出命中的前 3 个技能。 */
/** 读技能 SKILL.md 正文（去 frontmatter、截断）。Codex 根优先、DSH 根兜底，再试平铺 .md。 */
export function readSkillBody(cfg, name) {
  const clean = String(name || '').replace(/[^\w-]/g, '')
  if (!clean) return ''
  const max = Math.max(2000, Number(cfg.skillAutoLoadChars) || 8000)
  for (const root of [cfg.codexSkills, join(DSH_HOME, 'skills')]) {
    if (!root) continue
    for (const p of [join(root, clean, 'SKILL.md'), join(root, `${clean}.md`)]) {
      try {
        if (!existsSync(p)) continue
        const raw = readFileSync(p, 'utf8')
        const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
        if (body) return body.slice(0, max)
      } catch { /* 读不了换下一个候选 */ }
    }
  }
  return ''
}

function formatSkillBlock(hits, cfg) {
  const top = Math.max(1, Number(cfg.memorySkillTopN) || 3)
  const list = (hits || []).slice(0, top)
  if (!list.length) return ''
  const lines = [
    `<liubian-skills hits="${list.length}">`,
    '说明：以下技能与本轮主题相关（本地技能库语义命中）。需要细节时去 ~/.codex/skills 或 ~/.dsh/skills 读对应技能的 SKILL.md 原文 —— 这里只给名字与摘要，不给全文。',
  ]
  for (const h of list) {
    const sum = clipText(String(h.summary || '').trim(), 200) || '(无摘要)'
    lines.push(`【${h.skill}】相似度 ${Number(h.score).toFixed(2)}｜${sum}`)
  }
  lines.push('</liubian-skills>')
  return lines.join('\n')
}

/** 语义检索技能库（helper skill_index.py 的 search 动作，返回 JSON）。
 *  一次调用扫**两个根**（DSH + Codex），由 helper 合并去重后给 top N。
 *  失败一律返回空数组 —— 技能注入是附加项，缺了不影响日记注入。 */
export async function skillHitsFor(cfg, query) {
  const text = String(query || '').trim()
  if (text.length < 4) return []
  const top = Math.max(1, Number(cfg.memorySkillTopN) || 3)
  try {
    const raw = await runHelperAsync(cfg, 'skill_index', ['search', text.slice(0, 4000)], {
      env: {
        LU_SCRIPTS: cfg.semanticScripts,
        LU_SKILLS_ROOT: `${join(DSH_HOME, 'skills')};${cfg.codexSkills}`,
        LU_SKILL_TOP: String(top),
      },
      timeoutMs: Math.max(15000, Number(cfg.memorySkillTimeoutMs) || 30000),
    })
    const json = JSON.parse(String(raw || '').trim())
    if (json && json.ok && Array.isArray(json.hits)) {
      return json.hits.map(h => ({
        skill: String(h.skill || ''),
        summary: String(h.summary || ''),
        score: Number(h.score) || 0,
      }))
    }
  } catch { /* 技能注入失败就当没有 */ }
  return []
}

/**
 * 双路检索的注入块：查询文本 = 上一轮回答 + 新轮用户问题。
 * 任何一路失败都只是少一路（融合自动化为单路），绝不抛。
 */
export async function memoryRetrieval(cfg, messages, ctx, agent) {
  if (!cfg.memoryInject) return null
  const question = currentPrompt(messages)
  const reply = previousAssistantText(messages)
  if (!question && !reply) return null
  if (String(question).length < (Number(cfg.memoryMinChars) || 8) && !reply) return null

  const query = [
    reply ? `【上一轮回答】\n${clipText(reply, Math.floor((Number(cfg.memoryQueryChars) || 6000) / 2))}` : '',
    question ? `【用户本轮问题】\n${clipText(question, Math.floor((Number(cfg.memoryQueryChars) || 6000) / 2))}` : '',
  ].filter(Boolean).join('\n\n')
  const log = ctx?.logger
  // 记忆遍布 14 个工作区：默认**全局**检索（同一个智能体的历史不该被目录切开）。
  // 想只看当前工作区就把 memoryScope 设成 'workspace'。
  const workspace = String(cfg.memoryScope || 'global').toLowerCase() === 'workspace'
    ? String(cfg.workspace || '')
    : ''

  const t0 = Date.now()
  const topN = Math.max(1, Number(cfg.memoryTopN) || 30)              // 总注入上限（主线 + 关联）
  const seedTop = Math.max(1, Number(cfg.memorySeedTop) || 5)         // 第一跳：前几篇作主线
  const perSeed = Math.max(1, Number(cfg.memoryRelatedPerSeed) || 5)  // 第二跳：每条主线找回几篇关联
  // ① 标签候选（取法与写日记同款：语义选前 N）+ 查询向量 + 命中的技能（并行，互不依赖）
  const picked = await selectDiaryTags(cfg, { human: [question || ''], assistant: [reply || ''], tools: [] }, log)
  const [vec, skillHits] = await Promise.all([
    queryEmbedding(cfg, query),
    skillHitsFor(cfg, query),
  ])
  if (!vec.length && !picked.tags.length && !skillHits.length) return null
  // 让模型从候选里挑 N 个 tag（与语义路**并行**：语义-元数据顺手一起取）。
  const [cand, tagSide] = await Promise.all([
    vec.length
      ? jointQuery(cfg, { workspace, vec, top: Math.max(200, topN * 20), full: false, mode: 'semantic' })
      : Promise.resolve({ ok: true, results: [], semCandidates: 0 }),
    screenQueryTags(cfg, query, picked.tags, log),
  ])
  if (!cand || !cand.ok) log?.warn?.(`[dsh-liubian] 语义路失败：${(cand && cand.error) || '未知'}`)
  // ?融合排序（helper 里算，公式与 full 模式同源。
  const ranked = await jointQuery(cfg, {
    workspace, tags: tagSide.tags, vec, top: Math.max(50, topN * 5), full: false, mode: 'rank',
  })
  if (!ranked || !ranked.ok) {
    log?.warn?.(`[dsh-liubian] 融合排序失败：${(ranked && ranked.error) || '未知'}`)
    return null
  }
  const seeds = (ranked.results || []).slice(0, seedTop)
  if (!seeds.length) {
    log?.info?.(`[dsh-liubian] 联合检索无命中（tags=${tagSide.tags.join('|') || '无'}，语义候选 ${ranked.semCandidates || 0}）`)
    return null
  }
  // 第二跳：用每条主线的向量找回关联日记（纯语义近邻，跨全部工作区）。
  // 失败只退回主线（少一路，绝不抛）。
  const seedKeys = seeds.map(r => `${r.ws}|${r.id}`)
  const relatedRows = []
  const rel = await jointQuery(cfg, {
    workspace: '', mode: 'related', top: perSeed, full: false, seeds: seedKeys,
  })
  if (rel && rel.ok && rel.related) {
    const seen = new Set(seeds.map(r => `${r.ws}#${r.id}`))
    for (const s of seeds) {
      for (const r of (rel.related[`${s.ws}|${s.id}`] || [])) {
        const k = `${r.ws}#${r.id}`
        if (seen.has(k)) continue
        seen.add(k)
        relatedRows.push({
          ws: r.ws, id: r.id, sem: Number(r.sem) || 0, tag: 0,
          score: Number(r.sem) || 0, source: 'related', fromSeed: `${s.ws}|${s.id}`,
        })
      }
    }
  } else {
    log?.warn?.(`[dsh-liubian] 关联跳失败（已退回仅主线）：${(rel && rel.error) || '未知'}`)
  }
  const winners = [...seeds.map(r => ({ ...r, source: 'seed' })), ...relatedRows].slice(0, topN)
  // 按 id 精确取正文（主线 + 关联一起）
  const detail = await jointQuery(cfg, {
    workspace, mode: 'ids', top: winners.length, full: true,
    ids: winners.map(r => `${r.ws}|${r.id}`),   // 用 "ws|id" 串：嵌套数组在序列化路上容易被二次编码
  })
  const got = new Map(((detail && detail.results) || []).map(r => [`${r.ws}#${r.id}`, r]))
  const final = winners.map(w => {
    const d = got.get(`${w.ws}#${w.id}`) || {}
    return { ...w, date: d.date || '', summary: d.summary || '', content: d.content || '', tags: d.tags || [] }
  })
  const block = formatMemoryBlock(final, cfg)
  // 技能命中作为**独立块**附加（只给名字 + 摘要，不给全文）
  const skillBlock = formatSkillBlock(skillHits, cfg)
  // 技能自动装载：语义分超阈值 → 读 SKILL.md 全文随本轮注入并建议使用（每技能每会话只注一次）
  let autoSkill = ''
  if (cfg.skillAutoLoad && skillHits.length && agent) {
    const st = contextStateFor(agent?.session)
    if (!Array.isArray(st.autoLoadedSkills)) st.autoLoadedSkills = []
    const threshold = Number(cfg.skillAutoLoadThreshold) || 0.6
    const maxN = Math.max(1, Number(cfg.skillAutoLoadMax) || 1)
    const pickedSkills = skillHits
      .filter(h => h.score >= threshold && !st.autoLoadedSkills.includes(h.skill))
      .slice(0, maxN)
    for (const hit of pickedSkills) {
      const body = readSkillBody(cfg, hit.skill)
      if (!body) continue
      st.autoLoadedSkills.push(hit.skill)
      autoSkill += (autoSkill ? '\n\n' : '')
        + `<skill_content name="${hit.skill}">\n<skill_resources>\n</skill_resources>\n\n<skill_instructions>\n${body}\n</skill_instructions>\n</skill_content>\n`
        + `【自动装载】当前话题与 ${hit.skill} 技能高度匹配（语义 ${hit.score.toFixed(2)}），全文已注入上文——请按该技能的指令处理本任务，无需再调 skill 工具加载。`
    }
    if (autoSkill) log?.info?.(`[dsh-liubian] 技能自动装载：${pickedSkills.map(h => `${h.skill}(${h.score.toFixed(2)})`).join('、')}，阈值 ${threshold}，已装载 ${st.autoLoadedSkills.length} 个`)
  }
  const tail = [skillBlock, autoSkill].filter(Boolean).join('\n\n')
  log?.info?.(
    `[dsh-liubian] 两级检索命中 ${final.length} 篇（主线 ${seeds.length} + 关联 ${relatedRows.length}）注入 ${block.length} 字`
    + `（模型挑 tag：${tagSide.tags.join('|') || '无'}｜候选 ${picked.tags.length} 个/${picked.mode}`
    + `｜tag 路 ${ranked.tagCandidates || 0} 篇、语义路 ${ranked.semCandidates || 0} 篇｜权重 tag ${ranked.wTag}`
    + `｜top1 ${final[0].id}@${final[0].ws} score=${final[0].score}`
    + `｜技能命中 ${skillHits.length} 个${skillHits.length ? '：' + skillHits.map(h => `${h.skill}(${h.score.toFixed(2)})`).join('、') : ''}`
    + `｜${Date.now() - t0}ms）`,
  )
  return {
    block: tail ? `${block}\n\n${tail}` : block,
    results: final,
    skills: skillHits,
    tags: tagSide.tags,
    mode: picked.mode,
  }
}

/** 查询文本的嵌入向量（本地服务）。失败返回空数组 —— 语义一路缺席，tag 一路照跑。 */
export async function queryEmbedding(cfg, text) {
  const s = String(text || '').trim()
  if (s.length < 4) return []
  const vecs = await embedTexts(cfg, [s.slice(0, 4000)])
  return (vecs && vecs[0]) || []
}

/** 取最后一条助手正文（跳过工具结果、插件消息）。 */
export function previousAssistantText(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i]
    if (!m) continue
    if (m.role !== 'assistant') continue
    const t = messageText(m).trim()
    if (t) return t
  }
  return ''
}

/** 每轮的联合检索注入：去重（同一轮并发 pre-step 只注入一次）+ 失败即静默。 */
async function memoryMessageFor(ctx, cfg, agent, messages, signal) {
  const query = currentPrompt(messages)
  const reply = previousAssistantText(messages)
  if (!query && !reply) return null
  const state = contextStateFor(agent?.session)
  const key = `mem:${String(query).slice(0, 120)}|${String(reply).slice(0, 80)}`
  if (key === state.lastRecallKey) return null
  state.lastRecallKey = key      // 先占位再 await，防同轮重复检索
  const r = await memoryRetrieval(cfg, messages, ctx, agent)
  if (!r || !r.block || signal?.aborted) return null
  state.recallCount += 1
  return pluginMessage(r.block, 'recall')
}

export function mountContextInjection(ctx, cfg) {
  ctx.logger?.info?.(
    `[dsh-liubian] 上下文插入：身份卡=${cfg.profileInject ? '开' : '关'}`
    + ` 两级检索注入=${cfg.memoryInject ? `开（主线 ${cfg.memorySeedTop} + 各 ${cfg.memoryRelatedPerSeed} 关联，封顶 ${cfg.memoryTopN}）` : '关'}`
    + ` 消息构造器=${createUserMessageFn ? 'dsh-llm' : '内置回退'}`,
  )

  // 会话开头：把身份卡塞进去（对应 OpenViking 的 injectStartupProfile）
  ctx.on('agent/session-start', ({ agent }) => {
    void takeProfileMessage(cfg, agent)
      .then(message => {
        if (!message) return
        if (agent?.status && agent.status !== 'idle') return // 忙就交给 pre-step 那条。
        try {
          agent.inject(message)
        } catch (err) {
          ctx.logger?.debug?.(`[dsh-liubian] inject 失败：${(err && err.message) || err}`)
        }
      })
      .catch(() => {})
  })

  // 每轮：身份卡（若会话开头没送成）+ 联合检索注入，追加在最终消息尾部。
  // prepend: true 让下游的 pre-step 监听先跑，本插件看到的是最终消息批次。
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    // ⚠️ 监听器里抛出的异常会让**整个 run 失败**（stylotrace 的 runtimeAgentModel 事故就是这么炸的：
    // 一个挂在每次模型请求上的钩子抛错，代价是每个会话每一轮都跑不完）。
    // 上下文插入只是附带功能，绝不能拖垮用户这一轮 —— 所以整段兜住，出错就当没插入。
    try {
      if (!decision || decision.kind !== 'enter' || signal?.aborted) return decision
      const state = contextStateFor(agent?.session)
      const additions = []
      const profile = await takeProfileMessage(cfg, agent)
      if (profile) additions.push(profile)
      const mem = await memoryMessageFor(ctx, cfg, agent, decision.messages, signal)
      if (mem) additions.push(mem)
      // 教训周期重注：每 N 轮新人类输入后重发教训块（接入卡只在会话开始注一次，教训需要定期提醒）
      const lessonPrompt = currentPrompt(decision.messages)
      if (lessonPrompt && lessonPrompt !== state.lessonsLastKey && state.profileDelivered) {
        state.lessonsLastKey = lessonPrompt
        const every = Math.max(0, Number(cfg.lessonsEveryTurns) || 0)
        if (every > 0) {
          state.lessonsCounter += 1
          if (state.lessonsCounter >= every) {
            state.lessonsCounter = 0
            const ws = resolveDiaryWorkspace(cfg, agent)
            const lessonsAgain = [
              buildLessonsBlock(cfg, 'global'),
              buildLessonsBlock(cfg, 'workspace', ws),
              buildCapabilitiesBlock(cfg),   // 能力卡：周期提醒，模型才想得起主动调
            ].filter(Boolean).join('\n\n')
            if (lessonsAgain) additions.push(pluginMessage(lessonsAgain, 'recall'))
          }
        }
      }
      // 反反驳自查提醒：**每一轮对话都注入**（一次一轮）。
      // 用「人类消息条数」计轮而非内容比对——用户连发两遍同样的话也各算一轮、各注一次；
      // 同一步重试时条数不变，天然防重复。注在 additions 末尾（离生成点最近）。
      const humanCount = (decision.messages || []).filter(m => isHumanMessage(m)).length
      if (humanCount > 0 && humanCount !== state.turnReminderCount) {
        state.turnReminderCount = humanCount
        const reminder = buildTurnReminder(cfg)
        if (reminder) additions.push(pluginMessage(reminder, 'recall'))
      }
      // 自动日记：**只在"新一轮的第一步"**触发（同一轮内的后续步 currentPrompt 为空），
      // 写的是上一轮，且 fire-and-forget —— API 调用耗时几秒，绝不能卡住本轮。
      if (currentPrompt(decision.messages)) scheduleDiaryFlush(ctx, cfg, agent)
      if (additions.length === 0 || signal?.aborted) return decision
      return { kind: 'enter', messages: [...decision.messages, ...additions] }
    } catch (err) {
      ctx.logger?.warn?.(`[dsh-liubian] 上下文插入失败（已忽略，不影响本轮）}${(err && err.message) || err}`)
      return decision
    }
  }, { prepend: true })
}

export function disposeContextInjection() {
  contextStates.clear()
}

/** 纯函数测试缝（自检 / 诊断用，不参与运行时）。 */
export const __test = {
  candidateTags,
  estimateTokens,
  clipText,
  messageText,
  promptText,
  isFreshUserPrompt,
  isOurMessage,
  isPluginMessage,
  isHumanMessage,
  currentPrompt,
  pluginMessage,
  resolveConfig,
  tagDictionary,
  // - 联合索（纯函数，自检用）-
  screenQueryTags,
  retrievalApiConfig,
  jointQuery,
  fuseScores,
  memoryRetrieval,
  queryEmbedding,
  previousAssistantText,
  formatMemoryBlock,
  formatSkillBlock,
  skillHitsFor,
  readSkillBody,
  buildProfileBlock,
  // - 全局通用教训 -
  loadLessons,
  buildLessonsBlock,
  generateLessons,
  // - 能力卡 -
  buildCapabilitiesBlock,
  loadCapabilities,
  discoverInstalled,
  // - 逐轮提醒 -
  buildTurnReminder,
  // - 自动日记（纯函数，自用）-
  diaryConfig,
  normalizeDiaryUrl,
  saveDiaryConfig,
  diaryConfigFile,
  buildDiaryPayload,
  normalizeEntries,
  isWritableEntry,
  splitContent,
  resolveDiaryWorkspace,
  allTagsFor,
  selectDiaryTags,
  semanticTagHints,
  tagVectors,
  warmTagVectors,
  embedTexts,
  tagSignature,
  takeUnwrittenTurn,
}

/* ──────────────────────────────────────────────────────────────────────────
 * 6. 自动日记 —— 由外部 API 撰写，**下一轮写上一轮**
 *
 * 用户定的规格：
 *   1. 触发：下一轮开始时写上一轮（不是 turn/end 立刻写）
 *   2. 每一轮都要写；**末轮由下一轮代写**，本插件不做收尾兜底
 *   3. 仍按工作区署名
 *   4. 标签字典随输入送过去：**优先复用已有标签，允许新建**
 *   5. 输入 = 上一轮的**完整对话**（提问 + 助手正文 + 工具轨迹）
 *   6. 每篇正文 ≤500 字，超了就**再新建一篇**；一轮几篇**不设上限**
 *   7. 失败不阻塞对话：落 pending 队列、下轮补写
 *   8. 启用后不再手动写日记
 *
 * 采集与写入分离：轮次内容用 `session/event` 累积（免疫上下文压缩），
 * 写入时机只有一处 —— pre-step（下轮的第一步）。 * ────────────────────────────────────────────────────────────────────────── */

export function diaryConfigFile() { return join(DSH_HOME, 'liubian', 'diary.json') }
export function diaryLogFile() { return join(DSH_HOME, 'liubian', 'auto_diary_log.jsonl') }
export function diaryPendingFile() { return join(DSH_HOME, 'liubian', 'pending_diaries.jsonl') }

export const DIARY_DEFAULTS = {
  enabled: false,
  url: 'https://api.deepseek.com/chat/completions',
  apiKey: '',
  model: 'deepseek-flash',
  temperature: 0.3,
  maxTokens: 4096,
  jsonMode: true,
}

/**
 * 检索侧外部 API 的配置（与写日记**分开的 key**）。
 *
 * 用户规格（2026-09-12）：检索日记走另一个 API（基址同 DeepSeek）。
 * 检索侧只有一处外部调用：`screenQueryTags` —— 让模型从候选标签里挑 N 个 tag。
 * 语义向量那一路走的是**本地**嵌入服务（llama.cpp:8082），不经外部 API。
 *
 * 回退规则：`memoryApiKey` 为空 → 用写日记那把 key，这样只配写日记也能直接跑，
 * 不会因为漏配而让检索整条失效。
 */
export function retrievalApiConfig(cfg, dc) {
  const d = dc || diaryConfig()
  const key = String(cfg.memoryApiKey || '').trim() || String(d.apiKey || '').trim()
  return {
    url: normalizeDiaryUrl(cfg.memoryApiUrl || d.url || DIARY_DEFAULTS.url),
    apiKey: key,
    model: String(cfg.memoryApiModel || '').trim() || d.model || DIARY_DEFAULTS.model,
    temperature: 0.2,                     // 挑标签要稳，别发散
    maxTokens: Math.max(512, Number(d.maxTokens) || 4096),
    jsonMode: cfg.memoryApiJsonMode !== false,
    timeoutMs: Math.max(20000, Number(cfg.memoryApiTimeoutMs) || Number(cfg.memoryTimeoutMs) || 60000),
    source: String(cfg.memoryApiKey || '').trim() ? 'memoryApiKey' : 'diary-key(fallback)',
  }
}

export function diaryConfig() {
  const cfg = { ...DIARY_DEFAULTS, ...readJson(diaryConfigFile()) }
  cfg.url = normalizeDiaryUrl(cfg.url)
  return cfg
}

/**
 * 端点容错：用户/文档里给的多半是**基址**（`https://api.deepseek.com`、
 * `.../v1`），但真正要 POST 的是 `{基址}/chat/completions`。
 * 这里统一补齐，省得因为少一段路径白折腾一轮。
 */
export function normalizeDiaryUrl(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '')
  if (!u) return DIARY_DEFAULTS.url
  if (/\/chat\/completions$/.test(u)) return u
  if (/\/v\d+$/.test(u)) return `${u}/chat/completions`
  return `${u}/chat/completions`
}

export function saveDiaryConfig(patch) {
  const next = { ...readJson(diaryConfigFile()), ...patch }
  const file = diaryConfigFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
  return next
}

function maskKey(k) {
  const s = String(k || '')
  return s ? `${s.slice(0, 6)}…${s.slice(-4)}（${s.length} 字符）` : '(未配置)'
}

/* - 轮次缓冲（session/event 累积）─------------------------------------------------------------ */

const turnBuffers = new Map()
const writtenKeys = new Set()   // `${sessionId}#${turn}` 幂等
const diaryInFlight = new Set() // 正在写库的 `${sessionId}#${turn}`（防写重）
function bufferFor(sessionId) {
  let buf = turnBuffers.get(sessionId)
  if (!buf) {
    buf = { sealed: [], current: null }
    turnBuffers.set(sessionId, buf)
  }
  return buf
}

function loadWrittenKeys() {
  try {
    const lines = readFileSync(diaryLogFile(), 'utf8').replace(/^\uFEFF/, '').split('\n')
    for (const line of lines.slice(-500)) {
      if (!line.trim()) continue
      try {
        const o = JSON.parse(line)
        // 只收「确实写成功」的轮次：整轮失败的记录不在日志里，但万一有，也别把它当已写。
        if (o.session && o.turn !== undefined && (o.entries || []).some(e => e && e.id)) {
          writtenKeys.add(`${o.session}#${o.turn}`)
        }
      } catch { /* 坏行忽略 */ }
    }
  } catch { /* 日志还不存在 */ }
}

/** 幂等键只留最近的 500 个：Set 无上限，长跑会把每个会话每轮的键都攒住。 */
function rememberWritten(key) {
  writtenKeys.add(key)
  if (writtenKeys.size <= 500) return
  let i = writtenKeys.size - 500
  for (const k of writtenKeys) {
    writtenKeys.delete(k)
    if (--i <= 0) break
  }
}

function turnText(turn) {
  return [turn.human.join('\n'), turn.assistant.join('\n')].join('\n').trim()
}

/** 取"最近一个已封口、且还没写过"的轮次。 */
export function takeUnwrittenTurn(sessionId) {
  const buf = turnBuffers.get(String(sessionId))
  if (!buf) return null
  for (let i = buf.sealed.length - 1; i >= 0; i -= 1) {
    const t = buf.sealed[i]
    if (!writtenKeys.has(`${sessionId}#${t.turn}`)) return t
  }
  return null
}

/* - 提示词 ------------------------------------------------------------ */

function buildDiarySystemPrompt(cfg) {
  const max = Number(cfg.diaryMaxChars) || 500
  return [
    '你是「流变·记忆系统」的日记撰写员。输入是某个智能体与用户之间**一轮完整对话**，',
    '你要把它写成可长期检索的记忆日记，只输出 JSON',
    '',
    '输出格式（严格 JSON，不要代码块围栏，不要任何解释）：',
    '{"diaries":[{"tags":["标签1","标签2","标签3","标签4","标签5"],"summary":"一句话摘要","content":"正文"}]}',
    '',
    '硬规则：',
    `1. 每篇 content **不超过 ${max} 字**（中文按字符计）。这一轮内容多就拆成多篇，篇数**不设上限**：`,
    '   按阶段/主题拆（例如"做了什么"、"结论与产物"、"踩的坑"），不要同一段话复制两遍。',
    '   宁可多写几篇短的，也不要把一堆不同主题挤进一篇里。',
    '2. 每篇 tags **至少 5 个**。用户消息里会给出**记忆库现有标签的全表**；',
    '   **先从全表里挑**：语义对得上的就**原样逐字复制**，不要改写成近义词、不要加前后缀',
    '   （写成"注入缺id"而库里已有"注入消息缺id"＝白造一个重复标签）。',
    '   全表里确实一个语义对得上的都没有，才新建；新建的标签要**细、具体**。',
    '   全表已按使用次数从高到低排列，越靠前越是库里通用的叫法。',
    '3. 「禁止宽泛标签」只约束**新建**的标签：技能、规则、经验、讨论、实现、设计、测试、配置、',
    '   问题、工作、文件、项目——不要拿这些当新标签。但全表里**已有**的高频标签（如"技能""规则"）',
    '   照用不误：复用已有的就是让检索走得通，比追求"标签好看"重要得多。',
    '4. summary 一句话，≤60 字，写清"这轮干了什么/得到什么结论"。',
    '5. content 只写实质：做了什么、结论是什么、产物路径、踩到的坑、待办。',
    '   不要客套话、不要复述对话原文、不要写"用户说…我回答…"这类流水账。',
    '6. 不要编造没发生的事；对话里没确定的就写"未确认"。',
    '7. 语言与对话一致（通常中文）。',
    '',
    '判断标准：只看 tags + summary，别人能不能猜到这篇写了什么？猜不到就是写废了。',
  ].join('\n')
}

function buildDiaryUserPrompt(cfg, turn, hints, workspace) {
  const cap = Number(cfg.diaryMaxInputChars) || 12000
  const parts = []
  parts.push(`[工作区] ${workspace}`)
  parts.push(`[轮次] ${turn.turn}（结束状态：${turn.reason || 'unknown'}）`)
  if (hints.length) {
    parts.push(
      `[全部已有标签：${hints.length} 个，已按使用次数从高到低排列]\n${hints.join('、')}\n`
      + '[标签用法] 这是记忆库里的**全部**标签。逐字复用你需要的（原样复制，不要改写成近义词）；'
      + '只有确认一个语义对得上的都没有时，才新建标签。',
    )
  } else {
    parts.push('[已有标签] （字典读取失败，可自行新建细小标签）')
  }

  let human = turn.human.join('\n\n').trim()
  let assistant = turn.assistant.join('\n\n').trim()
  const tools = cfg.diaryIncludeTools && turn.tools.length
    ? `\n[本轮工具轨迹] ${[...new Set(turn.tools)].join('、')}`
    : ''

  let body = `\n\n[上一轮完整对话]\n=== 用户 ===\n${human}\n\n=== 助手 ===\n${assistant}${tools}`
  if (body.length > cap) {
    // 超长只截助手正文的尾部（提问通常短，必须保住）
    const keep = cap - (human.length + tools.length + 200)
    assistant = assistant.slice(0, Math.max(1000, keep)) + '\n…（本轮助手正文过长，已截断）'
    body = `\n\n[上一轮完整对话]\n=== 用户 ===\n${human}\n\n=== 助手 ===\n${assistant}${tools}`
  }
  parts.push(body)
  return parts.join('\n')
}

/**
 * 完整流程的第 2 步：把**全部标签表**取出来随对话送进 API。
 * 用户定的规则（2026-09-12）：与其费劲算"关联度"挑 200 个，不如直接把全表送过去
 * —— 模型拿到全量词表才能真的做到"优先复用已有标签"，挑选本来就该由模型做。
 * 顺序按使用次数降序，万一日后需要截断（`diaryTagHints` > 0 时按字符预算截尾部），
 * 丢掉的是最冷门的标签，而不是字母序靠前的那批。
 */
export async function allTagsFor(cfg) {
  const dict = await tagDictionary(cfg)
  if (!dict || !dict.names.length) return []
  const counts = dict.counts || null
  const names = []
  const seen = new Set()
  for (const raw of dict.names) {
    const s = String(raw || '').trim()
    if (s.length < 2) continue     // 单字标签（如「桥」）本身是噪声，别拿去当词表
    if (seen.has(s)) continue
    seen.add(s)
    names.push(s)
  }
  if (counts) names.sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0) || a.length - b.length)
  else names.sort((a, b) => a.length - b.length)

  const budget = Number(cfg.diaryTagHints) || 0
  if (budget <= 0) return names
  const cut = []
  let used = 0
  for (const n of names) {
    used += n.length + 1
    if (used > budget) break
    cut.push(n)
  }
  return cut
}

/* ── 语义选标签：助手正文 → 向量 → 与标签向量算余弦 → 取前 N（用户 2026-09-12 定的方案）
 * 为什么不用标签名去嵌入-是嵌入**助手正文**：正文是整个回答，信息量大；
 * 标签名平均只有几个字，短文本嵌入的区分度差（实测时它们之间的余弦普遍在 0.5 以上）。
 * 成本控制的关键：**标签的向量只算一次，落盘缓存**。
 *   13930 个标签 × 1024 维 float32 ≈ 57MB，缓存文件放在 ~/.dsh/liubian/ 下；
 *   缓存的有效性由「标签个数 + 高频标签名 + 低频标签名」三元的签名判定
 *   （字典是按使用次数降序的，这三元一变就说明标签表变了，重建）。
 *   真正每轮的开销只有 1 次嵌入调用 + 13930 次点积，毫秒级。
 *   首次（或标签表变化后）建缓存要 1~2 分钟：**后台建，不阻塞对话**，这一轮退回整张表。
 *
 * 顺序仍是余弦降序，所以日后要截断也是从尾部砍（最不相关的先丢） * ------------------------------------------------------------ */

/** 标签向量缓存文件（二进制，别当文本读）。 */
export function tagVecFile() { return join(DSH_HOME, 'liubian', 'tag_vectors.bin') }

/**
 * 标签表签名：**只要"标签集合大致没变"就认缓存**? *
 * ⚠️ 踩过的坑（两个，都实测过）：
 *   · 原来只按"首次"建缓存，标签表一变签名对不上 → 缓存永远失效、每轮静默回退整张表，
 *      语义选标签悄悄死掉（已改为签名不符就重建）
 *   · 原来把**全表**哈希进签名 → 签名永远对不上，因为库里 count=1 的标签占绝大多数，
 *      它们的相对顺序受其它会话并发写影响的尾部抖动，就能让全表哈希每次都变，
 *      结果每轮都判缓存失效 → 每 60 秒重建一次 54MB 向量，比不用缓存还糟
 * 所以签名只取**稳定的部分**：标签个数 + 高频的前 8 个名字
 * 缓存里存它自己那份 names，运行期一律以缓存的 names 为准（自洽），
 * 不从实时表的位置去索引向量 —— 这样排序抖动不会错配向量，
 * 而真正的增删标签（个数变化 / 头部变化）会如实触发重建。
 */
function tagSignature(names) {
  const head = names.slice(0, 8).join('\u0001')
  return `${names.length}|${head}`
}

let tagVecMemo = null   // { sig, names, dim, vecs: Float32Array, at }
let tagVecBuilding = false

/** 调本地嵌入服务（llama.cpp /v1/embeddings，qwen3-emb，1024 维）。 */
async function embedTexts(cfg, texts, timeoutMs = 120000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(cfg.diaryTagEmbedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.diaryTagEmbedModel, input: texts.map(t => String(t).slice(0, 600)) }),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const data = JSON.parse(await res.text())
    const list = (data && data.data) || []
    const vecs = list.map(d => d.embedding)
    if (!vecs.length || !Array.isArray(vecs[0])) return null
    return vecs
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 读缓存文件。**只校验维度和体量，不校验标签集合** —— 集合差集由调用方算
 *  missing 做**增量补向量**（2026-09-14 根因修复：全量重建是内存放大器的根源，
 *  底层 llama-server b10405 每请求滞留提交内存 ~1.2MB/批量请求，全量重建 13930 个
 *  标签 = ~435 请求 ≈ 0.5GB/次，标签一多就反复重建 → 数小时攒到 10.9GB）。 */
function loadTagVecCache(cfg, dim) {
  try {
    const file = tagVecFile()
    if (!existsSync(file)) return null
    const buf = readFileSync(file)
    const nl = buf.indexOf(0x0a)
    if (nl <= 0) return null
    const meta = JSON.parse(buf.slice(0, nl).toString('utf8'))
    if (!meta) return null
    const d = Number(meta.dim) || Number(cfg.diaryTagEmbedDim) || 1024
    if (d !== Number(dim)) return null                 // 维度变了 → 只能全量重建
    const body = buf.slice(nl + 1)
    const n = Number(meta.n) || 0
    if (n <= 0 || body.length < n * d * 4) return null
    const cachedNames = Array.isArray(meta.names) ? meta.names : []
    if (cachedNames.length !== n) return null
    // Buffer 可能不是 4 字节对齐的，必须 copy 一份再当 Float32Array 用
    const copy = new Uint8Array(body.slice(0, n * d * 4))
    return { sig: meta.sig || '', names: cachedNames, dim: d, vecs: new Float32Array(copy.buffer), at: Date.now() }
  } catch {
    return null
  }
}

function saveTagVecCache(sig, names, dim, vecs) {
  try {
    const file = tagVecFile()
    mkdirSync(dirname(file), { recursive: true })
    const meta = Buffer.from(JSON.stringify({ sig, n: names.length, dim, names, at: new Date().toISOString() }) + '\n', 'utf8')
    writeFileSync(file, Buffer.concat([meta, Buffer.from(vecs.buffer, vecs.byteOffset, vecs.byteLength)]))
  } catch { /* 落盘失败就每轮重算，不影响功能 */ }
}

/** 逐个回调式建缓存（避免一次把 57MB 都堆在临时数组里）。 */
async function buildTagVecCache(cfg, sig, names, dim, log) {
  const vecs = new Float32Array(names.length * dim)
  const batch = Math.max(4, Number(cfg.diaryTagEmbedBatch) || 32)
  let done = 0
  for (let start = 0; start < names.length; start += batch) {
    const chunk = names.slice(start, start + batch)
    const out = await embedTexts(cfg, chunk)
    if (!out || out.length !== chunk.length) {
      log?.warn?.(`[dsh-liubian] 标签向量建缓存中断（已写 ${start} 个），下轮重试`)
      return null
    }
    out.forEach((v, i) => {
      const at = (start + i) * dim
      let sum = 0
      for (let k = 0; k < dim; k += 1) { const x = Number(v[k]) || 0; vecs[at + k] = x; sum += x * x }
      const norm = Math.sqrt(sum) || 1e-9
      for (let k = 0; k < dim; k += 1) vecs[at + k] /= norm      // 预归化：之后只需点积
    })
    done += chunk.length
    if (done % (batch * 10) < batch) log?.info?.(`[dsh-liubian] 标签向量缓存 ${done}/${names.length}`)
  }
  saveTagVecCache(sig, names, dim, vecs)
  log?.info?.(`[dsh-liubian] 标签向量缓存建好：${names.length} 个标签（${(vecs.byteLength / 1048576).toFixed(1)}MB）`)
  return { sig, names, dim, vecs, at: Date.now() }
}

/** 增量补向量：只嵌入**新增**的标签，追加进现有缓存（根因修复，见 loadTagVecCache）。
 *  新标签通常一次几十个 → 一两个批量请求、几 MB，而不是全量 13930 个 ≈ 0.5GB。 */
async function appendTagVecCache(cfg, cached, missing, dim, log) {
  const batch = Math.max(4, Number(cfg.diaryTagEmbedBatch) || 32)
  const newNames = cached.names.concat(missing)
  const newVecs = new Float32Array(newNames.length * dim)
  newVecs.set(cached.vecs)                       // 旧向量原样（已归一化）
  let done = 0
  for (let start = 0; start < missing.length; start += batch) {
    const chunk = missing.slice(start, start + batch)
    const out = await embedTexts(cfg, chunk)
    if (!out || out.length !== chunk.length) {
      log?.warn?.(`[dsh-liubian] 标签向量增量中断（已补 ${done}/${missing.length}），下轮继续`)
      return null                                // 不落盘：旧缓存文件原样，下轮重试
    }
    out.forEach((v, i) => {
      const at = (cached.names.length + start + i) * dim
      let sum = 0
      for (let k = 0; k < dim; k += 1) { const x = Number(v[k]) || 0; newVecs[at + k] = x; sum += x * x }
      const norm = Math.sqrt(sum) || 1e-9
      for (let k = 0; k < dim; k += 1) newVecs[at + k] /= norm
    })
    done += chunk.length
  }
  const sig = tagSignature(newNames)
  saveTagVecCache(sig, newNames, dim, newVecs)
  log?.info?.(`[dsh-liubian] 标签向量缓存增量完成：+${missing.length}（共 ${newNames.length}，${(newVecs.byteLength / 1048576).toFixed(1)}MB）`)
  return { sig, names: newNames, dim, vecs: newVecs, at: Date.now() }
}

/**
 * 取标签向量缓存。命中内存/磁盘就直接用；没有就在**后台**建，本次返回 null
 * （调用方回整张标签表，绝不因为建缓存卡住某一轮对话）。 */
export async function tagVectors(cfg, log) {
  const names = await allTagsFor(cfg)
  if (!names.length) return null
  const sig = tagSignature(names)
  if (tagVecMemo && tagVecMemo.sig === sig) return tagVecMemo
  const dim = Number(cfg.diaryTagEmbedDim) || 1024
  const cached = loadTagVecCache(cfg, dim)
  if (cached) {
    // 集合差集判定（不再靠签名）：缺几个就只补几个，追加进缓存。
    const have = new Set(cached.names)
    const missing = names.filter(n => !have.has(n))
    if (missing.length === 0) {
      tagVecMemo = { ...cached, sig }
      return tagVecMemo
    }
    // 增量补向量（后台），本轮先用旧缓存（新标签少算几个候选而已，不阻塞）
    if (!tagVecBuilding) {
      tagVecBuilding = true
      log?.info?.(
        `[dsh-liubian] 标签表新增 ${missing.length} 个标签，增量补向量（全量 ${names.length}，而非重算全部）`,
      )
      void (async () => {
        try {
          const built = await appendTagVecCache(cfg, cached, missing, dim, log)
          if (built) tagVecMemo = built
        } catch (err) {
          log?.warn?.(`[dsh-liubian] 标签向量增量构建失败（下轮重试）：${(err && err.message) || err}`)
        } finally {
          tagVecBuilding = false
        }
      })()
    }
    return cached   // 旧缓存仍可用（缺新标签的向量，语义选标签少算几个而已）
  }
  // 缓存文件不存在 / 维度变了 → **必须全量重建**。
  // ⚠️ 踩过的坑：这里原来只"首次"建一次，于是标签表一变签名对不上，
  // 缓存就永远失效 → 每轮都静默退回整张标签表，语义选标签悄悄死掉。
  if (!tagVecBuilding) {
    tagVecBuilding = true
    const hadCache = existsSync(tagVecFile())
    log?.info?.(
      `[dsh-liubian] ${hadCache ? '标签向量缓存维度变化，重建' : '首次建立'}标签向量缓存：`
      + `${names.length} 个标签（约 1~2 分钟，期间先用整张标签表；之后自动切回语义选标签）`,
    )
    void (async () => {
      try {
        const built = await buildTagVecCache(cfg, sig, names, dim, log)
        if (built) tagVecMemo = built
      } catch (err) {
        log?.warn?.(`[dsh-liubian] 标签向量缓存构建失败（下轮会重试）：${(err && err.message) || err}`)
      } finally {
        tagVecBuilding = false
      }
    })()
  }
  return null
}

/**
 * 语义选标签：把助手正文嵌成一个向量，与标签向量逐个点积（都已归一化 ⇒ 就是余弦），
 * 取前 topN 个标签。任何一步失败（服务没起 / 缓存没建好）都返回 null，
 * 由调用方退回整张表 —— 语义选标签是**优化**，绝不是依赖。
 */
export async function semanticTagHints(cfg, text, log) {
  const query = String(text || '').trim()
  if (query.length < 4) return null      // 太短嵌了也没区分。
  const tv = await tagVectors(cfg, log)
  if (!tv) return null
  const dim = tv.dim
  const q = await embedTexts(cfg, [query.slice(0, 4000)])
  if (!q || !q[0]) return null
  const qv = new Float32Array(dim)
  let sum = 0
  for (let k = 0; k < dim; k += 1) { const x = Number(q[0][k]) || 0; qv[k] = x; sum += x * x }
  const qn = Math.sqrt(sum) || 1e-9
  for (let k = 0; k < dim; k += 1) qv[k] /= qn

  const n = tv.names.length
  const scores = new Float32Array(n)
  for (let i = 0; i < n; i += 1) {
    const base = i * dim
    let dot = 0
    for (let k = 0; k < dim; k += 1) dot += qv[k] * tv.vecs[base + k]
    scores[i] = dot
  }
  const topN = Math.max(1, Number(cfg.diaryTagTopN) || 100)
  const idx = Array.from({ length: n }, (_, i) => i)
  idx.sort((a, b) => scores[b] - scores[a] || tv.names[a].length - tv.names[b].length)
  return idx.slice(0, Math.min(topN, n)).map(i => ({ tag: tv.names[i], score: scores[i] }))
}

/**
 * 统一的本轮标签选择入口：
 *   semantic → 正文向量取前 N；失败或缓存未就绪则退整张表
 *   all      → 整张表（按使用次数降序）
 *   none     ?不给（让模型完全自创，仅调试用）
 */
export async function selectDiaryTags(cfg, turn, log) {
  const mode = String(cfg.diaryTagSelect || 'semantic').toLowerCase()
  if (mode === 'none') return { tags: [], mode: 'none' }
  if (mode === 'all') return { tags: await allTagsFor(cfg), mode: 'all' }
  // 语义优先用助手正文；正文为空（纯工具轮）才回用户提。
  const text = (turn.assistant.join('\n').trim() || turn.human.join('\n').trim())
  const hits = await semanticTagHints(cfg, text, log)
  if (hits && hits.length) {
    return { tags: hits.map(h => h.tag), mode: 'semantic', scored: hits }
  }
  return { tags: await allTagsFor(cfg), mode: 'all(fallback)' }
}

export async function buildDiaryPayload(cfg, turn, hints, workspace) {
  // hints 给空就自己去拿（走统入口：语义优先，失败回整张表。
  const tags = (Array.isArray(hints) && hints.length) ? hints : await selectDiaryTags(cfg, turn).then(r => r.tags)
  return {
    messages: [
      { role: 'system', content: buildDiarySystemPrompt(cfg) },
      { role: 'user', content: buildDiaryUserPrompt(cfg, turn, tags, workspace) },
    ],
    hints: tags,
    meta: {
      turn: turn.turn,
      workspace,
      toolCalls: [...new Set(turn.tools)].length,
      chars: turnText(turn).length,
      tagCount: tags.length,
    },
  }
}

/* - 旧的"算关联度挑 200 个标签"方案已于 2026-09-12 废弃 ------------------------------------------------------------
 * 理由：挑选本来就该由模型做。插件按字面重合度预先筛掉 13k→200，等于在把
 * 候选喂给模型之前先替它做了判断，还容易挑偏。现在改成把**全表**送进去。
 * 召回（recall）链路仍用 candidateTags 挑 tag，未受影响。
 */

/* - 调用外部 API ------------------------------------------------------------ */

function parseJsonLoose(text) {
  let s = String(text || '').trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  try { return JSON.parse(s) } catch { /* 再试掐头去尾 */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)) } catch { /* 放弃 */ }
  }
  return null
}

async function postDiaryApi(dc, payload, useJsonMode) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number(dc.timeoutMs) || 120000)
  try {
    const body = {
      model: dc.model,
      temperature: Number(dc.temperature) || 0.3,
      max_tokens: Number(dc.maxTokens) || 4096,
      messages: payload.messages,
    }
    if (useJsonMode) body.response_format = { type: 'json_object' }
    const res = await fetch(dc.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dc.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const raw = await res.text()
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}: ${raw.slice(0, 300)}` }
    const data = JSON.parse(raw)
    const choice = (data && data.choices && data.choices[0]) || {}
    const content = (choice.message && choice.message.content) || ''
    const parsed = parseJsonLoose(content)
    if (!parsed) {
      return { ok: false, status: res.status, error: `未返回可解析的 JSON：${String(content).slice(0, 200)}`, raw: String(content).slice(0, 400) }
    }
    // 本调用通道有三个消费方：写日记（{"diaries":[...]}）、检索挑标签（{"tags":[...]}）、
    // 通用教训蒸馏（{"lessons":[...]}）。都放行，由调用方各取所需。
    if (!Array.isArray(parsed.diaries) && !Array.isArray(parsed.tags) && !Array.isArray(parsed.lessons)) {
      return { ok: false, status: res.status, error: `未返回预期 JSON：${String(content).slice(0, 200)}`, raw: String(content).slice(0, 400) }
    }
    return {
      ok: true,
      entries: parsed.diaries,
      tags: parsed.tags,
      lessons: parsed.lessons,
      workspace: parsed.workspace,
      usage: data.usage,
    }
  } catch (err) {
    return { ok: false, error: (err && err.name === 'AbortError') ? '调用超时' : ((err && err.message) || String(err)) }
  } finally {
    clearTimeout(timer)
  }
}

export async function callDiaryApi(cfg, dc, payload) {
  const first = await postDiaryApi({ ...dc, timeoutMs: cfg.diaryTimeoutMs }, payload, dc.jsonMode !== false)
  // 某些端点不认 response_format：只在 400 时退一次，避免无谓重试
  if (!first.ok && first.status === 400 && dc.jsonMode !== false) {
    const retry = await postDiaryApi({ ...dc, timeoutMs: cfg.diaryTimeoutMs }, payload, false)
    if (retry.ok) retry.degradedJsonMode = true
    return retry
  }
  return first
}

/* ── 结果归一化：字数上限 / 标签补足 ──────────────────────────────────── */

/** 按句末标点把长文切成 ≤max 的块（切不动就硬切）。 */
export function splitContent(text, max) {
  const s = String(text || '').trim()
  if (s.length <= max) return [s]
  const chunks = []
  let rest = s
  while (rest.length > max) {
    const window = rest.slice(0, max)
    const cut = Math.max(
      window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'),
      window.lastIndexOf('\n'), window.lastIndexOf('；'),
    )
    const at = cut > max * 0.5 ? cut + 1 : max
    chunks.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) chunks.push(rest)
  return chunks.filter(Boolean)
}

/**
 * 归一化：切长 + 标签补足。
 * ⚠️ 这里有个必须守住的底线：后端的硬规则是每篇 ≥5 个标签，标签不够时**必须重试**，
 * **绝不**拿提示词里的标签表头部去凑 —— 那是常用的标签（银砂纪年/被炉/规则…），
 * 与本篇内容毫无关系，补进去等于往检索索引里灌噪声。所以：
 *   · 模型自己给的标签 ? ??直接用；
 *   · 只有 1~4 个 → **原样保留**（宁可少于 5 个，也不塞假标签），由上层决定重试。
 * 返回的每篇带 `tagCount`，调用方据此判断"这篇够不够格写库"。
 */
export function normalizeEntries(cfg, raw, hints) {
  const maxChars = Number(cfg.diaryMaxChars) || 500
  const out = []
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue
    const tags = [...new Set((Array.isArray(item.tags) ? item.tags : [])
      .map(t => String(t || '').trim().replace(/^#/, ''))
      .filter(t => t.length >= 2))]
    const summary = String(item.summary || '').trim().slice(0, 120) || '(无摘要)'
    const content = String(item.content || '').trim()
    if (!content) continue
    const chunks = splitContent(content, maxChars)
    chunks.forEach((c, i) => {
      out.push({
        tags,
        tagCount: tags.length,
        summary: chunks.length > 1 ? `${summary}}${i + 1}/${chunks.length}）` : summary,
        content: c,
      })
    })
  }
  return out
}

/** 一篇够不够格写库：标签必须 ≥5（后端硬规则），否则不写 —— 不拿假标签凑数。 */
export function isWritableEntry(e) {
  return Boolean(e && e.content && Array.isArray(e.tags) && e.tags.length >= 5)
}

/* - 写库（匿名 write，零身份）──────────────────────────────────────────────── */

/**
/* ── 写库（匿名 write，零身份）────────────────────────────────────────────
 * ⚠️ 正文走 `--content` 是塞进**命令行参数**的，Windows 的 CreateProcess 命令行
 * 上限约 32767 字符。日记正文一般几百字，但模型偶尔会吐长篇；所以超过阈值就改走
 * `--file`（memory.py 支持，用 utf-8-sig 读），别等到某天突然写不进去才发现 */
export function writeDiaryEntries(cfg, entries, workspace) {
  const written = []
  for (const e of entries) {
    const body = String(e.content || '')
    const tags = (Array.isArray(e.tags) ? e.tags : []).join(',')
    const argv = ['write', '-t', tags, '-s', String(e.summary || '')]
    const tmp = Buffer.byteLength(body, 'utf8') >= 20000 ? writeTempFile(body) : ''
    if (tmp) argv.push('--file', tmp)
    else argv.push('--content', body)
    let out = ''
    try {
      out = runMemory(cfg, argv, { workspace })
    } catch (err) {
      out = `[异常] ${(err && err.message) || err}`
    } finally {
      if (tmp) { try { rmSync(tmp, { force: true }) } catch { /* 忽略 */ } }
    }
    const m = /\[OK\]\s*(D\d+)/.exec(out)
    written.push({ id: m ? m[1] : '', ok: Boolean(m), tags: e.tags, summary: e.summary, output: m ? '' : out.slice(0, 200) })
  }
  return written
}

/** 把正文写到临时文件（配合 memory.py 的 --file），返回路径。 */
function writeTempFile(text) {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-liubian-diary-'))
    const file = join(dir, 'content.txt')
    writeFileSync(file, String(text), 'utf8')
    return file
  } catch {
    return ''   // 建不了临时文件就退回 --content
  }
}

/* - 工作区归属 ------------------------------------------------------------ */

/** 'auto' → 会话 cwd 的目录名（且该目录真的在 liubianRoot 下）优先，否则回落默认工作区。 */
export function resolveDiaryWorkspace(cfg, agent) {
  const fixed = String(cfg.diaryWorkspace || 'auto')
  if (fixed && fixed !== 'auto') return fixed
  const cwd = String((agent && agent.session && agent.session.header && agent.session.header.cwd) || '')
  if (cwd) {
    const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
    if (base && existsSync(join(cfg.liubianRoot, base))) return base
  }
  return cfg.workspace
}

/* - 日志 / 待补队列 ------------------------------------------------------------ */

function appendJsonl(file, obj) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8')
  } catch { /* 落盘失败不影响主流程 */ }
}

function enqueuePending(entry) {
  appendJsonl(diaryPendingFile(), { ...entry, at: new Date().toISOString(), retry: (entry.retry || 0) })
}

function readPending() {
  try {
    return readFileSync(diaryPendingFile(), 'utf8').replace(/^\uFEFF/, '')
      .split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

function writePending(list) {
  try {
    const file = diaryPendingFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, list.map(o => JSON.stringify(o)).join('\n') + (list.length ? '\n' : ''), 'utf8')
  } catch { /* 忽略 */ }
}

/* - 主流程 ------------------------------------------------------------ */

/** 记录 turn → 外部 API（标签候选 + 上一轮对话）→ 归一化 → 写库。异常全吞（绝不拖垮对话）。
 *  rebuild=true 时跳过"已写过"检查，专供待补队列重放已存下的轮次。 */
export async function writeTurnDiary(ctx, cfg, agent, turn, opts = {}) {
  const sessionId = String((agent && agent.session && agent.session.id) || 'default')
  const key = `${sessionId}#${turn.turn}`
  if (!opts.rebuild && writtenKeys.has(key)) return { skipped: 'already-written' }
  // 同一轮正在写：API 调用要十几秒，可能跨过下轮的第一步；没这道闸门同轮会被写两遍。
  if (diaryInFlight.has(key)) return { skipped: 'in-flight' }
  diaryInFlight.add(key)
  try {
    return await writeTurnDiaryInner(ctx, cfg, agent, turn, opts, key)
  } finally {
    diaryInFlight.delete(key)
  }
}

async function writeTurnDiaryInner(ctx, cfg, agent, turn, opts, key) {
  const sessionId = String((agent && agent.session && agent.session.id) || 'default')
  const dc = diaryConfig()
  if (!dc.enabled) return { skipped: 'disabled' }
  if (!dc.apiKey) return { skipped: 'no-api-key' }
  if (!turn.human.length || !turn.assistant.length) return { skipped: 'empty-turn' }

  const workspace = opts.workspace || resolveDiaryWorkspace(cfg, agent)
  let hints = opts.hints
  let pickMode = 'given'
  if (!hints) {
    const picked = await selectDiaryTags(cfg, turn, ctx.logger)
    hints = picked.tags
    pickMode = picked.mode
  }
  const payload = await buildDiaryPayload(cfg, turn, hints, workspace)
  let res = await callDiaryApi(cfg, { ...dc, timeoutMs: cfg.diaryTimeoutMs }, payload)

  if (!res.ok) {
    enqueuePending({ session: sessionId, turn: turn.turn, workspace, error: res.error, turnData: turn })
    ctx.logger?.warn?.(`[dsh-liubian] 自动日记失败（已入待补队列）turn=${turn.turn}：${res.error}`)
    return { error: res.error }
  }

  let entries = normalizeEntries(cfg, res.entries, hints)
  let unusable = entries.filter(e => !isWritableEntry(e))
  if (unusable.length > 0) {
    // 模型给出的标签不足 5 个（后端要拒）：不拿标签表头部凑数，只重试一次。
    ctx.logger?.warn?.(
      `[dsh-liubian] 自动日记 turn=${turn.turn}：${unusable.length} 篇标签不足 5 个（${unusable
        .map(e => e.tagCount).join('/')}），重试一次`,
    )
    const retry = await callDiaryApi(cfg, { ...dc, timeoutMs: cfg.diaryTimeoutMs }, payload)
    if (retry.ok) {
      const retryEntries = normalizeEntries(cfg, retry.entries, hints)
      const retryBad = retryEntries.filter(e => !isWritableEntry(e))
      if (retryEntries.length > 0 && retryBad.length < unusable.length) {
        res = retry
        entries = retryEntries
        unusable = retryBad
      }
    }
  }
  const good = entries.filter(isWritableEntry)
  if (good.length === 0) {
    enqueuePending({ session: sessionId, turn: turn.turn, workspace, error: '模型给的标签不足 5 个（重试后仍不足）', turnData: turn })
    ctx.logger?.warn?.(`[dsh-liubian] 自动日记 turn=${turn.turn}：标签不足 5 个，未写库（已入待补队列）`)
    return { error: 'tags-too-few' }
  }
  if (unusable.length > 0) {
    ctx.logger?.warn?.(`[dsh-liubian] 自动日记 turn=${turn.turn}：丢弃 ${unusable.length} 篇标签不足的条目，写入 ${good.length} 篇`)
  }
  const written = writeDiaryEntries(cfg, good, workspace)
  const failedWrites = written.filter(w => !w.ok)
  // 落库失败的部分**不重试**（重试整轮会把已成功的那几篇写重），只记进日志待人工查。
  if (failedWrites.length > 0) {
    ctx.logger?.warn?.(
      `[dsh-liubian] 自动日记 turn=${turn.turn}：${failedWrites.length}/${written.length} 篇落库失败 —— `
      + failedWrites.map(w => `[${w.tags.join('/')}] ${w.output}`).join('｜'),
    )
  }
  // 只在**全部**落库失败时才算这轮没写成，留在 buffer 里等下次补；部分成功视为已完成，避免写重。
  if (failedWrites.length === written.length) {
    enqueuePending({ session: sessionId, turn: turn.turn, workspace, error: `落库失败：${failedWrites[0].output || ''}`, turnData: turn })
    return { error: 'write-failed' }
  }
  rememberWritten(key)
  appendJsonl(diaryLogFile(), {
    at: new Date().toISOString(), session: sessionId, turn: turn.turn, workspace,
    tagCount: hints.length, tagSelect: pickMode, degradedJsonMode: Boolean(res.degradedJsonMode),
    usage: res.usage || null,
    entries: written.map(w => ({ id: w.id, ok: w.ok, tags: w.tags, summary: w.summary })),
  })
  ctx.logger?.info?.(
    `[dsh-liubian] 自动日记 turn=${turn.turn} → ${workspace}：${written.map(w => w.id || '(失败)').join('、')}`
    + `（${good.length} 篇，对话 ${payload.meta.chars} 字，标签 ${hints.length} 个/${pickMode}）`,
  )
  return { written }
}

/** 补写 pending（每轮最多几条，避免堆积时长时间占用；手动 retry 可给更大的 limit）。
 *  重放时按存下来的**轮次原文**重建输入（标签表实时取，跟主流程完全同一条路）。 */
export async function flushPending(ctx, cfg, limit) {
  const list = readPending()
  if (list.length === 0) return { tried: 0, left: 0 }
  const dc = diaryConfig()
  if (!dc.enabled || !dc.apiKey) return { tried: 0, left: list.length }
  const max = Math.max(1, Number(limit) || 3)
  const rest = []
  let tried = 0, done = 0
  for (const item of list) {
    if (tried >= max) { rest.push(item); continue }
    tried += 1
    const turn = item.turnData
    if (!turn) {                                   // 老格式（只存了 payload）：丢掉，避免越积越多
      ctx.logger?.warn?.(`[dsh-liubian] 待补队列丢弃条无轮次原文的旧记录 turn=${item.turn}`)
      continue
    }
    const r = await writeTurnDiary(ctx, cfg, { session: { id: item.session } }, turn, {
      workspace: item.workspace, rebuild: true,
    })
    if (r.written) { done += 1; continue }
    const retry = (item.retry || 0) + 1
    if (retry < (Number(cfg.diaryRetryLimit) || 5)) rest.push({ ...item, retry, error: r.error || r.skipped })
    else ctx.logger?.warn?.(`[dsh-liubian] 自动日记放弃补写 turn=${item.turn}（已重试 ${retry} 次）`)
  }
  writePending(rest)
  if (done) ctx.logger?.info?.(`[dsh-liubian] 自动日记补写完成 ${done} 条，剩余 ${rest.length} 条`)
  return { tried, done, left: rest.length }
}

/**
 * 下一轮触发：写上一轮 + 补 pending。**fire-and-forget，绝不阻塞**。
 *  末轮不在此列 —— 本函数只在 pre-step 调用，没人调用时什么都不发生。
 */
export function scheduleDiaryFlush(ctx, cfg, agent) {
  const dc = diaryConfig()
  if (!dc.enabled || !dc.apiKey) return
  void (async () => {
    try {
      const sessionId = String((agent && agent.session && agent.session.id) || 'default')
      const turn = takeUnwrittenTurn(sessionId)
      if (turn) await writeTurnDiary(ctx, cfg, agent, turn)
      await flushPending(ctx, cfg, 3)
    } catch (err) {
      ctx.logger?.warn?.(`[dsh-liubian] 自动日记调度异常}${(err && err.message) || err}`)
    }
  })()
}

/**
 * 启动预热：语义模式下把标签向量缓存读进内存；没有缓存则后台建。
 * 只在 semantic 模式 + 自动日记开启时才做（关着的时候白占 57MB 内存没意义）。
 */
/**
 * 启动预热：语义模式下把标签向量缓存读进内存；没有缓存（或标签表变了）则后台重建。
 * 只在 semantic 模式 + 自动日记开启时才做（关着的时候白占 57MB 内存没意义）。
 *
 * wait=true 时会等缓存真的就绪（含重建，1~2 分钟）。只给**插件启动**和**首次开启**用：
 * 否则第一轮会回整张标签表，白多花几万 token。重建是后台的，等待期间日志有进度 */
export async function warmTagVectors(ctx, cfg, opts = {}) {
  if (String(cfg.diaryTagSelect || 'semantic').toLowerCase() !== 'semantic') return null
  const dc = diaryConfig()
  if (!dc.enabled) return null
  try {
    const tv = await tagVectors(cfg, ctx.logger)
    if (tv) {
      ctx.logger?.info?.(
        `[dsh-liubian] 标签向量缓存已就绪：${tv.names.length} 个标签 / ${tv.dim} 维`
        + `（${(tv.vecs.byteLength / 1048576).toFixed(1)}MB，语义选标签前 ${cfg.diaryTagTopN} 个）`,
      )
      return tv
    }
    if (!opts.wait) return null
    // 缓存失效/缺失：等它的后台重建完成再放行（每次轮询 1 秒，多等 5 分钟。
    const deadline = Date.now() + 300000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000))
      const built = await tagVectors(cfg, ctx.logger)
      if (built) {
        ctx.logger?.info?.(`[dsh-liubian] 标签向量缓存重建完成：${built.names.length} 个标签 / ${built.dim} 维`)
        return built
      }
    }
    ctx.logger?.warn?.('[dsh-liubian] 标签向量缓存重建超时（5 分钟），先按整张标签表运行')
  } catch (err) {
    ctx.logger?.warn?.(`[dsh-liubian] 标签向量预热失败（下轮重试）}${(err && err.message) || err}`)
  }
  return null
}

export function mountAutoDiary(ctx, cfg) {
  loadWrittenKeys()
  // 语义选标签：启动时就把标签向量缓存读进内存（约 0.2 秒 / 57MB），
  // 这样**第一轮**就是语义选标签，而不是先回整张表、第二轮才生效。
  // 不 await：apply() 是同步挂载，让它自己在后台跑完（若需重建会等，见 wait）
  void warmTagVectors(ctx, cfg, { wait: true })

  // ?采集：把每轮对话攒起来（免疫上下文压缩；turn/end 封口。
  ctx.on('session/event', (session, event) => {
    try {
      if (!session || !event) return
      const id = String(session.id)
      const buf = bufferFor(id)
      switch (event.type) {
        case 'turn/start':
          buf.current = { turn: (event.data && event.data.turn) || buf.sealed.length + 1, human: [], assistant: [], tools: [], reason: null }
          break
        case 'user/message':
          if (buf.current && isHumanMessage(event.data)) {
            const t = messageText(event.data).trim()
            if (t) buf.current.human.push(t)
          }
          break
        case 'assistant/message':
          if (buf.current && event.data && event.data.message) {
            const t = messageText(event.data.message).trim()
            if (t) buf.current.assistant.push(t)
          }
          break
        case 'tool/call':
          if (buf.current && event.data && event.data.name) buf.current.tools.push(String(event.data.name))
          break
        case 'turn/end':
          if (buf.current) {
            buf.current.reason = (event.data && event.data.reason && event.data.reason.kind) || 'unknown'
            buf.sealed.push(buf.current)
            buf.current = null
            if (buf.sealed.length > 8) buf.sealed.shift()
          }
          break
        default:
          break
      }
    } catch { /* 采集失败不影响对话 */ }
  })

  // ② 写入：只有 pre-step（下一轮的第一步）一个触发点。
  //    末轮不在这里兜底 —— 用户明确要求"末轮由下一轮来写"，所以会话结束/落盘时
  //    什么都不做，没写的轮次留在 buffer 里，等下一次对话开轮补上。
  const dc = diaryConfig()
  ctx.logger?.info?.(
    `[dsh-liubian] 自动日记：${dc.enabled ? '开' : '关'}`
    + `（key ${dc.apiKey ? '已配置' : '未配置'}，模型 ${dc.model}，每篇 ≤${cfg.diaryMaxChars} 字，篇数不限，工作区 ${cfg.diaryWorkspace}）`,
  )
}

/* ──────────────────────────────────────────────────────────────────────────
 * 7. 插件入口
 * ────────────────────────────────────────────────────────────────────────── */

/** 插件自带技能目录（源）。 */
const SKILLS_SRC = fileURLToPath(new URL('../skills/', import.meta.url))

/** DSH 能目录（宿主的用户级能根，DSH 会自动发现这里的新技能）。 */
const SKILLS_DST = join(DSH_HOME, 'skills')

/**
 * 把插件自带的 SKILL.md 同步到 DSH 技能目录。
 * 只在内容不同时写入（幂等），失败只告警——绝不因为技能落盘问题拖垮工具注册。
 * 新落盘的技能要下一次会话才会出现在技能目录里。
 */
function syncSkills(logger) {
  const written = []
  try {
    if (!existsSync(SKILLS_SRC)) return written
    for (const entry of readdirSync(SKILLS_SRC, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const src = join(SKILLS_SRC, entry.name, 'SKILL.md')
      if (!existsSync(src)) continue
      const dstDir = join(SKILLS_DST, entry.name)
      const dst = join(dstDir, 'SKILL.md')
      const content = readFileSync(src, 'utf8')
      if (existsSync(dst)) {
        try {
          if (readFileSync(dst, 'utf8') === content) continue
        } catch {
          /* 读不了就当需要重写 */
        }
      }
      mkdirSync(dstDir, { recursive: true })
      writeFileSync(dst, content, 'utf8')
      written.push(entry.name)
    }
  } catch (err) {
    logger?.warn?.(`[dsh-liubian] 技能同步失败：${(err && err.message) || String(err)}`)
  }
  return written
}

export function apply(ctx, input = {}) {
  const cfg = resolveConfig(input)
  activeLogger = ctx.logger

  if (cfg.installSkills) {
    const written = syncSkills(ctx.logger)
    if (written.length > 0) {
      ctx.logger?.info?.(`[dsh-liubian] 技能已同步到 ${SKILLS_DST}：${written.join('、')}（新会话生效）`)
    }
  }

  registerTools(ctx, cfg)

  // 上下文插入：会话启动身份卡 + 每轮联合检索注入（对照 DSH 记忆插件的接线）
  mountContextInjection(ctx, cfg)

  // 自动日记：采集（session/event）+ 下一轮写上一轮（末轮不兜底，交给下一次对话）
  mountAutoDiary(ctx, cfg)

  ctx.effect(() => () => disposeContextInjection(), 'dsh-liubian: 清理上下文插入状态')

  ctx.logger?.info?.(
    `[dsh-liubian] v${PLUGIN_VERSION} 流变系统已挂载：工具前缀 ${TOOL_PREFIX}，默认工作区}${cfg.workspace}」，后端 ${cfg.memoryScript}`,
  )
}
