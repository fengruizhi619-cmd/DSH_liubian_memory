/**
 * dsh-liubian-notes —— 流变·便签（实现主体）
 *
 * 定位：流变·记忆的短期记忆互补件（管理员钉的新架构下，便签是信息主来源的入口）。
 * 便签 = 便签头（简介，唯一向量来源）+ 便签正文；
 * 双来源：自动多轮聚合（每 R 轮一篇，LLM 生成头+正文，与自动日记同通道）+ 智能体主动挂起；
 * 每轮按便签头向量余弦最近选 n=3 篇注入（热记忆，无预算上限）；
 * 热度以滑动窗口记账（l/m，m=R）；池满赛马淘汰最低分；头向量相似度 >0.90 判重拒收；
 * 晋级（固化）通道暂缓：promote 只做本地缓存（pending_promotions.jsonl），
 * 将来经被炉 P2P + 独特名系统提交 wiki（管理员 2026-10-01 指示）。
 *
 * 实现对照 dsh-liubian 的已验证模式：main.mjs 入口壳 / pluginMessage 四要件 /
 * session/event 采集 / agent/pre-step 注入（整段 try/catch）/ 8082 嵌入服务。
 * 方案文档：E:\DSH_data\流变系统\docs\便签系统_DSH实施方案.md
 */
import { randomUUID, createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/* ── 可选依赖：有 junction 就用 defineTool，没有就退回裸对象（绝不因依赖挂掉插件）── */
let defineTool = null
try {
  const t = await import('@deepseek-ai/dsh-tools')
  if (typeof t.defineTool === 'function') defineTool = t.defineTool
} catch { defineTool = null }

/* ── 插件消息构造：@deepseek-ai/dsh-llm 只在宿主 asar 里，import 必然失败；
 *    回退分支必须自己补 uuid（缺 id 会写坏宿主会话日志——checklist §3.3.1 血案）── */
let createUserMessageFn = null
try {
  const llm = await import('@deepseek-ai/dsh-llm')
  if (typeof llm.createUserMessage === 'function') createUserMessageFn = llm.createUserMessage
} catch { createUserMessageFn = null }

export const PLUGIN_VERSION = '0.7.0'
export const PLUGIN_SOURCE = 'dsh-liubian-notes'
const TOOL_PREFIX = '_dsh_external_dsh_liubian_'

const HOME = process.env.USERPROFILE || process.env.HOME || 'C:/Users/Feng'
export const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh')

/** 全部默认值。可被 ~/.dsh/liubian-notes/config.json 或宿主传入 config 覆盖。 */
export const DEFAULTS = {
  enabled: true,
  poolSize: 10,              // 池容量 N（管理员定案，后期实践再议）
  injectTop: 3,              // 每轮注入 n 篇（热记忆）
  aggregateRounds: 5,        // 聚合周期 R（默认 5 起跑；待实测平均每轮文本量后定值）
  heatRounds: 0,             // 热度寿命 m；0 = 跟随 R（管理员定案 m=R，新旧交替配对）
  dedupThreshold: 0.90,      // 便签头余弦相似度 > 此值判重拒收
  reviewEveryK: 20,          // 送审节拍（P2；当前 promote 为手动缓存制）
  retireAfterDays: 30,       // 会话死后便签保留天数（P2）
  minSim: 0,                 // 注入相似度下限（0 = 不设）
  // 注入无预算上限（管理员 2026-10-01 指示）：整头整正文注入，不截断
  // ── 聚合 LLM（与自动日记同通道；url/key/model 从 ~/.dsh/liubian/diary.json 读）──
  noteLlmGen: true,          // true = 聚合走 LLM 生成头+正文；失败自动回退拼接
  diaryApiUrl: 'https://api.deepseek.com/chat/completions',
  diaryApiModel: 'deepseek-flash',
  diaryApiKey: '',
  llmTimeoutMs: 120000,
  // ── 向量服务（复用 dsh-liubian-embed 拉起的 llama.cpp，HTTP 调用零包依赖）──
  embedUrl: 'http://127.0.0.1:8082/v1/embeddings',
  embedModel: 'qwen3-emb',
  embedDim: 1024,
  embedTimeoutMs: 60000,
  // ── 记忆侧领域配置：单一来源 ~/.dsh/liubian/config.json（P2 wiki 提交通道用）──
  workspace: '工作组',
}

/** 记忆侧领域配置兜底值（仅当 ~/.dsh/liubian/config.json 缺键时生效）。 */
const MEMORY_FALLBACKS = {
  python: 'E:/python/python.exe',
  memoryScript: join(HOME, '.codex', 'skills', 'memory-skill', 'scripts', 'memory.py'),
  liubianRoot: 'E:/DSH_data',
  workspace: '工作组',
  memoryTimeoutMs: 180000,
}
export const MEMORY_KEYS = Object.keys(MEMORY_FALLBACKS)
export function memoryConfigFile() { return join(DSH_HOME, 'liubian', 'config.json') }
export function diaryApiConfigFile() { return join(DSH_HOME, 'liubian', 'diary.json') }

export function configFile() { return join(DSH_HOME, 'liubian-notes', 'config.json') }

function readJson(file) {
  try {
    if (!existsSync(file)) return null
    // 去 BOM：记事本/PowerShell 写出的 UTF8 带 BOM，不剥会被静默忽略
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch { return null }
}

export function resolveConfig(input = {}) {
  const file = readJson(configFile()) || {}
  const cfg = { ...DEFAULTS, ...file, ...input }
  // 记忆侧共享键：~/.dsh/liubian/config.json（单一来源）> 显式 input > 兜底
  const memCfg = readJson(memoryConfigFile()) || {}
  for (const k of MEMORY_KEYS) {
    if (memCfg[k] !== undefined) cfg[k] = memCfg[k]
    else if (cfg[k] === undefined) cfg[k] = MEMORY_FALLBACKS[k]
  }
  // 聚合 LLM 通道（v0.3.3 收敛）：优先家族共享键 `llmApiUrl` / `llmApiKey` / `llmApiModel`
  // （config.json，记忆向量名下单一来源）→ 过渡期回落到 diary.json（其属主 auto-diary 子系统
  // 已于 2026-10-01 退役 d3c1d50，文件成无主状态，故不再作为唯一来源）→ 内置默认。
  if (memCfg.llmApiUrl) cfg.diaryApiUrl = memCfg.llmApiUrl
  if (memCfg.llmApiModel) cfg.diaryApiModel = memCfg.llmApiModel
  if (memCfg.llmApiKey) cfg.diaryApiKey = memCfg.llmApiKey
  const d = readJson(diaryApiConfigFile()) || {}
  if (!memCfg.llmApiUrl && d.url) cfg.diaryApiUrl = d.url
  if (!memCfg.llmApiModel && d.model) cfg.diaryApiModel = d.model
  if (!memCfg.llmApiKey && d.apiKey) cfg.diaryApiKey = d.apiKey
  cfg.poolSize = Math.max(1, Number(cfg.poolSize) || 10)
  cfg.injectTop = Math.max(1, Number(cfg.injectTop) || 3)
  cfg.aggregateRounds = Math.max(1, Number(cfg.aggregateRounds) || 5)
  cfg.heatRounds = Number(cfg.heatRounds) > 0 ? Number(cfg.heatRounds) : cfg.aggregateRounds
  cfg.dedupThreshold = Math.min(0.999, Math.max(0.5, Number(cfg.dedupThreshold) || 0.90))
  return cfg
}

/* ──────────────────────────────────────────────────────────────────────────
 * 1. 存储：~/.dsh/liubian-notes/pools/<会话8位>.json + <会话8位>.retired.jsonl
 *    封存窗口与进行中轮次直接持久化在池文件里（v0.3.0：废除内存缓冲——
 *    事件投递间内存态会丢，sealed 永远凑不满 R 的饿死路径由此根除）。
 * ────────────────────────────────────────────────────────────────────────── */

export function notesDir() { return join(DSH_HOME, 'liubian-notes', 'pools') }
export function pendingPromotionsFile() { return join(DSH_HOME, 'liubian-notes', 'pending_promotions.jsonl') }
export function sessionKeyFor(sessionId) {
  return createHash('sha256').update(String(sessionId ?? '')).digest('hex').slice(0, 8)
}
function poolFile(key) { return join(notesDir(), `${key}.json`) }
function retiredFile(key) { return join(notesDir(), `${key}.retired.jsonl`) }

function newPool(sessionKey, sessionId) {
  return {
    version: PLUGIN_VERSION,
    sessionKey,
    sessionId: String(sessionId ?? ''),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    meta: { rounds: 0, humanRounds: 0, humanChars: 0, assistantChars: 0 },  // 平均每轮文本量统计（定 R 用）
    sealed: [],        // 已封存轮次窗口（持久化；聚合从这取料）
    current: null,     // 进行中轮次（turn/start 建档，turn/end 封存）
    notes: [],
  }
}

const poolCache = new Map()

/* 实例代次与运行期日志句柄（🟠-3）：
 * 入口壳每次 apply 都用 `?t=` 动态 import → 每次装配都是**独立的模块实例**，
 * 也就各有自己的模块级状态。旧实例被卸载后，它在途的异步闭包（聚合最长 120s）仍持有旧 pool
 * 快照，若不设护栏就会在完成时 savePool 把旧快照整份写回 → 覆盖新实例期间新增的便签。
 * 所以：dispose 时置 disposed=true，savePool/dispose 之后一律拒绝回写。 */
let disposed = false
let currentLogger = null
/** 卸载后仍被回调时的**限一次**告警（🟠-6，v0.5.3）：这一状态此前完全静默——
 *  实例已卸载 → 所有落盘被拒，可持续数小时而日志只显示正常的「轮封存」。 */
let disposedWarned = false
function warnDisposedOnce(where) {
  if (disposedWarned) return
  disposedWarned = true
  currentLogger?.warn?.(
    `[dsh-liubian-notes] ⚠ 本实例已卸载（disposed）却仍在被回调：${where}——`
    + '所有落盘（池/回收站）已被拒绝，便签在此期间不会持久化。请重载或重启该插件。',
  )
}

/** 坏池文件隔离：**改名保留现场**（不删、不被空池覆盖），返回隔离后的路径。 */
function quarantinePool(key) {
  const src = poolFile(key)
  if (!existsSync(src)) return ''
  const dst = `${src}.corrupt-${Date.now()}`
  try { renameSync(src, dst); return dst } catch { return '' }
}

function loadPool(key, sessionId) {
  let pool = poolCache.get(key)
  if (pool) return pool
  /* 🔴-2：旧实现读不出就 newPool，随后任何 savePool 会把**空池**写回原文件
   * ——半截 JSON（崩溃/断电）即可让整池静默蒸发。现在改为：解析失败或结构异常时
   * **先把现场隔离**（改名 .corrupt-<ts>）再新建空池，任何情况下原始字节都不丢。 */
  let raw = null
  let parseFailed = false
  try {
    const file = poolFile(key)
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
      if (text.trim()) {
        try { raw = JSON.parse(text) } catch { parseFailed = true }
      }
    }
  } catch { parseFailed = true }
  const schemaBad = !!raw && !Array.isArray(raw.notes)
  if (parseFailed || schemaBad) {
    const q = quarantinePool(key)
    currentLogger?.warn?.(
      `[dsh-liubian-notes] 池文件${parseFailed ? '解析失败' : '结构异常'}（${key}）→ 已隔离到 ${q || '（隔离失败！原始文件仍在）'} 并新建空池`,
    )
  }
  pool = raw && Array.isArray(raw.notes) ? raw : newPool(key, sessionId)
  if (!Array.isArray(pool.sealed)) pool.sealed = []
  if (!pool.current) pool.current = null
  if (!pool.meta) pool.meta = { rounds: 0, humanRounds: 0, humanChars: 0, assistantChars: 0 }
  if (typeof pool.meta.humanRounds !== 'number') pool.meta.humanRounds = 0
  /* 🟠-4 兼容：旧代码「先落盘再清 current」会把同一轮同时留在 sealed 末尾与 current，
   * 读到这种重复态时按已封存处理，避免该轮被二次封存/二次聚合。 */
  if (pool.current && pool.sealed.length
    && pool.sealed[pool.sealed.length - 1]
    && pool.sealed[pool.sealed.length - 1].turn === pool.current.turn) {
    pool.current = null
  }
  poolCache.set(key, pool)
  return pool
}

/** 原子落盘（🔴-2）：写临时文件 → rename 替换，避免半截 JSON。
 *  返回 boolean 供调用方判成败（🟡-1：不再"内存改了就算成功"）。 */
function savePool(pool) {
  if (disposed) { warnDisposedOnce('savePool'); return false }   // 🟠-3：已卸载实例不得回写旧快照
  pool.updatedAt = new Date().toISOString()
  try {
    mkdirSync(notesDir(), { recursive: true })
    const file = poolFile(pool.sessionKey)
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(pool), 'utf8')
    renameSync(tmp, file)
    return true
  } catch (err) {
    currentLogger?.warn?.(`[dsh-liubian-notes] 落盘失败（下轮重试，本次改动未持久化）：${(err && err.message) || err}`)
    return false
  }
}

function loadRetired(key) {
  try {
    const file = retiredFile(key)
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l.replace(/^\uFEFF/, '')) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

function saveRetired(key, list) {
  if (disposed) { warnDisposedOnce('saveRetired'); return false }
  try {
    mkdirSync(notesDir(), { recursive: true })
    /* 🟠-5：回收站也是「整份重写」语义 —— 同样改成 tmp + rename 原子替换，
     * 否则半截写 = 整个回收站丢失，同时丢掉判重保护（findDuplicate 依赖回收站）。 */
    const file = retiredFile(key)
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, list.map(n => JSON.stringify(n)).join('\n') + (list.length ? '\n' : ''), 'utf8')
    renameSync(tmp, file)
    return true
  } catch { return false }
}

/* 🔴-9（v0.5.7）：此处原有「工具面默认会话＝最后跑 pre-step 的会话」那套全局指针
 * （模块级 last-active 变量 + 一个读它的默认键函数 + 一个写它的 touch 函数），已整条删除。
 * 事故：宿主单进程承载全部会话，谁的 step 最后跑，工具就读写谁的池——多智能体房间里
 * list 报别人的池、stick/promote 把便签挂进/送出**别的智能体**的池，**且不报错**。
 * 工具面现取调用方会话（见下方 resolveSessionArg / callerSessionOf）。
 * ⚠ 不要加回来：_dev/verify-fixes.mjs 有源码级护栏，断言这三个标识符全文件 **0 引用（含注释）**。 */

/* ──────────────────────────────────────────────────────────────────────────
 * 2. 向量：复用 8082（llama.cpp /v1/embeddings，qwen3-emb）。失败返回 null → 降级。
 * ────────────────────────────────────────────────────────────────────────── */

export async function embedTexts(cfg, texts, timeoutMs = undefined) {
  const list = (Array.isArray(texts) ? texts : [texts]).map(t => String(t || '').trim()).filter(Boolean)
  if (!list.length) return null
  const controller = new AbortController()
  /* 🟡-7：旧签名 `timeoutMs = 60000` 让默认值恒为真 → `cfg.embedTimeoutMs` 永不生效（死配置）。
   * 改成 undefined 默认，再由配置兜底（显式传参仍可覆盖）。 */
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : (Number(cfg.embedTimeoutMs) > 0 ? Number(cfg.embedTimeoutMs) : 60000)
  const timer = setTimeout(() => controller.abort(), budget)
  try {
    const res = await fetch(cfg.embedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.embedModel, input: list.map(t => t.slice(0, 600)) }),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const data = JSON.parse(await res.text())
    const vecs = ((data && data.data) || []).map(d => d && d.embedding)
    if (!vecs.length || !Array.isArray(vecs[0])) return null
    return vecs
  } catch { return null } finally { clearTimeout(timer) }
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i]) || 0, y = Number(b[i]) || 0
    dot += x * y; na += x * x; nb += y * y
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/* ──────────────────────────────────────────────────────────────────────────
 * 3. 热度：每注入一次记 1 条（回合号）；每条独立存活 m=R 回合；热度分 = l/m。
 * ────────────────────────────────────────────────────────────────────────── */

export function pruneHeat(note, nowTurn, m) {
  if (!Array.isArray(note.heat)) note.heat = []
  /* 🟠-2：只丢「确实过期」的记录（d >= m）；**保留 d < 0 的记录**。
   * d < 0 意味着该记录的回合号大于当前 nowTurn —— 而 nowTurn 来自「当前消息表里人类消息的条数」
   * （非单调：宿主裁剪/fork/恢复都可能让它回退）。旧实现把 d<0 也当过期删除，
   * 于是任何一次回合号回退都会**永久抹掉**较新的热度记录（与 M2 事故同一机理）。 */
  const keep = note.heat.filter(t => (Number(nowTurn) - Number(t)) < m)
  note.heat = keep
  return keep.length
}

export function heatScore(note, nowTurn, m) {
  /* 只读口径（与 heatCountAt 同源）：窗口内的记录数 / m，恒 ≤ 1。
   * 不再经 pruneHeat —— 打分是读操作，不得改写 note.heat；
   * 记录数组的收缩交给 write 路径显式 pruneHeat（见 injectionBlock）。 */
  return heatCountAt(note, nowTurn, m) / Math.max(1, Number(m) || 1)
}

/** 只读热度计数（**无副作用**）：旁路查询（面板路由）专用。
 *  为什么不用 pruneHeat：它会改写 note.heat；当 nowTurn 缺失或过旧（如池的 lastTurn=0）时
 *  `nowTurn - t < 0` 会让全部记录判过期并**永久删除**——一次面板轮询即可抹掉该池热度。 */
export function heatCountAt(note, nowTurn, m) {
  const list = Array.isArray(note.heat) ? note.heat : []
  let l = 0
  for (const t of list) {
    const d = Number(nowTurn) - Number(t)
    if (d >= 0 && d < m) l += 1
  }
  return l
}

/* ──────────────────────────────────────────────────────────────────────────
 * 3b. 池级互斥（M1 修复）：堵并发写入的丢单竞态。
 *  实测事故：三个并发 stick 各自读到同一快照 → 各自算 ID → 后写覆盖前写，
 *  丢了一张便签且两张撞号（都算成 NT-3）。
 *  设计：只锁「同步临界区」（读快照→算 ID→判重→赛马→写盘）；
 *  LLM 生成等长耗时段**不持锁**，否则会卡住本轮 pre-step。
 * ────────────────────────────────────────────────────────────────────────── */

/* 🟠-3：池锁与聚合守卫**挂到 globalThis**（按 poolKey 键控）。
 *  入口壳每次 apply 都 `?t=` 新 import → 每次装配都是独立模块实例，各有一份模块级 Map；
 *  于是「旧实例的聚合 + 新实例的工具写」可同时对同一池「读快照→算 ID→写盘」，
 *  M1 的丢单/撞号会以跨实例形态回归。进程内共享一份即可消除该维度。 */
const SHARED = (globalThis.__liubianNotesShared ||= { locks: new Map(), aggregateInFlight: new Set(), lastInjectedTurn: new Map(), routeOff: null })
const poolLocks = SHARED.locks

export function withPoolLock(key, fn) {
  const prev = poolLocks.get(key) || Promise.resolve()
  const run = prev.then(fn, fn)   // 前序事务失败也要继续，不吞后续
  poolLocks.set(key, run.then(() => {}, () => {}))
  return run
}

/* ──────────────────────────────────────────────────────────────────────────
 * 4. 便签构造
 * ────────────────────────────────────────────────────────────────────────── */

function firstLine(text, max) {
  const s = String(text || '').split('\n').map(x => x.trim()).filter(Boolean)[0] || ''
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** 回退用正文：窗口内每轮一行结构化记录（LLM 不可用时兜底）。 */
export function buildNoteBody(turns) {
  return turns.map(t => {
    const q = firstLine((t.human || []).join(' '), 80)
    const a = firstLine((t.assistant || []).join(' '), 120)
    const tools = (t.tools || []).length ? `｜工具:${(t.tools || []).slice(0, 4).join(',')}` : ''
    return `#t${t.turn} 问:${q || '（无）'}｜答:${a || '（无）'}${tools}`
  }).join('\n')
}

/** 回退用头：各轮「提问首行」拼接；**无人类内容的轮（唤醒轮）改用答首行**——
 *  v0.6.0 起唤醒轮也参与聚合，只取 human 会让全唤醒窗得到「（空窗口）」。 */
export function buildAutoHead(turns, maxChars = 120) {
  const parts = turns
    .map(t => firstLine((t.human || []).join(' '), 40) || firstLine((t.assistant || []).join(' '), 40))
    .filter(Boolean)
  const head = parts.join('；')
  return head.length > maxChars ? head.slice(0, maxChars) + '…' : (head || '（空窗口）')
}

/** 查询文本 = 该轮对话 + 上一轮完整问答（管理员定案）。 */
export function composeQueryText(currentPrompt, previousQA) {
  const cur = String(currentPrompt || '').trim().slice(0, 300)
  const prevH = String((previousQA && previousQA.human) || '').trim()
  const prevA = String((previousQA && previousQA.assistant) || '').trim()
  const rest = ((prevH ? `上问:${prevH}` : '') + (prevA ? `｜上答:${prevA}` : '')).slice(0, Math.max(0, 600 - cur.length))
  return (cur + (rest ? '\n' + rest : '')).trim()
}

/** 上一轮完整问答（倒找：最后一条助手正文 + 它前面那条人类消息）。 */
export function previousQAPair(messages, messageTextFn, isHumanFn) {
  const list = Array.isArray(messages) ? messages : []
  let assistant = ''
  let human = ''
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i]
    if (!m) continue
    if (!assistant && m.role === 'assistant') { assistant = messageTextFn(m).trim(); continue }
    if (assistant && isHumanFn(m)) { human = messageTextFn(m).trim(); break }
  }
  return { human, assistant }
}

/** 注入块：无预算上限（管理员 2026-10-01 指示），整头整正文。 */
export function buildNotesBlock(selected, poolSize) {
  if (!selected || !selected.length) return ''
  const lines = selected.map(s =>
    `【${s.note.id}｜热度 ${s.heat.toFixed(2)}｜sim ${s.sim.toFixed(2)}】${String(s.note.head || '')}\n${String(s.note.body || '')}`,
  )
  return `<liubian-notes source="${PLUGIN_SOURCE}">\n` +
    `以下是本对话的便签（热记忆 ${selected.length}/${poolSize}；按便签头向量余弦选出，未注入者为冷记忆，可用 _dsh_external_dsh_liubian_note 查看全池或主动挂起）：\n` +
    lines.join('\n---\n') + '\n</liubian-notes>'
}

/* ──────────────────────────────────────────────────────────────────────────
 * 5. 聚合 LLM（与自动日记同通道：~/.dsh/liubian/diary.json 的 key）
 * ────────────────────────────────────────────────────────────────────────── */

export function buildPackPrompt(text) {
  return '你负责把一段对话窗口打包成一篇「便签」（会话的短期记忆单元）。便签有头和正文：' +
    'head 是一句话简介（它将作为向量检索的唯一来源，必须概括这段对话的核心主题与关键对象，12~40 字）；' +
    'body 是正文（保留这段对话里的关键结论、决定、数值与未尽事项，350 字以内，不要客套话）。' +
    '只输出一个 JSON 对象：{"head":"...","body":"..."}，不要输出任何其他内容。\n\n对话窗口：\n' + text
}

/** 聚合 LLM 生成便签（头+正文）。任何失败返回 null → 调用方回退拼接。
 *  🟡 设置热生效（v0.5.0）：每次聚合**重读** llmApi* 三键（设置页保存后下一次聚合即用新值，无需重启）。 */
export async function generateNoteViaLlm(cfg, turns) {
  try {
    if (cfg.noteLlmGen === false) return null
    const fresh = readJson(memoryConfigFile()) || {}
    const useUrl = fresh.llmApiUrl || cfg.diaryApiUrl
    const useKey = fresh.llmApiKey || cfg.diaryApiKey
    const useModel = fresh.llmApiModel || cfg.diaryApiModel
    if (!useKey) return null
    const text = turns.map(t =>
      `【轮${t.turn}】问：${(t.human || []).join(' ') || '（无）'}\n答：${(t.assistant || []).join(' ') || '（无）'}`,
    ).join('\n\n').slice(0, 12000)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cfg.llmTimeoutMs)
    try {
      const res = await fetch(useUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${useKey}` },
        body: JSON.stringify({ model: useModel, messages: [{ role: 'user', content: buildPackPrompt(text) }] }),
        signal: controller.signal,
      })
      if (!res.ok) return null
      const data = JSON.parse(await res.text())
      const content = data?.choices?.[0]?.message?.content || ''
      const m = /\{[\s\S]*\}/.exec(content)
      if (!m) return null
      const parsed = JSON.parse(m[0])
      const head = String(parsed.head || '').trim()
      const body = String(parsed.body || '').trim()
      if (!head || !body) return null
      return { head, body }
    } finally { clearTimeout(timer) }
  } catch { return null }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 5.5 升格请求（v0.6.3 —— 管理员 2026-10-01 定的新升格流）
 *   promote → 产出「升格请求」（语义 slug + 三段式结论/机制/终态 + 来源痕迹）
 *          → 经被炉 kotatsuBoard v1 直发**银杏**校验
 *          → 银杏定 familyPath + 查重归并 → 他落树 → 回执 slug
 *   便签侧**不再猜家族**（挑家族本质是归并判断，只有能看到全树的人做得准）。
 *   本地 pending_promotions.jsonl 降级为**账目**（请求内容 + 送没送出去 + bid）。
 * ────────────────────────────────────────────────────────────────────────── */

const BOARD_TO = '银杏'          // 升格请求的固定校验方（管理员 2026-10-01 定）
const BOARD_FROM = '流变便签'

/** v0.6.3：模块级 ctx 句柄 —— 工具动作里要取跨插件服务（服务通道没有 exec 概念）。 */
let currentCtx = null
/** 仅供测试缝使用：注入/复位 ctx（生产路径由 apply 赋值）。 */
export function __testSetCtx(c) { currentCtx = c }

/** 取跨插件服务：ctx.reflect.get(name) 优先、ctx.get(name) 回退，皆无 → null（缺席不抛）。 */
export function serviceOf(name) {
  const c = currentCtx
  if (!c) return null
  try {
    const s = c.reflect && typeof c.reflect.get === 'function' ? c.reflect.get(name) : null
    if (s) return s
  } catch { /* 反射失败按缺席处理 */ }
  try { return typeof c.get === 'function' ? c.get(name) : null } catch { return null }
}

/** 语义 slug（禁池内编号、禁斜杠）：从便签头蒸馏，纯启发式，作为回退与 LLM 输出的校验基线。 */
export function slugifyHead(head) {
  const s = String(head || '')
    .replace(/[\\/:*?"<>|#@\s]+/g, '')
    .replace(/[，。；：、！？（）【】「」『』…—～·]+/g, '')
    .trim()
  return (s.slice(0, 24) || '便签升格')
}

/** LLM 不可用时的回退请求：**如实标注未提炼**（gen=fallback），不假装做过三段式。 */
export function fallbackPromoteRequest(note) {
  const head = String(note.head || '').trim() || '（无头）'
  const body = String(note.body || '').trim()
  return {
    slug: slugifyHead(head),
    title: head.slice(0, 30),
    intro: firstLine(head, 120),
    conclusion: body || '（正文为空）',
    mechanism: '',
    endState: '',
    gen: 'fallback',
  }
}

const PROMOTE_PROMPT_HEAD = [
  '把下面这张便签整理成一条 wiki 条目的「升格请求」。**只输出一个 JSON 对象**，不要解释、不要代码围栏。',
  '字段与要求：',
  '  slug：语义标识，6~24 字符，中文或英数，**不含斜杠**，能概括主题；禁止使用 NT-1 这类池内编号。',
  '  title：条目标题，≤30 字。',
  '  intro：一句话简介，是**检索主锚**——写清主题与关键术语，便于日后按语义命中，≤120 字。',
  '  conclusion：结论（TL;DR，一两句把结果说死）。',
  '  mechanism：机制（为什么/怎么做到的）。',
  '  endState：终态（现在是什么状态、还挂着什么待办）。',
  '提交号、版本号、轮次流水**不要**写进三段，它们会由调用方降为末行「来源」痕迹。',
  '便签如下：',
].join('\n')

/** LLM 提炼升格请求；任何失败返回 null → 调用方回退 fallbackPromoteRequest。 */
export async function generatePromoteRequestViaLlm(cfg, note) {
  try {
    const fresh = readJson(memoryConfigFile()) || {}
    const useUrl = fresh.llmApiUrl || cfg.diaryApiUrl
    const useKey = fresh.llmApiKey || cfg.diaryApiKey
    const useModel = fresh.llmApiModel || cfg.diaryApiModel
    if (!useKey) return null
    const head = String(note.head || '').trim()
    const body = String(note.body || '').trim()
    const text = PROMOTE_PROMPT_HEAD + '\n' + head + '\n' + body
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cfg.llmTimeoutMs)
    try {
      const res = await fetch(useUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + useKey },
        body: JSON.stringify({ model: useModel, messages: [{ role: 'user', content: text }] }),
        signal: controller.signal,
      })
      if (!res.ok) return null
      const data = JSON.parse(await res.text())
      const content = data && data.choices && data.choices[0] && data.choices[0].message
        ? String(data.choices[0].message.content || '') : ''
      const m = /\{[\s\S]*\}/.exec(content)
      if (!m) return null
      const p = JSON.parse(m[0])
      const out = {
        slug: String(p.slug || '').trim().replace(/\//g, ''),
        title: String(p.title || '').trim(),
        intro: String(p.intro || '').trim(),
        conclusion: String(p.conclusion || '').trim(),
        mechanism: String(p.mechanism || '').trim(),
        endState: String(p.endState || '').trim(),
        gen: 'llm',
      }
      if (!out.slug || !out.intro || !out.conclusion) return null
      if (/^promote-NT-/i.test(out.slug)) return null      // 池内编号当 slug = 违规，宁可回退
      return out
    } finally { clearTimeout(timer) }
  } catch { return null }
}

/** 组装升格请求：LLM 优先、失败回退；**不含 familyPath**（家族由银杏定）。 */
export async function buildPromoteRequest(cfg, note, logger) {
  const head = String(note.head || '').trim()
  const body = String(note.body || '').trim()
  let req = cfg.noteLlmGen === false ? null : await generatePromoteRequestViaLlm(cfg, note)
  if (!req) {
    req = fallbackPromoteRequest(note)
    logger?.warn?.('[dsh-liubian-notes] 升格请求走回退提炼（LLM 不可用或未配置 Key）——已如实标注 gen=fallback')
  }
  const seg = (label, v) => (String(v || '').trim() ? label + '：' + String(v).trim() + '\n' : '')
  const content = [
    '【便签升格请求】' + (req.gen === 'llm' ? '（LLM 三段提炼）' : '（⚠ 回退提炼，未做三段式，请银杏多看一眼）'),
    '建议 slug：' + req.slug,
    '建议标题：' + (req.title || head),
    '一句话简介（检索主锚）：' + req.intro,
    '内容（三段式）：',
    seg('结论', req.conclusion) + seg('机制', req.mechanism) + seg('终态', req.endState),
    '来源痕迹：便签 ' + note.id + '｜生成 ' + req.gen + '｜原文：',
    body,
    '—— 请校验：① slug 是否与现有条目冲突或应归并；② 该挂到哪棵家族（家族由你定，我不猜）；',
    '③ 是否与既有条目重叠（多切片归并优先）。落树后回执 slug，我侧把该便签改判 submitted。',
  ].join('\n')
  return Object.assign({}, req, { head, content })
}

/** 按（会话, 便签）读 pending 账目里最后一条；无则 null。 */
export function pendingEntry(sessionKey, id) {
  const wantId = String(id || '')
  if (!wantId) return null
  try {
    const file = pendingPromotionsFile()
    if (!existsSync(file)) return null
    let found = null
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line.replace(/^\uFEFF/, ''))
        if (e && String(e.id) === wantId && String(e.session_key) === String(sessionKey)) found = e
      } catch { /* 坏行跳过 */ }
    }
    return found
  } catch { return null }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 6. 入池：判重（>阈值拒收，回收站也参与）→ 赛马（满员踢最低分）→ 落盘
 * ────────────────────────────────────────────────────────────────────────── */

function racableNotes(pool) {
  // submitted（已固化）与 queued（已缓存待固化）都受保护，不占赛马名额
  return pool.notes.filter(n => n.status !== 'submitted' && n.status !== 'queued')
}

function findDuplicate(pool, vec, threshold) {
  if (!vec) return null
  const retired = loadRetired(pool.sessionKey)
  for (const n of [...pool.notes, ...retired]) {
    if (!Array.isArray(n.vector)) continue
    if (cosine(vec, n.vector) > threshold) return { id: n.id, where: pool.notes.includes(n) ? '池内' : '回收站' }
  }
  return null
}

function raceEvict(pool, cfg, nowTurn) {
  /* v0.7.0：**容量按总数管，受害者从"可赛马集合"里选**。
   * 旧实现是「进来看总数、循环看可赛马数」——两者在"总数超限但可赛马数不足"时**都不淘汰**，
   * 于是池会越过上限（有 queued/submitted 占位时尤其明显）。现在：
   *   while (总数 >= 容量) 就腾位；受保护的便签不可被选为受害者；若全受保护则如实停手（break）。
   * 调用方在其后 push，最终总数回到容量。 */
  let evicted = null
  while (pool.notes.length >= cfg.poolSize) {
    const cands = racableNotes(pool)
    if (!cands.length) break                       // 全受保护 → 腾不了位，如实停手（不假装淘汰了）
    let worst = null
    for (const n of cands) {
      const s = heatScore(n, nowTurn, cfg.heatRounds)
      if (!worst || s < worst.s || (s === worst.s && n.born_turn < worst.n.born_turn)) worst = { n, s }
    }
    if (!worst) break
    pool.notes = pool.notes.filter(x => x !== worst.n)
    worst.n.status = 'retired'
    const retired = loadRetired(pool.sessionKey)
    retired.push(worst.n)
    saveRetired(pool.sessionKey, retired)
    evicted = worst.n
  }
  return evicted
}

/* ──────────────────────────────────────────────────────────────────────────
 * 6.5 自动升格（v0.7.0 —— 管理员 2026-10-01 定稿）
 *   池满（active 便签数 = poolSize）→ 取**热度最高**的一张 → 产升格请求 → 发银杏
 *   → **立即出池**。出池后池 = 9，新便签直接补位 —— 不再需要靠赛马踢人腾位。
 *
 *   三条口径（管理员定）：
 *     ① **全自动触发**：不靠人手点 promote；
 *     ② **不回信**：便签侧**不消费**银杏的回执，落树与否由他定，本侧不依赖回执推进
 *        （也因此不需要 settle/land 之类动作，出池即完成本侧职责）；
 *     ③ **上传记忆只能银杏做**：本插件**绝不**调记忆侧的 wiki 写入服务、不写 wiki 库
 *        （源码级护栏见 _dev/verify-fixes.mjs）。
 * ────────────────────────────────────────────────────────────────────────── */

const graduateInFlight = SHARED.graduateInFlight || (SHARED.graduateInFlight = new Set())

/** 池内**热度最高**的一张（并列取最旧）。只读，不改盘。 */
export function topHeatNote(pool, nowTurn, m) {
  let top = null
  for (const n of racableNotes(pool)) {
    const s = heatScore(n, nowTurn, m)
    if (!top || s > top.s || (s === top.s && n.born_turn < top.n.born_turn)) top = { n, s }
  }
  return top
}

/** 同 id 只留一条升格账目：先摘旧条目再落新的。 */
function persistGraduate(sessionKey, id, entry) {
  removePendingEntry(sessionKey, id)
  return appendPending(entry)
}

/** 自动升格主流程。**池未满一律不动**（管理员：放满了才送）。
 *  返回 { ok, id?, slug?, bid?, skipped?, error? }。 */
export async function graduateOnce(cfg, pool, logger) {
  const m = Number(cfg.heatRounds) || Number(cfg.aggregateRounds) || 5
  const nowTurn = Math.max(
    Number(pool.current && pool.current.turn) || 0,
    (Number(pool.meta && pool.meta.rounds) || 0) + 1,
  )
  if (racableNotes(pool).length < cfg.poolSize) return { ok: false, skipped: '池未满' }
  const top = topHeatNote(pool, nowTurn, m)
  if (!top) return { ok: false, skipped: '无可送审对象' }
  const note = top.n
  const req = await buildPromoteRequest(cfg, note, logger)
  const svc = serviceOf('kotatsuBoard')
  const entry = {
    queued_at: new Date().toISOString(),
    session_key: pool.sessionKey,
    id: note.id,
    head: note.head,
    body: note.body,                       // v0.7.0：账目带**全文**（v0.6.3 漏了；退回/审计要用）
    born_turn: note.born_turn,
    source: note.source,
    workspace: String(cfg.workspace || '工作组').trim(),
    request: { slug: req.slug, title: req.title, intro: req.intro, gen: req.gen },
    heat_at_send: Number(top.s.toFixed(3)),
    auto: true,
    sent: false,
  }
  if (!svc || typeof svc.send !== 'function') {
    entry.last_error = 'kotatsuBoard v1 服务不可用'
    persistGraduate(pool.sessionKey, note.id, entry)
    logger?.warn?.('[dsh-liubian-notes] 自动升格未送出（' + entry.last_error + '）：' + note.id + ' 留在池内，账目 sent:false')
    return { ok: false, id: note.id, error: entry.last_error }
  }
  let res = null
  try {
    res = await svc.send({
      to: BOARD_TO,
      subject: '便签升格请求｜' + (req.title || note.head),
      content: req.content,
      fromName: BOARD_FROM,
      fromRef: 'notes:' + pool.sessionKey + '/' + note.id,
    })
  } catch (err) { res = { ok: false, error: (err && err.message) || String(err) } }
  if (!res || res.ok !== true) {
    entry.last_error = String((res && res.error) || '未知错误（返回形状异常）')
    persistGraduate(pool.sessionKey, note.id, entry)
    logger?.warn?.('[dsh-liubian-notes] 自动升格送达失败（' + entry.last_error + '）：' + note.id + ' 留在池内，账目 sent:false')
    return { ok: false, id: note.id, error: entry.last_error }
  }
  entry.sent = true
  entry.bid = res.bid
  entry.sent_at = new Date().toISOString()
  persistGraduate(pool.sessionKey, note.id, entry)
  /* **出池**：内容已随请求交给银杏，本侧不再持有 → 腾出槽位给新便签 */
  pool.notes = pool.notes.filter((x) => x !== note)
  if (!Array.isArray(pool.graduated)) pool.graduated = []
  pool.graduated.push({
    id: note.id, head: note.head, slug: req.slug, bid: res.bid,
    heat: Number(top.s.toFixed(3)), at: new Date().toISOString(),
  })
  const saved = savePool(pool)
  logger?.info?.(
    '[dsh-liubian-notes] 自动升格出池 ' + note.id + '「' + firstLine(note.head, 30) + '」→ ' + BOARD_TO
    + '（board #' + res.bid + '｜热度 ' + top.s.toFixed(2) + '｜slug ' + req.slug + '）'
    + (saved ? '' : '（⚠ 落盘失败）'),
  )
  return { ok: true, id: note.id, slug: req.slug, bid: res.bid }
}

/** fire-and-forget 调度（同会话去重）：LLM 提炼耗时绝不卡当轮。 */
export function scheduleGraduate(ctx, cfg, pool) {
  const key = pool.sessionKey
  if (graduateInFlight.has(key)) return
  graduateInFlight.add(key)
  void (async () => {
    try { await withPoolLock(key, () => graduateOnce(cfg, pool, ctx.logger)) }
    catch (err) { ctx.logger?.warn?.('[dsh-liubian-notes] 自动升格失败（下轮重试）: ' + ((err && err.message) || err)) }
    finally { graduateInFlight.delete(key) }
  })()
}

/** 入池主流程（判重 → 赛马 → 向量补齐 → 落盘）。draft 带已有便签（restore）则保留原 ID。 */
export async function addNoteToPool(pool, draft, cfg, nowTurn) {
  const isReAdd = !!(draft && draft.id && draft.created_at)
  const taken = new Set([...pool.notes.map(n => n.id), ...loadRetired(pool.sessionKey).map(n => n.id)])
  /* v0.6.1：旧式 `notes.length + 1 + taken.size` 把同一批 notes **计了两遍**
   * （taken 本已含全部 notes 的 id）→ N 篇之后 seq = 2N+1，ID **只会是奇数**
   * （全库实证：每个池都是 NT-1/3/5/7/9）。正确基线 = taken.size + 1，再由下面的
   * while 循环避让已用号。 */
  let seq = taken.size + 1
  let id = isReAdd ? draft.id : `NT-${seq}`
  while (!isReAdd && taken.has(id)) { seq += 1; id = `NT-${seq}` }
  const note = isReAdd
    ? { ...draft, status: draft.status === 'retired' ? 'active' : draft.status }
    : {
        id,
        head: String(draft.head || '').trim() || '（无头）',
        body: String(draft.body || '').trim(),
        vector: null,
        source: draft.source === 'manual' ? 'manual' : 'auto',
        gen: draft.gen || null,        // 'llm' | 'concat'（自动便签的生成方式）
        born_turn: Number(nowTurn) || 0,
        heat: [],
        diary_ref: null,
        submit_attempts: 0,
        status: 'active',
        created_at: new Date().toISOString(),
      }
  const vecs = await embedTexts(cfg, [note.head])
  if (vecs && vecs[0]) note.vector = vecs[0]
  const dup = findDuplicate(pool, note.vector, cfg.dedupThreshold)
  if (dup) return { ok: false, reason: `判重拒收：与${dup.where}便签 ${dup.id} 相似度超过 ${cfg.dedupThreshold}`, note }
  const evicted = raceEvict(pool, cfg, nowTurn)
  pool.notes.push(note)
  const saved = savePool(pool)     // 🟡-1：把落盘结果带回给调用方（回执必须反映真实持久化状态）
  return { ok: true, note, evicted, saved }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 7. 聚合：从池内持久化 sealed 窗口取料，LLM 生成头+正文（失败回退拼接）
 * ────────────────────────────────────────────────────────────────────────── */

const aggregateInFlight = SHARED.aggregateInFlight   // 🟠-3：与池锁同源，跨实例共享
const lastInjectedTurn = SHARED.lastInjectedTurn     // 🟠-1：同轮去重 token（跨实例共享，内存态）

/** 🟠-1 的可测缝：本回合是否已注入过（同 key + 同 turnToken）。
 *  v0.6.2：token 由调用方传入**真实轮次**（pool.current.turn / meta.rounds+1）——
 *  旧实现传的是「人类消息条数」，而它恒为 1，导致注入被永久抑制（见 pre-step 段注释）。
 *  用内存态而非持久化 lastTurn，避免重启后首轮被误抑制。 */
export function injectionAlreadyDone(key, token) { return lastInjectedTurn.get(key) === token }
export function markInjectionDone(key, token) { lastInjectedTurn.set(key, token) }

/** 聚合主流程：sealed 里凑满 R 个人类轮 → LLM 打包 → 入池（循环清空积压）。
 *  返回本轮实际入池篇数。 */
export async function maybeAggregate(pool, cfg, nowTurn, logger) {
  let made = 0
  let rejected = 0
  while (true) {
    const window = []
    /* v0.6.0：**不再丢弃无人类内容的轮**。旧实现在这里把唤醒轮 `shift` 掉——等于白封存、
     *  聚合永远只吃人类轮。现在任何内容轮都参与凑满 R；只丢 null 这类坏数据。 */
    while (pool.sealed.length && window.length < cfg.aggregateRounds) {
      const t = pool.sealed.shift()
      if (!t) continue
      window.push(t)
    }
    if (window.length < cfg.aggregateRounds) {
      pool.sealed.unshift(...window)
      if (made) savePool(pool)
      return made
    }
    const llm = await generateNoteViaLlm(cfg, window)
    const draft = llm
      ? { head: llm.head, body: llm.body, source: 'auto', gen: 'llm' }
      : { head: buildAutoHead(window), body: buildNoteBody(window), source: 'auto', gen: 'concat' }
    const res = await withPoolLock(pool.sessionKey, () => addNoteToPool(pool, draft, cfg, nowTurn))
    if (res.ok) {
      made += 1
    } else {
      /* 🔴-3：判重拒收时**把窗口回补**，否则这 R 个人类轮既没变成便签、也不在 sealed 里 = 永久消失。
       * 拒收意味着「池里已有同义便签」，但原料仍属于对话记忆，应留在窗口待下轮（或逐轮滑出）。
       * 回补到队首保持时间序，并**立即 break**：同一窗口在同一次调度里重试必然再被拒
       * （判重是确定性的），若不跳出就会变成"无限重试 + 狂打 LLM"的死循环。 */
      pool.sealed.unshift(...window)
      rejected += 1
      savePool(pool)
      logger?.info?.(
        `[dsh-liubian-notes] 自动聚合被拒（${res.reason}）→ 窗口已回补 ${window.length} 轮（本轮不再重试）` +
        (pool.sealed.length > 16 ? `；⚠ sealed 已达 ${pool.sealed.length}（上限 16，将丢弃最旧轮）` : ''),
      )
      break
    }
    logger?.info?.(
      `[dsh-liubian-notes] 自动聚合入池 ${res.note.id}「${firstLine(res.note.head, 30)}」(${draft.gen})` +
      (res.evicted ? `，赛马淘汰 ${res.evicted.id}` : ''),
    )
  }
  if (rejected) currentLogger?.warn?.(`[dsh-liubian-notes] 本轮有 ${rejected} 个聚合窗口因判重被拒（原料已回补，池可能已饱和于同义主题）`)
  return made
}

function scheduleAggregate(ctx, cfg, sessionId, pool, nowTurn) {
  if (aggregateInFlight.has(sessionId)) return
  aggregateInFlight.add(sessionId)
  void (async () => {
    try { await maybeAggregate(pool, cfg, nowTurn, ctx.logger) }
    catch (err) { ctx.logger?.warn?.(`[dsh-liubian-notes] 聚合失败（下轮重试）: ${(err && err.message) || err}`) }
    finally { aggregateInFlight.delete(sessionId) }
  })()
}

/* ──────────────────────────────────────────────────────────────────────────
 * 8. 注入（agent/pre-step）
 * ────────────────────────────────────────────────────────────────────────── */

function pluginMessage(content, form) {
  const source = { kind: 'plugin:' + PLUGIN_SOURCE, form }
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
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

function isHumanMessage(message) {
  if (!message || message.role !== 'user') return false
  const kind = message.source?.kind
  return kind === undefined || kind === null || kind === 'user'
}

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

async function backfillVectors(pool, cfg) {
  const missing = pool.notes.filter(n => n.status !== 'retired' && !Array.isArray(n.vector))
  if (!missing.length) return true
  /* 🟡-2：embedTexts 内部会 `filter(Boolean)` 丢掉空串——若直接把 missing 的 head 原样传进去，
   * 一旦出现空 head，其后所有便签会按**原下标**拿到别人的向量（注入错篇、判重全错，且落盘）。
   * 这里先滤出「可嵌入」（非空 head）的子集再按下标回填，下标与请求数组一一对应。 */
  const pending = missing.filter(n => String(n.head || '').trim())
  if (!pending.length) return false
  const vecs = await embedTexts(cfg, pending.map(n => String(n.head).trim()))
  if (!Array.isArray(vecs)) return false
  pending.forEach((n, i) => { if (Array.isArray(vecs[i]) && vecs[i].length) n.vector = vecs[i] })
  savePool(pool)
  return pending.every(n => Array.isArray(n.vector))
}

/** 每轮注入主流程。返回注入块文本（空串 = 本轮不注）。 */
export async function injectionBlock(pool, cfg, queryText, nowTurn) {
  await backfillVectors(pool, cfg)
  const eligible = pool.notes.filter(n => n.status !== 'retired' && Array.isArray(n.vector))
  if (!eligible.length) return ''
  const qv = await embedTexts(cfg, [queryText])
  if (!qv || !qv[0]) return ''   // 8082 不可用 → 静默降级（只存不注）
  let ranked = eligible
    .map(note => ({ note, sim: cosine(qv[0], note.vector), heat: heatScore(note, nowTurn, cfg.heatRounds) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, cfg.injectTop)
  if (cfg.minSim > 0) ranked = ranked.filter(r => r.sim >= cfg.minSim)
  if (!ranked.length) return ''
  for (const r of ranked) {
    r.note.heat.push(nowTurn)                          // 每被注入一次记 1 条热度
    pruneHeat(r.note, nowTurn, cfg.heatRounds)         // 压缩只发生在写路径（d≥m 的记录才丢）
  }
  savePool(pool)
  return buildNotesBlock(ranked, cfg.poolSize)
}

/* ──────────────────────────────────────────────────────────────────────────
 * 9. 晋级缓存（固化通道暂缓——将来经被炉 P2P + 独特名系统提交 wiki）
 * ────────────────────────────────────────────────────────────────────────── */

function appendPending(entry) {
  try {
    mkdirSync(dirname(pendingPromotionsFile()), { recursive: true })
    appendFileSync(pendingPromotionsFile(), JSON.stringify(entry) + '\n', 'utf8')
    return true
  } catch { return false }
}

/** 🟡-5：pending 队列里是否已有该（会话, 便签）——用于 promote 幂等（jsonl 无唯一键，只能扫）。 */
export function pendingHasId(sessionKey, id) {
  const wantId = String(id || '')
  if (!wantId) return false
  try {
    const file = pendingPromotionsFile()
    if (!existsSync(file)) return false
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).some((line) => {
      try {
        const e = JSON.parse(line.replace(/^\uFEFF/, ''))
        return e && String(e.id) === wantId && (!sessionKey || String(e.session_key) === String(sessionKey))
      } catch { return false }
    })
  } catch { return false }
}

/** v0.6.0：把一条 pending 条目从队列里摘掉（unqueue 的配套）。jsonl 无唯一键 → 整表重写。
 *  返回被摘掉的条数；**-1 = 写失败**（调用方必须如实回告，不得假装成功）。 */
export function removePendingEntry(sessionKey, id) {
  const wantId = String(id || '')
  if (!wantId) return 0
  const file = pendingPromotionsFile()
  if (!existsSync(file)) return 0
  let lines = []
  try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch { return -1 }
  const keep = []
  let removed = 0
  for (const line of lines) {
    let e = null
    try { e = JSON.parse(line.replace(/^\uFEFF/, '')) } catch { keep.push(line); continue }
    if (e && String(e.id) === wantId && (!sessionKey || String(e.session_key) === String(sessionKey))) { removed += 1; continue }
    keep.push(line)
  }
  if (!removed) return 0
  try {
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, keep.join('\n') + '\n', 'utf8')
    renameSync(tmp, file)
    return removed
  } catch { return -1 }
}

/* v0.6.3：此处原有的「五连发升格标签」派生（'便签升格' + 工作区名 + 头内取词 + 补位填充）
 * 已整段删除——新升格流的定位是 **语义 slug + 三段式 + 银杏定家族**，标签那一层不再存在。
 * 它也从来不是"误派生"的受害者（真因是串池，见 🔴-9）：它按设计工作，只是设计作废了。
 * ⚠ 不要加回来：_dev/verify-fixes.mjs 有源码级护栏断言它 0 引用（含注释）。 */

/* ──────────────────────────────────────────────────────────────────────────
 * 10. 工具面：_dsh_external_dsh_liubian_note
 * ────────────────────────────────────────────────────────────────────────── */

/* 🔴-9（v0.5.7）：工具面默认池＝**调用方会话**，绝不回落到「最后活跃池」。
 * 取法照家族先例（基建 v0.2.2 callerSessionOf）：exec.agent.session.id。 */
export function callerSessionOf(exec) {
  const s = exec && exec.agent && exec.agent.session
  const id = String((s && s.id) || '').trim()
  if (!id) return null
  return { key: sessionKeyFor(id), sessionId: id }
}

/** 解析顺序：args.session（显式，优先）→ 调用方会话（exec）→ null（调用方按 B 档明确报错）。 */
function resolveSessionArg(args, exec) {
  const explicit = String(args.session || '').trim()
  if (explicit) return { key: sessionKeyFor(explicit), sessionId: explicit }
  return callerSessionOf(exec)
}

/** B 档：解析不到就明确报错，不静默回落（静默回落＝「两处真相」，今天已出过一例）。 */
const SESSION_UNRESOLVED = '[错误] 无法解析调用方会话：本工具的默认池是「调用方会话的池」，'
  + '当前调用没带会话上下文。请显式传 session=<会话标识>，或从对话内调用。'

export async function noteToolAction(cfg, args = {}, logger, exec = null) {
  const action = String(args.action || 'list').trim()
  if (action === 'list') {
    /* 🔴-9：默认池＝调用方会话。「key 为空就列全部池」那条调试回落已取消（B 档）——
     * 列全池的正路是 HTTP 路由 op=pools（面板与排障用），工具面不再留"无会话上下文也能列全库"的静默入口。 */
    const sess0 = resolveSessionArg(args, exec)
    if (!sess0) return SESSION_UNRESOLVED
    const pools = [loadPool(sess0.key, sess0.sessionId)]
    if (!pools.length) return '[空] 还没有任何便签池（自动聚合每 ' + cfg.aggregateRounds + ' 轮一篇，或用 stick 主动挂起）。'
    const m = cfg.heatRounds
    return pools.map(pool => {
      const avg = pool.meta.rounds ? ((pool.meta.humanChars + pool.meta.assistantChars) / pool.meta.rounds).toFixed(0) : '0'
      const lines = pool.notes.map(n => {
        /* 🔴-1：**读路径不得触碰 note.heat**。此处原用 pruneHeat（会物理删除过期记录）；
         * 工具 schema 不暴露 nowTurn → 恒为 0 → 任何 t≥1 的记录被判 d<0 一律删除，
         * 再被下一次 savePool 固化 = 热度整体归零、赛马失去输入。
         * 只读计数一律走 heatCountAt（M2 修复的是路由，这里补上工具面这条同源路径）。
         * 显示口径：给了 nowTurn → 窗口分 l/m；没给 → 原始记录条数（对排障更有信息量）。 */
        const l = Number(args.nowTurn) ? heatCountAt(n, Number(args.nowTurn), m) : (Array.isArray(n.heat) ? n.heat.length : 0)
        const heat = Number(args.nowTurn) ? (l / m).toFixed(2) : `${l}条`
        const vec = Array.isArray(n.vector) ? '有向量' : '无向量'
        const gen = n.gen ? '/' + n.gen : ''
        return `  ${n.id} [${n.source}${gen}${n.status !== 'active' ? '/' + n.status : ''}] 热度${heat} ${vec} born#t${n.born_turn}${n.diary_ref ? ' →' + n.diary_ref : ''}：${firstLine(n.head, 50)}`
      })
      const retiredN = loadRetired(pool.sessionKey).length
      return `池 ${pool.sessionKey}（${pool.notes.length}/${cfg.poolSize}，回收站 ${retiredN}，待封存轮 ${pool.sealed.length}；人类轮 ${Number(pool.meta.humanRounds) || 0} / 内容轮 ${pool.meta.rounds}，均 ${avg} 字/轮）\n${lines.join('\n') || '  （空池）'}`
    }).join('\n\n')
  }

  const sess = resolveSessionArg(args, exec)
  if (!sess) return SESSION_UNRESOLVED
  const pool = loadPool(sess.key, sess.sessionId)

  if (action === 'stick') {
    const head = String(args.head || '').trim()
    const body = String(args.body || '').trim()
    if (!head || !body) return '[错误] stick 需要 head（一句话简介，将作为向量来源）与 body（便签正文）。'
    return withPoolLock(pool.sessionKey, async () => {
      const res = await addNoteToPool(pool, { head, body, source: 'manual' }, cfg, Number(args.nowTurn) || pool.meta.rounds)
      if (!res.ok) return `[拒收] ${res.reason}`
      return `已挂起 ${res.note.id}「${firstLine(res.note.head, 40)}」入池（${racableNotes(pool).length}/${cfg.poolSize}）` +
        (res.evicted ? `；赛马淘汰 ${res.evicted.id}（入回收站，可 restore）` : '') +
        (res.saved === false ? '（⚠ 落盘失败：仅内存生效，下轮写入会重试——如需持久请稍后重试）' : '')
    })
  }

  if (action === 'show') {
    const note = pool.notes.find(n => n.id === String(args.id || '')) ||
      loadRetired(pool.sessionKey).find(n => n.id === String(args.id || ''))
    if (!note) return `[未找到] 便签 ${args.id}（list 先看池）。`
    const gen = note.gen ? '/' + note.gen : ''
    return `# ${note.id}（${note.source}${gen}${note.status !== 'active' ? '/' + note.status : ''}，born#t${note.born_turn}，热度记录 ${(note.heat || []).join(',')}）\n头：${note.head}\n正文：\n${note.body}${note.diary_ref ? `\n归档：${note.diary_ref}` : ''}`
  }

  if (action === 'promote') {
    /* v0.6.3（管理员 2026-10-01 定的新升格流）：promote 不再自己挑家族、也不再"只入本地队列等通道"——
     * 而是**产出升格请求并直发银杏校验**（他定 familyPath、查重/归并），他落树后回执 slug。
     * 本地 pending 降级为**账目**（请求内容 + 送没送出去 + bid）。
     * 纪律：服务不可用或送达失败 → **明确报错 + 账目留 sent:false**，绝不静默丢。 */
    return withPoolLock(pool.sessionKey, async () => {
      const note = pool.notes.find(n => n.id === String(args.id || ''))
      if (!note) return `[未找到] 便签 ${args.id}。`
      if (note.status === 'submitted') return `[跳过] ${note.id} 已固化（${note.diary_ref || '已落树'}）。`
      const prev = pendingEntry(pool.sessionKey, note.id)
      if (prev && prev.sent) {
        note.status = 'queued'
        savePool(pool)
        return `[跳过] ${note.id} 的升格请求已发出（board #${prev.bid || '?'}），等银杏校验并定家族。`
      }
      const ws = String(args.workspace || cfg.workspace || '工作组').trim()
      const req = await buildPromoteRequest(cfg, note, logger)
      const svc = serviceOf('kotatsuBoard')
      const entry = {
        queued_at: new Date().toISOString(),
        session_key: pool.sessionKey,
        id: note.id,
        head: note.head,
        born_turn: note.born_turn,
        source: note.source,
        workspace: ws,
        request: { slug: req.slug, title: req.title, intro: req.intro, gen: req.gen },
        sent: false,
      }
      /* 同 id 只留一条账目：重发路径先摘旧条目再落新的（不追求跨文件原子，账目可容忍） */
      const persist = (e) => { if (prev) removePendingEntry(pool.sessionKey, note.id); return appendPending(e) }
      if (!svc || typeof svc.send !== 'function') {
        entry.last_error = 'kotatsuBoard v1 服务不可用（被炉未 provide 或未装载）'
        const wrote = persist(entry)
        return `[失败] ${entry.last_error} —— 升格请求未发出，便签保持 ${note.status}。`
          + (wrote ? '请求已留在 pending_promotions.jsonl 账目（sent:false），服务恢复后重发 promote 即可。' : '（⚠ 连账目都没写成功，请检查数据目录权限）')
      }
      let res = null
      try {
        res = await svc.send({
          to: BOARD_TO,
          subject: '便签升格请求｜' + (req.title || note.head),
          content: req.content,
          fromName: BOARD_FROM,
          fromRef: 'notes:' + pool.sessionKey + '/' + note.id,
        })
      } catch (err) { res = { ok: false, error: (err && err.message) || String(err) } }
      if (!res || res.ok !== true) {
        entry.last_error = String((res && res.error) || '未知错误（返回形状异常）')
        persist(entry)
        return `[失败] 升格请求未送达银杏：${entry.last_error}（便签保持 ${note.status}；账目 sent:false，可重试）。`
      }
      entry.sent = true
      entry.bid = res.bid
      entry.sent_at = new Date().toISOString()
      persist(entry)
      note.status = 'queued'
      const savedOk = savePool(pool)
      return `升格请求已发出：${note.id} → ${BOARD_TO}（board #${res.bid}｜建议 slug ${req.slug}｜提炼 ${req.gen}）。`
        + `等银杏校验并定家族后落树；他回执 slug 后本便签改判 submitted。`
        + (savedOk ? '' : '（⚠ 池状态落盘失败：账目已在，池内状态仅内存生效）')
    })
  }

  /* v0.6.0（管理员 2026-10-01，选项 a）：**解除待固化**。
   * queued 原本是单向态（promote 只能置位、drop 对 queued 明确拒绝），串池误标后工具面无法修复。
   * 本动作是唯一**缓存一致**的修复路径：在宿主内改内存对象再落盘，不会像"直接改 pools/*.json"
   * 那样被活会话的内存快照静默回滚（loadPool 命中缓存直接返回，不比对 mtime）。 */
  if (action === 'unqueue') {
    return withPoolLock(pool.sessionKey, async () => {
      const note = pool.notes.find(n => n.id === String(args.id || ''))
      if (!note) return `[未找到] 便签 ${args.id}。`
      if (note.status === 'submitted') {
        return `[拒绝] ${note.id} 已固化（${note.diary_ref || '已提交'}），不能退回 active——如需重做请走 wiki 侧修订。`
      }
      const wasQueued = note.status === 'queued'
      const removed = removePendingEntry(pool.sessionKey, note.id)
      if (removed < 0) return '[失败] 写 pending_promotions.jsonl 未成功（池状态未改，可重试）。'
      if (!wasQueued && !removed) return `[跳过] ${note.id} 本来就不是 queued（池内 ${note.status}，队列里也没有它）。`
      note.status = 'active'
      const savedOk = savePool(pool)
      return `已解除待固化：${note.id}（池内 queued→active；队列摘除 ${removed} 条）。可以重新 promote。`
        + (savedOk ? '' : '（⚠ 池状态落盘失败：仅内存生效，下轮写入会重试）')
    })
  }

  if (action === 'drop') {
    return withPoolLock(pool.sessionKey, async () => {
      const idx = pool.notes.findIndex(n => n.id === String(args.id || ''))
      if (idx < 0) return `[未找到] 便签 ${args.id}。`
      const [note] = pool.notes.splice(idx, 1)
      /* 🟡-5：排队/已固化的便签不得直接丢进回收站——那会让 pending_promotions.jsonl 里的条目
       * 变成孤儿（固化通道将来会把已回收的内容提交出去）。 */
      if (note.status === 'queued' || note.status === 'submitted') {
        pool.notes.splice(idx, 0, note)   // 放回原位
        return `[拒绝] ${note.id} 状态为 ${note.status}（已入待固化队列/已固化），不能 drop——`
          + `如需丢弃请先说明用途，避免 pending 队列产生孤儿条目。`
      }
      note.status = 'retired'
      const retired = loadRetired(pool.sessionKey)
      retired.push(note)
      /* 🟡-1：回收站与池两处谁没落盘都要如实回执（旧实现无论成败都回"已移入回收站"）。 */
      const retiredOk = saveRetired(pool.sessionKey, retired)
      const poolOk = savePool(pool)
      return `已移入回收站：${note.id}（restore 可救回）。`
        + (retiredOk && poolOk ? '' : `（⚠ 落盘异常：回收站=${retiredOk ? 'ok' : '失败'} 池=${poolOk ? 'ok' : '失败'}，下轮写入会重试）`)
    })
  }

  if (action === 'restore') {
    return withPoolLock(pool.sessionKey, async () => {
      const retired = loadRetired(pool.sessionKey)
      const idx = retired.findIndex(n => n.id === String(args.id || ''))
      if (idx < 0) return `[未找到] 回收站里没有 ${args.id}。`
      const [note] = retired.splice(idx, 1)
      saveRetired(pool.sessionKey, retired)
      const res = await addNoteToPool(pool, note, cfg, Number(args.nowTurn) || pool.meta.rounds)
      if (!res.ok) {
        const back = loadRetired(pool.sessionKey); back.push(note); saveRetired(pool.sessionKey, back)
        return `[拒收] 恢复失败：${res.reason}（便签已放回回收站）`
      }
      return `已恢复：${note.id} 重新入池${res.evicted ? `（赛马淘汰 ${res.evicted.id}）` : ''}。`
        + (res.saved === false ? '（⚠ 落盘失败：仅内存生效，下轮写入会重试）' : '')
    })
  }

  return '[错误] 未知 action：' + action + '（可用 list/show/stick/promote/drop/restore）'
}

/* ──────────────────────────────────────────────────────────────────────────
 * 11. 接线
 * ────────────────────────────────────────────────────────────────────────── */

function sendJson(res, code, obj) {
  try {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(obj))
  } catch { /* 客户端断开等，忽略 */ }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

function maskKey(k) {
  const s = String(k || '')
  if (!s) return ''
  /* 短 Key 防泄漏：≤14 位时只留前 3 位（否则 slice(0,8)+slice(-4) 会把全文拼回去） */
  if (s.length <= 14) return s.slice(0, 3) + '…'
  return s.slice(0, 8) + '…' + s.slice(-4)
}

/** 设置读侧（**内部**）：含真实 Key——只给宿主内部（如测试连接）用，路由绝不下发原文。 */
function settingsRaw() {
  const mem = readJson(memoryConfigFile()) || {}
  return {
    llmApiUrl: String(mem.llmApiUrl || ''),
    llmApiModel: String(mem.llmApiModel || ''),
    llmApiKey: String(mem.llmApiKey || ''),
  }
}

/** 设置读侧（路由用）：Key 只回掩码。 */
export function settingsRead() {
  const r = settingsRaw()
  return {
    llmApiUrl: r.llmApiUrl,
    llmApiModel: r.llmApiModel,
    llmKeySet: !!r.llmApiKey,
    llmApiKeyMasked: maskKey(r.llmApiKey),
  }
}

/** 设置写侧：只更新提供的非空 llmApi* 字段；**只动 llmApi* 三键**（文件归记忆向量名下，其余键原样保留）。
 *  先备份（.bak-notes-settings-<ts>）再原子替换；原子路径被占用时退化为直接写。
 *  ⚠ v0.5.3：**去掉 disposed 守卫**——那是为「写池」防陈旧实例覆盖而设的；配置写入与实例生命周期无关，
 *  被守卫拦住会表现为「读得到、保存失败」（路由仍由旧代实例持有时）。返回 `{ ok, error? }`。 */
export function settingsWrite(patch) {
  try {
    const file = memoryConfigFile()
    const cur = readJson(file) || {}
    const next = { ...cur }
    const p = patch || {}
    if (typeof p.llmApiUrl === 'string' && p.llmApiUrl.trim()) next.llmApiUrl = p.llmApiUrl.trim()
    /* 掩码防护：设置卡回传的 Key 若含省略号（…）说明是**掩码**而非真实 Key——跳过，不得覆盖真值。 */
    if (typeof p.llmApiKey === 'string' && p.llmApiKey.trim() && p.llmApiKey.indexOf('…') < 0) next.llmApiKey = p.llmApiKey.trim()
    if (typeof p.llmApiModel === 'string' && p.llmApiModel.trim()) next.llmApiModel = p.llmApiModel.trim()
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file)) {
      try { copyFileSync(file, `${file}.bak-notes-settings-${Date.now()}`) } catch { /* 备份失败不阻断写入 */ }
    }
    const data = JSON.stringify(next, null, 2)
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    try {
      writeFileSync(tmp, data, 'utf8')
      renameSync(tmp, file)
    } catch (err) {
      /* Windows：rename 覆盖被其他进程占用的文件可能 EPERM/EBUSY——退化为直接写（配置体量小）。 */
      try { writeFileSync(file, data, 'utf8') } catch (err2) {
        const msg = `${(err2 && err2.code) || ''} ${(err2 && err2.message) || err2}`.trim()
        console.error(`[dsh-liubian-notes] 设置写入失败：${msg}`)
        return { ok: false, error: msg }
      }
      console.error(`[dsh-liubian-notes] 原子替换失败（${(err && err.code) || ''} ${(err && err.message) || err}），已退化为直接写入`)
    }
    return { ok: true }
  } catch (err) {
    const msg = `${(err && err.code) || ''} ${(err && err.message) || err}`.trim()
    console.error(`[dsh-liubian-notes] 设置写入异常：${msg}`)
    return { ok: false, error: msg }
  }
}

/** 设置页「测试连接」：用传入 Key（或已存 Key）对聚合端点做一次最小对话调用。 */
export async function settingsTest(keyOverride) {
  const s = settingsRaw()   /* ⚠ 必须取**原文**：settingsRead 只回掩码，用它会导致「已存 Key 却报缺少 Key」 */
  const key = String(keyOverride || '').trim() || s.llmApiKey
  const useUrl = s.llmApiUrl
  const useModel = s.llmApiModel
  const missing = [!key && 'API Key', !useUrl && 'API 地址', !useModel && '模型名'].filter(Boolean)
  if (missing.length) return { ok: false, error: '缺少 ' + missing.join(' / ') }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const res = await fetch(useUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: useModel, messages: [{ role: 'user', content: '回复ok' }] }),
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}：${(await res.text()).slice(0, 200)}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) + (String(err?.message || '').includes('abort') ? '（30s 超时）' : '') }
  } finally { clearTimeout(timer) }
}

/** 单个池 → 面板载荷（op=pool 与 op=pools 共用；**纯读**，不改写 heat）。 */
export function poolPayload(key, pool, cfg) {
  const m = cfg.heatRounds
  const lastTurn = Number(pool.lastTurn) || 0
  return {
    key,
    sessionId: pool.sessionId || '',
    updatedAt: pool.updatedAt,
    lastTurn,
    sealed: (pool.sealed || []).length,
    meta: pool.meta || { rounds: 0, humanRounds: 0, humanChars: 0, assistantChars: 0 },
    notes: (pool.notes || []).filter(n => n.status !== 'retired').map(n => {
      const l = heatCountAt(n, lastTurn, m)   // 只读计数：路由不得改写 heat（M2 修复）
      return {
        id: n.id,
        head: n.head,
        body: n.body,
        status: n.status,
        source: n.source,
        gen: n.gen || null,
        born_turn: n.born_turn,
        created_at: n.created_at,
        heatCount: (n.heat || []).length,
        heatNow: +(l / m).toFixed(2),
        hasVector: Array.isArray(n.vector),
        diary_ref: n.diary_ref || null,
      }
    }),
  }
}

/** 「跟对话走」：按会话 id 取该会话自己的池；会话尚无池时返回**空载荷**（empty=true）而非 404，
 *  让面板能显示「本对话还没有便签」的准确空态而不是报错。 */
export function poolPayloadForSession(sessionId, cfg) {
  const key = sessionKeyFor(sessionId)
  const pool = readJson(poolFile(key))
  if (!pool || !Array.isArray(pool.notes)) {
    return {
      key,
      sessionId: String(sessionId || ''),
      updatedAt: null,
      lastTurn: 0,
      sealed: 0,
      meta: { rounds: 0, humanRounds: 0, humanChars: 0, assistantChars: 0 },
      notes: [],
      empty: true,
    }
  }
  return poolPayload(key, pool, cfg)
}

/** 面板数据路由：/api/liubian-notes?op=pools——全池快照（卡片渲染用，只读）。
 *  webServer 获取走 ctx.reflect.get（免 inject 声明）——入口壳 main.mjs 被 ESM 缓存，
 *  热注入拿不到新声明的服务清单（checklist §3.1.3），reflect 层是官方豁免口。 */
export function mountPanelRoutes(ctx, cfg) {
  ctx.effect(() => {
    let disposed = false
    let timer = null
    let off = null
    let attempts = 0
    // M3 修复：webServer 在 apply 时可能尚未就绪——有限次重试（8×2s），不再"一次失败永久不挂"
    const tryMount = () => {
      if (disposed) return
      attempts += 1
      const webServer = (ctx.reflect && typeof ctx.reflect.get === 'function')
        ? ctx.reflect.get('webServer', false)
        : ctx.webServer
      if (!webServer || typeof webServer.register !== 'function') {
        if (attempts < 8) timer = setTimeout(tryMount, 2000)
        else ctx.logger?.warn?.(`[dsh-liubian-notes] webServer 重试 ${attempts} 次仍不可得，面板路由放弃挂载（重启/重载后恢复）`)
        return
      }
      /* 🟠-7 跨代接管（v0.5.4）：DSH 重激活时新代可能**先于**旧代释放就尝试注册，
       * 直接 register 会抛 `webserver: duplicate exact route`。旧实现让异常冒泡 →
       * 整次激活失败 → 事件钩子留在一个 disposed 实例上：它照常收 session/event、照常打印
       * 「轮封存」，但 savePool/saveRetired 被 disposed 守卫拒绝 → 便签长时间不落盘而日志无异常。
       * 现在：先释放上一代持有的注册（共享表），再注册；注册失败也不再冒泡（重试 + 告警）。 */
      if (typeof SHARED.routeOff === 'function') {
        try { SHARED.routeOff() } catch { /* 上一代可能已自行释放 */ }
        SHARED.routeOff = null
      }
      try {
        off = webServer.register({
    kind: 'exact',
    path: '/api/liubian-notes',
    async handler(req, res) {
      try {
        const url = new URL(req.url, 'http://local')
        const op = url.searchParams.get('op') || 'pools'
        if (req.method === 'POST') {
          const body = await readBody(req)
          /* 诊断留痕（管理员报「保存 api key 显示错误」时加的）：只记 op/字段名/门禁标记，**绝不记 key 值**。 */
          currentLogger?.info?.(`[dsh-liubian-notes] POST op=${op} 字段=${Object.keys(body || {}).join(',') || '(空)'}`
            + ` rendererHeader=${req.headers && req.headers['x-dsh-desktop-renderer'] ? 'yes' : 'no'}`)
          if (op === 'settings-save') {
            const r = settingsWrite(body || {})
            currentLogger?.info?.(`[dsh-liubian-notes] settings-save 写入=${r.ok ? '成功' : '失败：' + (r.error || '未知')}`)
            if (!r.ok) { sendJson(res, 500, { error: '写入失败：' + (r.error || '未知') }); return }
            sendJson(res, 200, { ok: true }); return
          }
          if (op === 'settings-test') {
            sendJson(res, 200, await settingsTest((body && body.llmApiKey) || '')); return
          }
          sendJson(res, 400, { error: '未知 POST op：' + op }); return
        }
        if (op === 'settings') {
          const s = settingsRead()
          sendJson(res, 200, {
            llmApiUrl: s.llmApiUrl, llmApiModel: s.llmApiModel,
            llmApiKeyMasked: s.llmApiKeyMasked, llmKeySet: s.llmKeySet,
          })
          return
        }
        if (op === 'pool') {
          /* 「跟对话走」：面板按当前会话 id 取该会话自己的池（会话尚无池时返回空载荷，不是 404）。 */
          const sid = url.searchParams.get('session') || ''
          if (!sid) { sendJson(res, 400, { error: 'op=pool 需要 session 参数' }); return }
          sendJson(res, 200, {
            pool: poolPayloadForSession(sid, cfg),
            heatRounds: cfg.heatRounds, poolSize: cfg.poolSize, injectTop: cfg.injectTop, aggregateRounds: cfg.aggregateRounds,
          })
          return
        }
        if (op !== 'pools') { sendJson(res, 400, { error: '未知 op：' + op }); return }
        const pools = []
        const files = existsSync(notesDir()) ? readdirSync(notesDir()).filter(x => x.endsWith('.json')) : []
        for (const f of files) {
          const key = f.replace(/\.json$/, '')
          /* 🟡-6：**纯读**——旧实现用 loadPool(key)（不传 sessionId）会把池塞进 poolCache，
           * 一旦磁盘上是坏文件（🔴-2 场景）这个只读接口就会把「空池」缓存起来，
           * 反向污染写路径。路由只读盘、不进缓存。 */
          const pool = readJson(join(notesDir(), f))
          if (!pool || !Array.isArray(pool.notes)) continue
          pools.push(poolPayload(key, pool, cfg))
        }
        pools.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        sendJson(res, 200, { pools, heatRounds: cfg.heatRounds, poolSize: cfg.poolSize, injectTop: cfg.injectTop, aggregateRounds: cfg.aggregateRounds })
      } catch (err) { sendJson(res, 500, { error: (err && err.message) || String(err) }) }
    },
        })
      } catch (err) {
        const msg = (err && err.message) || String(err)
        if (attempts < 8) {
          ctx.logger?.warn?.(`[dsh-liubian-notes] 面板路由挂载失败（第 ${attempts} 次）：${msg}——2s 后重试`
            + '（不冒泡：冒泡会打挂整次激活，把钩子留在死实例上）')
          timer = setTimeout(tryMount, 2000)
        } else {
          ctx.logger?.warn?.(`[dsh-liubian-notes] 面板路由挂载失败 ${attempts} 次，放弃挂载：${msg}`)
        }
        return
      }
      SHARED.routeOff = off
      ctx.logger?.info?.(`[dsh-liubian-notes] 面板路由已挂载 /api/liubian-notes（第 ${attempts} 次尝试）`)
    }
    tryMount()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      if (typeof off === 'function') { try { off() } catch { /* 已释放 */ } }
      /* 接管表只在仍指向本代时清空（避免把新代的注册抹掉） */
      if (SHARED.routeOff === off) SHARED.routeOff = null
    }
  }, 'dsh-liubian-notes.panel-routes')
}

function register(ctx, def) {
  // name / output 放在展开之后（防 def.name 覆盖成裸名撞内置工具——家族教训）
  const full = { ...def, name: TOOL_PREFIX + def.name, output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] } }
  const tool = defineTool ? defineTool(full) : full
  ctx.effect(() => ctx.tools.register(tool), TOOL_PREFIX + def.name)
}

/** 每轮文本量进 meta（定 R 的统计口径：human+assistant 字符 / 轮）。
 *  v0.6.0（2026-10-01）：聚合窗口已改为**吃全部内容轮**（任何形式的唤醒都算一轮）；
 *  humanRounds 仅保留为「其中含人类内容的轮数」这一统计口径，不再参与窗口过滤。 */
export function bumpStats(pool, t) {
  const h = (t.human || []).join('').length
  const a = (t.assistant || []).join('').length
  if (!h && !a) return false
  pool.meta.rounds += 1
  if (h > 0) pool.meta.humanRounds = (Number(pool.meta.humanRounds) || 0) + 1
  pool.meta.humanChars += h
  pool.meta.assistantChars += a
  return true
}

/** 轮 = **任何形式的唤醒**（被炉 @ / 留言板 / P2P 等无人类内容的轮也算），不再只算人类对话轮。
 *  v0.6.0（管理员 2026-10-01 指示）：撤回 M4 的「只收含人类内容的轮」口径——唤醒轮同样入窗、
 *  同样参与凑满 R（见 maybeAggregate 与 pre-step 的聚合调度）。
 *  ⚠ 已知代价（管理员明示接受）：唤醒密集的会话会更快填满 sealed 上限（16）并从最旧开始挤掉
 *  人类轮；超限丢弃仍会 warn 留痕，**不静默**。 */
export function shouldSealTurn(turn) {
  if (!turn) return false
  const h = Array.isArray(turn.human) ? turn.human.length : 0
  const a = Array.isArray(turn.assistant) ? turn.assistant.length : 0
  return !!(h || a)
}

export function apply(ctx, input = {}) {
  const cfg = resolveConfig(input)
  currentLogger = ctx.logger || null      // 🟡-1：模块级日志句柄，落盘/隔离失败要能留痕
  currentCtx = ctx                         // v0.6.3：服务通道句柄（reflect.get('kotatsuBoard')）
  if (cfg.enabled === false) {
    ctx.logger?.info?.('[dsh-liubian-notes] 已通过配置停用（enabled=false），本轮不挂载任何钩子与工具')
    return
  }

  // 面板数据路由：/api/liubian-notes（对话内「流变便签」栏的卡片数据源）
  mountPanelRoutes(ctx, cfg)

  register(ctx, {
    name: 'note',
    description: '流变·便签（本对话的短期记忆池）。action=list 看池+热度；show 读全文；'
      + 'stick 主动挂起便签（head=一句话简介即向量来源，body=正文；与自动便签同规则）；'
      + 'promote 升格请求（产出语义 slug + 三段式并直发银杏校验，家族由银杏定；**池满时会自动触发并把该便签移出池**）；'
      + 'unqueue 解除待固化（queued→active 并摘除 pending 条目，串池误标后的修复路径）；drop/restore 回收站。'
      + '默认操作本对话的池（＝调用方会话）；session 可选，用于显式指定别的会话。',
    parameters: {
      action: { type: 'string', required: true, description: 'list | show | stick | promote | unqueue | drop | restore', enum: ['list', 'show', 'stick', 'promote', 'unqueue', 'drop', 'restore'] },
      head: { type: 'string', description: 'stick 用：便签头（一句话简介，向量来源）' },
      body: { type: 'string', description: 'stick 用：便签正文' },
      id: { type: 'string', description: 'show/promote/unqueue/drop/restore 用：便签 ID，如 NT-1' },
      session: { type: 'string', description: '可选：会话标识；省略即本对话的池（＝调用方会话）；解析不到调用方会话时明确报错，不会回落到其他会话的池' },
      workspace: { type: 'string', description: 'promote 用：目标工作区（默认记忆侧配置）' },
      /* v0.7.0：补声明 —— 实现里 list/stick/restore 三处都在读 args.nowTurn，
       * 而 schema 一直没有它 → 任何照 schema 调的调用方永远拿不到（list 因此永远只能显示
       * 「N 条」原始记录数、显示不出 l/m 热度窗口分）。同类缺口参考：wiki move 的 newFamilyPath。 */
      nowTurn: { type: 'number', description: '可选：当前回合号。list 用它把热度显示成 l/m 窗口分；stick/restore 用它标 born_turn（省略则按池内进度推定）' },
    },
    async execute(args, exec) {
      // 🔴-9：第 2 形参（调用方上下文）必须转发——旧包装只接 args，exec 被丢掉，
      // 于是"取调用方会话"整条链拿不到数据，只能回落「最后活跃池」。
      try { return await noteToolAction(cfg, args || {}, ctx.logger, exec) }
      catch (err) { return '[错误] ' + ((err && err.message) || String(err)) }
    },
  })

  /* 🟠-7（v0.5.4）：钩子释放器**显式收集**。事故里一条激活失败路径没有清掉监听，
   * 于是「已卸载实例」继续收 session/event：照常打「轮封存」、落盘却全被 disposed 拒绝
   * （日志看起来一切正常，便签却几小时不落盘）。卸载时手动摘掉，不再指望框架替我清。 */
  const hookOffs = []
  const keepHook = (off) => { if (typeof off === 'function') hookOffs.push(off); return off }

  // 采集：session/event——封存窗口与进行中轮次直接持久化进池文件（v0.3.0：废除内存缓冲）
  keepHook(ctx.on('session/event', (session, event) => {
    try {
      if (!session || !event) return
      /* 🟠-6（v0.5.3）：**已卸载实例仍被回调时不得静默**。
       * 事故：路由/钩子留在一个 disposed 实例上，轮结束照常打印「轮封存」，但 savePool 被 disposed
       * 守卫静默拒绝 → 便签 2 小时未落盘而日志毫无异常（管理员保存设置报错才暴露）。 */
      if (disposed) { warnDisposedOnce('session/event 采集'); return }
      const id = String(session.id)
      const pool = loadPool(sessionKeyFor(id), id)
      switch (event.type) {
        case 'turn/start':
          pool.current = { turn: (event.data && event.data.turn) || pool.sealed.length + 1, human: [], assistant: [], tools: [] }
          break
        case 'user/message':
          if (pool.current && isHumanMessage(event.data)) {
            const t = messageText(event.data).trim()
            if (t) { pool.current.human.push(t); savePool(pool) }
          }
          break
        case 'assistant/message':
          if (pool.current && event.data && event.data.message) {
            const t = messageText(event.data.message).trim()
            if (t) pool.current.assistant.push(t)
          }
          break
        case 'tool/call':
          if (pool.current && event.data && event.data.name) pool.current.tools.push(String(event.data.name))
          break
        case 'turn/end': {
          if (!pool.current) break
          const ended = pool.current                       // 先留引用（下面会置空）
          const sealedNow = shouldSealTurn(ended)           // v0.6.0：任何形式的唤醒都算一轮
          if (sealedNow) {
            pool.sealed.push(ended)
            if (pool.sealed.length > 16) {
              const dropped = pool.sealed.shift()
              // 🟡-4：超限丢的是**最旧的人类轮**，必须留痕（否则是无声的记忆缺口）
              currentLogger?.warn?.(
                `[dsh-liubian-notes] sealed 超限（16）→ 丢弃最旧轮 t${dropped && dropped.turn}（聚合滞后或人类轮过快时发生）`,
              )
            }
          }
          const counted = bumpStats(pool, ended)
          /* 🟠-4：**先清 current 再落盘**。旧顺序是 push(sealed) → savePool → current=null，
           * 于是磁盘上每次"轮结束"都把同一轮同时留在 sealed 末尾与 current 里；
           * 若进程死在该窗口，重启后 current 被读回，该轮可能被二次封存/二次聚合。 */
          pool.current = null
          savePool(pool)
          // 诊断（P1 观察封存节奏用）
          ctx.logger?.info?.(
            `[dsh-liubian-notes] 轮封存 t${ended.turn}：human=${ended.human.length} assistant=${ended.assistant.length}`
            + `｜${sealedNow ? '入窗' : '跳过（无内容）'} sealed=${pool.sealed.length}`
            + ` humanRounds=${Number(pool.meta.humanRounds) || 0} rounds=${pool.meta.rounds}${counted ? '' : '（无内容不计轮）'}`,
          )
          break
        }
        default: break
      }
    } catch { /* 采集失败不影响对话 */ }
  }))

  // 注入 + 聚合触发：agent/pre-step（普通注册——排在 dsh-liubian 之后，我们的块离生成点最近）
  keepHook(ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    // 整段兜住：便签只是附带功能，绝不拖垮用户这一轮
    try {
      if (!decision || decision.kind !== 'enter' || signal?.aborted) return decision
      const sessionId = String(agent?.session?.id ?? '')
      if (!sessionId) return decision
      const key = sessionKeyFor(sessionId)
      const pool = loadPool(key, sessionId)
      /* v0.6.2：**回合标识必须来自真实轮次**。
       * 旧实现用「人类消息条数」（decision.messages 里 role=user 且非插件来源的条数）当回合号——
       * 而 pre-step 的 messages **只带本回合的提示**，于是它恒等于 1（全库实证：**每个池的
       * lastTurn 都是 1**、所有 heat 记录取值都是 1、所有便签 born#t1）。后果三条，全部实测：
       *   ① `injectionAlreadyDone(key, 1)` 一旦注入过，此后**每一轮**都被判成"本回合已注入" →
       *      **注入被永久抑制**（022e38e8 跑到第 231 轮只有 7 次注入≈每个进程生命周期只注一次）；
       *   ② 注入记的热度全是同一回合号 → l/m 热度窗口失真 → 赛马排序失真；
       *   ③ born_turn 恒为 1。
       * 改用 `pool.current.turn`（turn/start 事件的真实轮次，实测 t229/t230/t231），
       * 取不到时回退 `meta.rounds + 1`；两者取 max 保证单调不回退，且同轮内稳定。 */
      const turnToken = Math.max(
        Number(pool.current && pool.current.turn) || 0,
        (Number(pool.meta && pool.meta.rounds) || 0) + 1,
      )
      /* v0.6.0：**任何形式的唤醒都算一轮** → 聚合调度移出「有人类提问」这道门。
       * 旧实现下唤醒轮的 prompt 为空、在下面早退，聚合**永不触发**。scheduleAggregate 自带
       * 同会话去重，且 maybeAggregate 只在窗口凑满 R 时才动，重复调用是廉价 no-op。
       * ⚠ 只把**聚合**移出门外；**注入仍只发生在人类轮**（唤醒轮不注 <liubian-notes>，避免注入块膨胀）。 */
      scheduleAggregate(ctx, cfg, sessionId, pool, turnToken)
      /* v0.7.0 自动升格：**池满才动**（graduateOnce 内部判），服务不可用则留在池内 */
      scheduleGraduate(ctx, cfg, pool)
      const prompt = currentPrompt(decision.messages)
      if (!prompt) return decision   // 同轮后续步不重复注入（注入面）
      // 记录当前回合号（面板热度分按它算 l/m；lastTurn 持久化在池文件里）
      if (pool.lastTurn !== turnToken) { pool.lastTurn = turnToken; savePool(pool) }
      /* 🟠-1：同轮去重（内存态 token）。pre-step 在**同一步可能被多次调用**（重试/多段生成），
       * 旧实现只有 `if (!prompt) return` 一道守卫，于是同一回合会被重复注入
       * ——上下文里出现多份整块 <liubian-notes>，且每条命中便签被重复记热度。
       * v0.6.2 更正一处历史归因：池文件里那些 [1,1] / [16,16] 指纹**不只是**同轮重复，
       * 主因是回合标识恒为 1（见 pre-step 段注释）——所有注入都挤在同一个回合号上，
       * 热度 l/m 因此被灌水、赛马排序失真。
       * 参照同族已验证写法（dsh-liubian 的 state.turnReminderCount !== 回合号）：
       * 真实轮次在同一步重试时不变，天然是"本回合"的稳定标识。
       * 用内存态而非 pool.lastTurn：持久化的话重启后首轮会被误抑制。 */
      if (injectionAlreadyDone(key, turnToken)) return decision   // 本回合已注入过（同轮重试/多段生成）
      // ① 自动聚合已在上方调度（v0.6.0：唤醒轮同样触发）
      // ② 向量注入：该轮对话 + 上一轮完整问答 作查询
      const prev = previousQAPair(decision.messages, messageText, isHumanMessage)
      const block = await injectionBlock(pool, cfg, composeQueryText(prompt, prev), turnToken)
      if (!block) return decision
      markInjectionDone(key, turnToken)
      return { kind: 'enter', messages: [...decision.messages, pluginMessage(block, 'recall')] }
    } catch (err) {
      ctx.logger?.warn?.(`[dsh-liubian-notes] 本轮注入失败（已忽略，不影响对话）: ${(err && err.message) || err}`)
      return decision
    }
  }))

  ctx.effect(() => {
    /* 🔴-8（v0.5.5 修复）：**清理逻辑必须在返回的 disposer 里**。
     * `ctx.effect(fn)` 的 fn 是「立即执行」的注册面（同文件和 mountPanelRoutes 都是这个语义），
     * 旧写法把 `disposed = true` 放在 fn 体里 → **挂载瞬间就自我标记已卸载** →
     * 该实例此后所有 savePool/saveRetired 全被自家守卫拒绝：日志照打「轮封存」、聚合照跑，
     * 便签却再也不落盘（14:44 起线上池文件停更数小时），且**重启也治不好**（新实例同样生来 disposed）。
     */
    return () => {
      /* 🟠-3：卸载本实例时置 disposed —— 在途异步闭包（聚合最长 120s）此后不得再 savePool，
       * 否则它会把旧快照整份写回、覆盖新实例期间的写入。
       * ⚠ 只清**本实例**的 poolCache；共享守卫（池锁 / 聚合在飞 / 同轮 token）**不清**，
       * 它们属于进程内其它仍存活的实例。 */
      disposed = true
      poolCache.clear()
      /* 🟠-7：显式摘掉本实例的钩子——否则「已卸载实例继续收 session/event」会重演 */
      for (const offFn of hookOffs) { try { offFn() } catch { /* 已摘 */ } }
      hookOffs.length = 0
    }
  }, 'dsh-liubian-notes: 卸载时标记实例已卸载、清池缓存并摘钩子')

  ctx.logger?.info?.(
    `[dsh-liubian-notes] v${PLUGIN_VERSION} 便签已挂载：池 ${cfg.poolSize}/注入 ${cfg.injectTop}/R ${cfg.aggregateRounds}`
    + `（m=${cfg.heatRounds}）/判重 ${cfg.dedupThreshold}，向量 ${cfg.embedUrl}`
    + `，聚合LLM=${cfg.noteLlmGen ? '开（' + cfg.diaryApiModel + '）' : '关（拼接回退）'}`
    + `，固化=缓存制，工具 ${TOOL_PREFIX}note`
    + `${defineTool ? '' : '（defineTool 缺失，裸对象注册）'}`,
  )
}

/* ── 纯函数测试缝（dev_stage_add 挂 staging 工具 import 本文件调 __test）── */
export const __test = {
  resolveConfig, configFile, memoryConfigFile, diaryApiConfigFile, sessionKeyFor, callerSessionOf,
  cosine, pruneHeat, heatScore, heatCountAt, withPoolLock,
  buildNoteBody, buildAutoHead, composeQueryText,
  previousQAPair, buildNotesBlock, buildPackPrompt, generateNoteViaLlm,
  addNoteToPool, loadPool, savePool, loadRetired, saveRetired, injectionBlock,
  maybeAggregate, noteToolAction, embedTexts, pluginMessage, messageText,
  isHumanMessage, currentPrompt, bumpStats, shouldSealTurn, pendingPromotionsFile, removePendingEntry,
  pendingEntry, buildPromoteRequest, fallbackPromoteRequest, slugifyHead, serviceOf, __testSetCtx,
  topHeatNote, graduateOnce, scheduleGraduate, appendPending, raceEvict, racableNotes,
  /* L157 `function quarantinePool(key)`（坏池隔离）、L683 `export function pendingHasId(...)`（promote 幂等） */
  pendingHasId, quarantinePool,
  injectionAlreadyDone, markInjectionDone, backfillVectors,
  poolPayload, poolPayloadForSession,
  settingsRead, settingsWrite, settingsTest, settingsRaw,
  MEMORY_KEYS, DEFAULTS, notesDir,
}
