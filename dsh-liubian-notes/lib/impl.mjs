/**
 * dsh-liubian-notes —— 流变·便签（实现主体）
 *
 * 定位：流变·记忆的短期记忆互补件。会话内便签池（定量 10 篇），
 * 便签 = 便签头（简介，唯一向量来源）+ 便签正文；
 * 双来源：自动多轮聚合（每 R 轮一篇）+ 智能体主动挂起（stick，与普通便签无区别）；
 * 每轮按便签头向量余弦最近注入 n=3 篇（热记忆），注入记 1 条热度、独立维持 m=R 回合；
 * 热度分 = l/m；池满赛马踢最低分、最新顶替；头向量相似度 >0.90 判重拒收；
 * 热度最高者每 K 轮送交流变记忆审核固化（P1 先做手动 promote）。
 *
 * 实现对照 dsh-liubian 的已验证模式：
 *   main.mjs 入口壳（缓存戳动态导入）/ pluginMessage 四要件（回退分支必须带 uuid）/
 *   session/event 采集（免疫上下文压缩）/ agent/pre-step 注入（整段 try/catch）/
 *   8082 本地嵌入服务 / 工具经 ctx.effect + ctx.tools.register。
 * 方案文档：E:\DSH_data\流变系统\docs\便签系统_DSH实施方案.md（v2.1）
 */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ── 可选依赖：有 junction 就用 defineTool，没有就退回裸对象（绝不因依赖挂掉插件）── */
let defineTool = null
try {
  const t = await import('@deepseek-ai/dsh-tools')
  if (typeof t.defineTool === 'function') defineTool = t.defineTool
} catch { defineTool = null }

/* ── 插件消息构造：@deepseek-ai/dsh-llm 只在宿主 asar 里，插件侧 import 必然失败，
 *    回退分支必须自己补 uuid（缺 id 会写坏宿主会话日志——见 dsh-plugin-checklist §3.3.1）── */
let createUserMessageFn = null
try {
  const llm = await import('@deepseek-ai/dsh-llm')
  if (typeof llm.createUserMessage === 'function') createUserMessageFn = llm.createUserMessage
} catch { createUserMessageFn = null }

export const PLUGIN_VERSION = '0.2.2'
export const PLUGIN_SOURCE = 'dsh-liubian-notes'
const TOOL_PREFIX = '_dsh_external_dsh_liubian_'

const HOME = process.env.USERPROFILE || process.env.HOME || 'C:/Users/Feng'
export const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh')

/** 全部默认值。可被 ~/.dsh/liubian-notes/config.json 或宿主传入 config 覆盖。 */
export const DEFAULTS = {
  enabled: true,
  poolSize: 10,              // 池容量 N（管理员 2026-10-01 定案，后期实践再议）
  injectTop: 3,              // 每轮注入 n 篇（热记忆）
  aggregateRounds: 5,        // 聚合周期 R（默认 5 起跑；待实测平均每轮文本量后定值）
  heatRounds: 0,             // 热度寿命 m；0 = 跟随 R（管理员定案 m=R，新旧交替配对）
  dedupThreshold: 0.90,      // 便签头余弦相似度 > 此值判重拒收
  reviewEveryK: 20,          // 送审节拍（P2 用；P1 只有手动 promote）
  retireAfterDays: 30,       // 会话死后便签保留天数（P2 用）
  injectBudgetChars: 2000,   // 单轮注入块字符预算
  noteBodyInjectChars: 400,  // 注入时单篇正文截断
  minSim: 0,                 // 注入相似度下限（0 = 不设，照方案默认）
  // 向量服务（复用 dsh-liubian-embed 拉起的 llama.cpp，HTTP 调用零包依赖）
  embedUrl: 'http://127.0.0.1:8082/v1/embeddings',
  embedModel: 'qwen3-emb',
  embedDim: 1024,
  embedTimeoutMs: 60000,
  // 手动 promote 时写流变记忆（memory.py 匿名写入，工作区由 cwd 决定）。
  // ⚠ 2026-10-01 与记忆向量交接收口：python / memoryScript / liubianRoot / workspace /
  // memoryTimeoutMs 这 5 项属于记忆侧领域配置，**单一来源 = ~/.dsh/liubian/config.json**
  // （键名即契约，只在记忆侧改）；此处不设默认，缺键回落 MEMORY_FALLBACKS。
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
  // 记忆侧 5 键：~/.dsh/liubian/config.json（单一来源）> 显式 input > 兜底
  const memCfg = readJson(memoryConfigFile()) || {}
  for (const k of MEMORY_KEYS) {
    if (memCfg[k] !== undefined) cfg[k] = memCfg[k]
    else if (cfg[k] === undefined) cfg[k] = MEMORY_FALLBACKS[k]
  }  cfg.poolSize = Math.max(1, Number(cfg.poolSize) || 10)
  cfg.injectTop = Math.max(1, Number(cfg.injectTop) || 3)
  cfg.aggregateRounds = Math.max(1, Number(cfg.aggregateRounds) || 5)
  cfg.heatRounds = Number(cfg.heatRounds) > 0 ? Number(cfg.heatRounds) : cfg.aggregateRounds
  cfg.dedupThreshold = Math.min(0.999, Math.max(0.5, Number(cfg.dedupThreshold) || 0.90))
  cfg.injectBudgetChars = Math.max(400, Number(cfg.injectBudgetChars) || 2000)
  return cfg
}

/* ──────────────────────────────────────────────────────────────────────────
 * 1. 存储：~/.dsh/liubian-notes/pools/<会话8位>.json + <会话8位>.retired.jsonl
 *    不碰 ~/.dsh/liubian/、不碰 liubian.db。会话键 = SHA256(sessionId) 前 8 位
 *    （与被炉房间 ID 同源）。
 * ────────────────────────────────────────────────────────────────────────── */

export function notesDir() { return join(DSH_HOME, 'liubian-notes', 'pools') }
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
    meta: { rounds: 0, humanChars: 0, assistantChars: 0 },  // 平均每轮文本量统计（定 R 用）
    notes: [],
  }
}

const poolCache = new Map()

function loadPool(key, sessionId) {
  let pool = poolCache.get(key)
  if (pool) return pool
  const raw = readJson(poolFile(key))
  pool = raw && Array.isArray(raw.notes) ? raw : newPool(key, sessionId)
  poolCache.set(key, pool)
  return pool
}

function savePool(pool) {
  pool.updatedAt = new Date().toISOString()
  try {
    mkdirSync(notesDir(), { recursive: true })
    writeFileSync(poolFile(pool.sessionKey), JSON.stringify(pool, null, 2), 'utf8')
  } catch { /* 落盘失败下轮重试，不影响本轮 */ }
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
  try {
    mkdirSync(notesDir(), { recursive: true })
    writeFileSync(retiredFile(key), list.map(n => JSON.stringify(n)).join('\n') + (list.length ? '\n' : ''), 'utf8')
  } catch { /* 忽略 */ }
}

/** 工具面默认会话：pre-step 每轮刷新；工具调用省略 session 参数时用它。 */
let lastActiveKey = ''
let lastActiveSessionId = ''
function touchActive(key, sessionId) { lastActiveKey = key; lastActiveSessionId = String(sessionId ?? '') }
function defaultKey() {
  if (lastActiveKey) return { key: lastActiveKey, sessionId: lastActiveSessionId }
  try {
    const files = readdirSync(notesDir()).filter(f => f.endsWith('.json'))
    if (files.length === 1) {
      const key = files[0].replace(/\.json$/, '')
      return { key, sessionId: '' }
    }
  } catch { /* 目录还没有 */ }
  return { key: '', sessionId: '' }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 2. 向量：复用 8082（llama.cpp /v1/embeddings，qwen3-emb）。失败返回 null → 降级。
 * ────────────────────────────────────────────────────────────────────────── */

export async function embedTexts(cfg, texts, timeoutMs = 60000) {
  const list = (Array.isArray(texts) ? texts : [texts]).map(t => String(t || '').trim()).filter(Boolean)
  if (!list.length) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs || cfg.embedTimeoutMs)
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

/** 剪掉过期热度记录（原地），返回未过期条数 l。 */
export function pruneHeat(note, nowTurn, m) {
  if (!Array.isArray(note.heat)) note.heat = []
  const keep = note.heat.filter(t => (Number(nowTurn) - Number(t)) < m && (Number(nowTurn) - Number(t)) >= 0)
  note.heat = keep
  return keep.length
}

/** 热度分 = l/m ∈ [0,1]。 */
export function heatScore(note, nowTurn, m) {
  const l = pruneHeat(note, nowTurn, m)
  return l / Math.max(1, Number(m) || 1)
}

/* ──────────────────────────────────────────────────────────────────────────
 * 4. 便签构造（纯函数）
 * ────────────────────────────────────────────────────────────────────────── */

function firstLine(text, max) {
  const s = String(text || '').split('\n').map(x => x.trim()).filter(Boolean)[0] || ''
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** 自动聚合便签的正文：窗口内每轮一行结构化记录（零 LLM）。 */
export function buildNoteBody(turns) {
  return turns.map(t => {
    const q = firstLine((t.human || []).join(' '), 80)
    const a = firstLine((t.assistant || []).join(' '), 120)
    const tools = (t.tools || []).length ? `｜工具:${(t.tools || []).slice(0, 4).join(',')}` : ''
    return `#t${t.turn} 问:${q || '（无）'}｜答:${a || '（无）'}${tools}`
  }).join('\n')
}

/** 自动聚合便签的头：各轮提问首行拼接（简介形态；P2 换外部 API 生成）。 */
export function buildAutoHead(turns, maxChars = 120) {
  const parts = turns.map(t => firstLine((t.human || []).join(' '), 40)).filter(Boolean)
  const head = parts.join('；')
  return head.length > maxChars ? head.slice(0, maxChars) + '…' : (head || '（空窗口）')
}

/** 查询文本 = 该轮对话 + 上一轮完整问答（管理员 2026-10-01 定案）。 */
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

/** 注入块（预算 ≤ injectBudgetChars 字符）。 */
export function buildNotesBlock(selected, cfg, poolSize) {
  if (!selected || !selected.length) return ''
  const lines = selected.map(s => {
    const head = String(s.note.head || '').slice(0, 80)
    const body = clip(s.note.body, cfg.noteBodyInjectChars)
    return `【${s.note.id}｜热度 ${s.heat.toFixed(2)}｜sim ${s.sim.toFixed(2)}】${head}\n${body}`
  })
  let text = `<liubian-notes source="${PLUGIN_SOURCE}">\n` +
    `以下是本对话的便签（热记忆 ${selected.length}/${poolSize}；按便签头向量余弦选出，未注入者为冷记忆，可用 _dsh_external_dsh_liubian_note 查看全池）：\n` +
    lines.join('\n---\n') + '\n</liubian-notes>'
  if (text.length > cfg.injectBudgetChars) {
    const short = selected.map(s => `【${s.note.id}｜sim ${s.sim.toFixed(2)}】${String(s.note.head || '').slice(0, 80)}`)
    text = `<liubian-notes source="${PLUGIN_SOURCE}">\n` +
      `本对话便签（热记忆，正文从略，全文用 _dsh_external_dsh_liubian_note show 查）：\n` +
      short.join('\n') + '\n</liubian-notes>'
  }
  return text
}

function clip(text, max) {
  const s = String(text || '')
  return s.length <= max ? s : s.slice(0, max) + '…'
}

/* ──────────────────────────────────────────────────────────────────────────
 * 5. 入池：判重（>阈值拒收，回收站也参与）→ 赛马（满员踢最低分）→ 落盘
 * ────────────────────────────────────────────────────────────────────────── */

function activeNotes(pool) { return pool.notes.filter(n => n.status !== 'submitted') }

/** 判重：与池内 + 回收站全部便签头比余弦（回收站参与，防淘汰-重录死循环）。返回命中的重复对象或 null。 */
function findDuplicate(pool, vec, threshold) {
  if (!vec) return null
  const retired = loadRetired(pool.sessionKey)
  for (const n of [...pool.notes, ...retired]) {
    if (!Array.isArray(n.vector)) continue
    if (cosine(vec, n.vector) > threshold) return { id: n.id, where: pool.notes.includes(n) ? '池内' : '回收站' }
  }
  return null
}

/** 赛马：满员（按非 submitted 计）踢热度分最低者（并列踢 born 最旧）入回收站。 */
function raceEvict(pool, cfg, nowTurn) {
  let evicted = null
  while (activeNotes(pool).length >= cfg.poolSize) {
    let worst = null
    for (const n of activeNotes(pool)) {
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

/** 入池主流程（判重 → 赛马 → 向量补齐 → 落盘）。draft 传已有便签对象（restore）则保留原 ID。
 *  返回 {ok, note?, reason?}。 */
export async function addNoteToPool(pool, draft, cfg, nowTurn) {
  const isReAdd = !!(draft && draft.id && draft.created_at)
  const taken = new Set([...pool.notes.map(n => n.id), ...loadRetired(pool.sessionKey).map(n => n.id)])
  let seq = pool.notes.length + 1 + taken.size
  let id = isReAdd ? draft.id : `NT-${seq}`
  while (!isReAdd && taken.has(id)) { seq += 1; id = `NT-${seq}` }
  const note = isReAdd
    ? { ...draft, status: 'active' }
    : {
        id,
        head: String(draft.head || '').trim() || '（无头）',
        body: String(draft.body || '').trim(),
        vector: null,
        source: draft.source === 'manual' ? 'manual' : 'auto',
        born_turn: Number(nowTurn) || 0,
        heat: [],
        diary_ref: null,
        submit_attempts: 0,
        status: 'active',
        created_at: new Date().toISOString(),
      }
  // 判重
  const vecs = await embedTexts(cfg, [note.head])
  if (vecs && vecs[0]) note.vector = vecs[0]
  const dup = findDuplicate(pool, note.vector, cfg.dedupThreshold)
  if (dup) return { ok: false, reason: `判重拒收：与${dup.where}便签 ${dup.id} 相似度超过 ${cfg.dedupThreshold}`, note }
  // 赛马
  const evicted = raceEvict(pool, cfg, nowTurn)
  pool.notes.push(note)
  savePool(pool)
  return { ok: true, note, evicted }
}

function countRetired(pool) {
  return loadRetired(pool.sessionKey).length
}

/* ──────────────────────────────────────────────────────────────────────────
 * 6. 轮次采集（session/event，照抄 dsh-liubian：免疫上下文压缩）
 * ────────────────────────────────────────────────────────────────────────── */

const buffers = new Map()

function bufferFor(sessionId) {
  const id = String(sessionId)
  let buf = buffers.get(id)
  if (!buf) {
    buf = { current: null, sealed: [] }   // sealed 最多留 16 条（R 窗口 + 余量）
    buffers.set(id, buf)
  }
  return buf
}

/** 每轮人类文本量进 meta（定 R 的统计口径：human+assistant 字符 / 轮）。 */
function bumpStats(pool, t) {
  const h = (t.human || []).join('').length
  const a = (t.assistant || []).join('').length
  if (!h && !a) return false
  pool.meta.rounds += 1
  pool.meta.humanChars += h
  pool.meta.assistantChars += a
  return true
}

/** 自动聚合：sealed 里凑满 R 个人类轮 → 打包成一篇便签（循环清空积压）。 */
async function maybeAggregate(pool, buf, cfg, nowTurn, logger) {
  while (true) {
    const window = []
    while (buf.sealed.length && window.length < cfg.aggregateRounds) {
      const t = buf.sealed[0]
      if (!t || !(t.human || []).length) { buf.sealed.shift(); continue }  // 无人声的封存轮直接丢弃
      window.push(buf.sealed.shift())
    }
    if (window.length < cfg.aggregateRounds) {
      buf.sealed.unshift(...window)   // 凑不满一个窗口，原样放回
      return null
    }
    const draft = { head: buildAutoHead(window), body: buildNoteBody(window), source: 'auto' }
    const res = await addNoteToPool(pool, draft, cfg, nowTurn)
    logger?.info?.(
      `[dsh-liubian-notes] 自动聚合入池 ${res.ok ? `${res.note.id}「${firstLine(res.note.head, 30)}」` : `被拒（${res.reason}）`}` +
      (res.evicted ? `，赛马淘汰 ${res.evicted.id}` : ''),
    )
    if (!res.ok && res.note) { /* 被判重的便签不重试（内容还会随窗口演进） */ }
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 7. 注入（agent/pre-step）：查询向量 → 余弦选 top-n → 记热度 → 追加块
 * ────────────────────────────────────────────────────────────────────────── */

/* - 消息工具（照抄 dsh-liubian 的判定函数）- */

function pluginMessage(content, form) {
  // v4 会话格式：外部插件必须用 producer-owned kind 'plugin:<包名>'
  const source = { kind: 'plugin:' + PLUGIN_SOURCE, form }
  if (createUserMessageFn) {
    return createUserMessageFn({ content: [{ type: 'text', text: content }], source })
  }
  // 回退分支必须带 id（缺 id = 整个会话历史打不开的血案）
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

/** 本轮真正的人话（倒找第一条人类消息）。 */
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

function previousAssistantText(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i]
    if (m && m.role === 'assistant') {
      const t = messageText(m).trim()
      if (t) return t
    }
  }
  return ''
}

/** 向量缺失的便签惰性补齐（服务恢复后自愈）。返回是否全部就绪。 */
async function backfillVectors(pool, cfg) {
  const missing = pool.notes.filter(n => n.status !== 'retired' && !Array.isArray(n.vector))
  if (!missing.length) return true
  const vecs = await embedTexts(cfg, missing.map(n => n.head))
  if (!vecs) return false
  missing.forEach((n, i) => { if (vecs[i]) n.vector = vecs[i] })
  savePool(pool)
  return missing.every(n => Array.isArray(n.vector))
}

/** 每轮注入主流程。返回注入块文本（空串 = 本轮不注）。 */
export async function injectionBlock(pool, cfg, queryText, nowTurn) {
  const ready = await backfillVectors(pool, cfg)
  const eligible = pool.notes.filter(n => n.status !== 'retired' && Array.isArray(n.vector))
  if (!eligible.length) return ''
  const qv = await embedTexts(cfg, [queryText])
  if (!qv || !qv[0]) return ''   // 8082 不可用 → 静默降级（只存不注）
  const ranked = eligible
    .map(note => ({ note, sim: cosine(qv[0], note.vector), heat: heatScore(note, nowTurn, cfg.heatRounds) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, cfg.injectTop)
  if (cfg.minSim > 0) {
    const kept = ranked.filter(r => r.sim >= cfg.minSim)
    if (!kept.length) return ''
    for (const r of kept) r.note.heat.push(nowTurn)
    savePool(pool)
    return buildNotesBlock(kept, cfg, cfg.poolSize)
  }
  for (const r of ranked) r.note.heat.push(nowTurn)   // 每被注入一次记 1 条热度
  savePool(pool)
  return buildNotesBlock(ranked, cfg, cfg.poolSize)
}

/* ──────────────────────────────────────────────────────────────────────────
 * 8. 工具面：_dsh_external_dsh_liubian_note
 * ────────────────────────────────────────────────────────────────────────── */

function resolveSessionArg(args) {
  const explicit = String(args.session || '').trim()
  if (explicit) return { key: sessionKeyFor(explicit), sessionId: explicit }
  const d = defaultKey()
  if (!d.key) return null
  return d
}

/** 工具动作实现（导出给 __test / 工具壳共用，保证测的就是跑的）。 */
export async function noteToolAction(cfg, args = {}, logger) {
  const action = String(args.action || 'list').trim()
  if (action === 'list') {
    let key = String(args.session || '').trim()
      ? sessionKeyFor(args.session)
      : (defaultKey().key || '')
    const pools = []
    if (key) pools.push(loadPool(key, args.session))
    else {
      try {
        for (const f of readdirSync(notesDir()).filter(f => f.endsWith('.json'))) {
          const raw = readJson(join(notesDir(), f))
          if (raw) pools.push(raw)
        }
      } catch { /* 目录还没有 */ }
    }
    if (!pools.length) return '[空] 还没有任何便签池（自动聚合每 ' + cfg.aggregateRounds + ' 轮一篇，或用 stick 主动挂起）。'
    const m = cfg.heatRounds
    return pools.map(pool => {
      const avg = pool.meta.rounds ? ((pool.meta.humanChars + pool.meta.assistantChars) / pool.meta.rounds).toFixed(0) : '0'
      const lines = pool.notes.map(n => {
        const l = pruneHeat(n, Number(args.nowTurn) || 0, m)
        const heat = Number(args.nowTurn) ? (l / m).toFixed(2) : `${n.heat.length}条`
        const vec = Array.isArray(n.vector) ? '有向量' : '无向量'
        return `  ${n.id} [${n.source}${n.status !== 'active' ? '/' + n.status : ''}] 热度${heat} ${vec} born#t${n.born_turn}${n.diary_ref ? ' →' + n.diary_ref : ''}：${firstLine(n.head, 50)}`
      })
      const retiredN = loadRetired(pool.sessionKey).length
      return `池 ${pool.sessionKey}（${pool.notes.length}/${cfg.poolSize}，回收站 ${retiredN}；已统计 ${pool.meta.rounds} 轮，均 ${avg} 字/轮）\n${lines.join('\n') || '  （空池）'}`
    }).join('\n\n')
  }

  const sess = resolveSessionArg(args)
  if (!sess) return '[提示] 还没有活跃便签池：先对话几轮（每 ' + cfg.aggregateRounds + ' 轮自动聚合一篇），或先在对话里触发一次注入。'
  const pool = loadPool(sess.key, sess.sessionId)
  touchActive(sess.key, sess.sessionId)

  if (action === 'stick') {
    const head = String(args.head || '').trim()
    const body = String(args.body || '').trim()
    if (!head || !body) return '[错误] stick 需要 head（一句话简介，将作为向量来源）与 body（便签正文）。'
    const res = await addNoteToPool(pool, { head, body, source: 'manual' }, cfg, Number(args.nowTurn) || pool.meta.rounds)
    if (!res.ok) return `[拒收] ${res.reason}`
    return `已挂起 ${res.note.id}「${firstLine(res.note.head, 40)}」入池（${pool.notes.filter(n => n.status !== 'submitted').length}/${cfg.poolSize}）` +
      (res.evicted ? `；赛马淘汰 ${res.evicted.id}（入回收站，可 restore）` : '')
  }

  if (action === 'show') {
    const note = pool.notes.find(n => n.id === String(args.id || '')) ||
      loadRetired(pool.sessionKey).find(n => n.id === String(args.id || ''))
    if (!note) return `[未找到] 便签 ${args.id}（list 先看池）。`
    return `# ${note.id}（${note.source}${note.status !== 'active' ? '/' + note.status : ''}，born#t${note.born_turn}，热度记录 ${(note.heat || []).join(',')}）\n头：${note.head}\n正文：\n${note.body}${note.diary_ref ? `\n归档：${note.diary_ref}` : ''}`
  }

  if (action === 'promote') {
    const note = pool.notes.find(n => n.id === String(args.id || ''))
    if (!note) return `[未找到] 便签 ${args.id}。`
    if (note.status === 'submitted') return `[跳过] ${note.id} 已提交（${note.diary_ref}）。`
    const ws = String(args.workspace || cfg.workspace || '工作组').trim()
    const tags = buildPromoteTags(note.head, ws)
    const argv = ['write', '-t', tags.join(','), '-s', clip(note.head, 80), '-k', 'log']
    const content = `【流变·便签归档】会话 ${pool.sessionKey}｜便签 ${note.id}｜born#t${note.born_turn}\n\n头：${note.head}\n\n正文：\n${note.body}`
    let out
    if (Buffer.byteLength(content, 'utf8') < 20000) {
      argv.push('--content', content)
      out = await runMemoryWrite(cfg, argv, ws)
    } else {
      const file = mkdtempSync(join(tmpdir(), 'liubian-notes-')) + '\\payload.txt'
      writeFileSync(file, content, 'utf8')
      try { out = await runMemoryWrite(cfg, [...argv, '--file', file], ws) } finally { try { rmSync(dirname(file), { recursive: true, force: true }) } catch { /* 忽略 */ } }
    }
    const m = /\[OK\]\s*(D\d+)/.exec(String(out))
    if (!m) return `[失败] 写入流变记忆未成功：${clip(String(out), 300)}（便签保持 active，可重试）`
    note.diary_ref = m[1]
    note.status = 'submitted'
    savePool(pool)
    return `已固化：${note.id} → ${m[1]}（流变记忆，kind=log，工作区 ${ws}）。便签转受保护状态，不再参与赛马。`
  }

  if (action === 'drop') {
    const idx = pool.notes.findIndex(n => n.id === String(args.id || ''))
    if (idx < 0) return `[未找到] 便签 ${args.id}。`
    const [note] = pool.notes.splice(idx, 1)
    note.status = 'retired'
    const retired = loadRetired(pool.sessionKey)
    retired.push(note)
    saveRetired(pool.sessionKey, retired)
    savePool(pool)
    return `已移入回收站：${note.id}（restore 可救回）。`
  }

  if (action === 'restore') {
    const retired = loadRetired(pool.sessionKey)
    const idx = retired.findIndex(n => n.id === String(args.id || ''))
    if (idx < 0) return `[未找到] 回收站里没有 ${args.id}。`
    const [note] = retired.splice(idx, 1)
    saveRetired(pool.sessionKey, retired)
    note.status = 'active'
    const res = await addNoteToPool(pool, note, cfg, Number(args.nowTurn) || pool.meta.rounds)
    if (!res.ok) { // 判重被拒就放回回收站，别丢数据
      const back = loadRetired(pool.sessionKey); back.push(note); saveRetired(pool.sessionKey, back)
      return `[拒收] 恢复失败：${res.reason}（便签已放回回收站）`
    }
    return `已恢复：${note.id} 重新入池${res.evicted ? `（赛马淘汰 ${res.evicted.id}）` : ''}。`
  }

  return '[错误] 未知 action：' + action + '（可用 list/show/stick/promote/drop/restore）'
}

/** 升格标签（2026-10-01 与记忆向量对齐）：便签升格 + 会话工作区名 + 2~3 个内容关键词。
 *  弃用固定五连水泥标签（防长尾污染：1.6 万标签 57% 只用过一次）。
 *  补位去重（交叉验收瑕疵修正：待整理最多一条），补位池用复用型通用标签。 */
export function buildPromoteTags(head, workspace) {
  const words = String(head || '')
    .split(/[^\u4e00-\u9fffA-Za-z0-9]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 2)
  const uniq = [...new Set(words)]
  uniq.sort((a, b) => b.length - a.length)
  const tags = ['便签升格', String(workspace || '').trim() || '未知工作区', ...uniq.slice(0, 3)]
  const seen = new Set(tags)
  for (const filler of ['待整理', '短期记忆', '流变便签']) {
    if (tags.length >= 5) break
    if (!seen.has(filler)) { tags.push(filler); seen.add(filler) }
  }
  return [...new Set(tags)].slice(0, 5)
}

/** memory.py 匿名写入（cwd=工作区目录决定落哪个工作区，与 dsh-liubian write 同款）。 */
function runMemoryWrite(cfg, argv, workspace) {
  const cwd = join(cfg.liubianRoot, workspace)
  return new Promise(resolve => {
    execFile(cfg.python, [cfg.memoryScript, ...argv], {
      cwd: existsSync(cwd) ? cwd : cfg.liubianRoot,
      timeout: cfg.memoryTimeoutMs,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) resolve('[exec 失败] ' + ((err && err.message) || String(err)) + ' ' + clip(String(stderr || ''), 200))
      else resolve((stdout || '').trim() || '(无输出)')
    })
  })
}

/* ──────────────────────────────────────────────────────────────────────────
 * 9. 接线
 * ────────────────────────────────────────────────────────────────────────── */

function register(ctx, def) {
  // name / output 放在展开之后（防 def.name 覆盖成裸名撞内置工具——家族教训）
  const full = { ...def, name: TOOL_PREFIX + def.name, output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] } }
  const tool = defineTool ? defineTool(full) : full
  ctx.effect(() => ctx.tools.register(tool), TOOL_PREFIX + def.name)
}

export function apply(ctx, input = {}) {
  const cfg = resolveConfig(input)
  if (cfg.enabled === false) {
    ctx.logger?.info?.('[dsh-liubian-notes] 已通过配置停用（enabled=false），本轮不挂载任何钩子与工具')
    return
  }

  // 工具面
  register(ctx, {
    name: 'note',
    description: '流变·便签（本对话的短期记忆池）。action=list 看池+热度；show 读全文；'
      + 'stick 主动挂起便签（head=一句话简介即向量来源，body=正文；与自动便签同规则）；'
      + 'promote 手动送审固化进流变记忆；drop/restore 回收站。session 可选（默认当前对话池）。',
    parameters: {
      action: { type: 'string', required: true, description: "list | show | stick | promote | drop | restore", enum: ['list', 'show', 'stick', 'promote', 'drop', 'restore'] },
      head: { type: 'string', description: 'stick 用：便签头（一句话简介，向量来源）' },
      body: { type: 'string', description: 'stick 用：便签正文' },
      id: { type: 'string', description: 'show/promote/drop/restore 用：便签 ID，如 NT-1' },
      session: { type: 'string', description: '可选：会话标识（默认当前对话池）' },
      workspace: { type: 'string', description: 'promote 用：写入流变记忆的目标工作区（默认插件配置）' },
    },
    async execute(args) {
      try { return await noteToolAction(cfg, args || {}, ctx.logger) }
      catch (err) { return '[错误] ' + ((err && err.message) || String(err)) }
    },
  })

  // 采集：session/event（免疫上下文压缩）
  ctx.on('session/event', (session, event) => {
    try {
      if (!session || !event) return
      const id = String(session.id)
      const buf = bufferFor(id)
      switch (event.type) {
        case 'turn/start':
          buf.current = { turn: (event.data && event.data.turn) || buf.sealed.length + 1, human: [], assistant: [], tools: [] }
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
        case 'turn/end': {
          if (!buf.current) break
          buf.sealed.push(buf.current)
          if (buf.sealed.length > 16) buf.sealed.shift()
          // 统计（定 R 用）：有人声的轮才计数
          const key = sessionKeyFor(id)
          const pool = loadPool(key, id)
          if (bumpStats(pool, buf.current)) savePool(pool)
          buf.current = null
          break
        }
        default: break
      }
    } catch { /* 采集失败不影响对话 */ }
  })

  // 注入 + 聚合触发：agent/pre-step（普通注册——排在 dsh-liubian 之后，我们的块离生成点最近）
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    // 整段兜住：便签只是附带功能，绝不拖垮用户这一轮（家族教训：钩子抛错 = 每轮跑不完）
    try {
      if (!decision || decision.kind !== 'enter' || signal?.aborted) return decision
      const sessionId = String(agent?.session?.id ?? '')
      if (!sessionId) return decision
      const key = sessionKeyFor(sessionId)
      touchActive(key, sessionId)
      const pool = loadPool(key, sessionId)
      const buf = bufferFor(sessionId)
      const humanCount = (decision.messages || []).filter(isHumanMessage).length
      const prompt = currentPrompt(decision.messages)
      if (!prompt) return decision   // 同轮后续步不重复注入（currentPrompt 为空）
      // ① 自动聚合：凑满 R 个人类轮就打包一篇
      await maybeAggregate(pool, buf, cfg, humanCount, ctx.logger)
      // ② 向量注入：该轮对话 + 上一轮完整问答 作查询
      const prev = previousQAPair(decision.messages, messageText, isHumanMessage)
      const queryText = composeQueryText(prompt, prev)
      const block = await injectionBlock(pool, cfg, queryText, humanCount)
      if (!block) return decision
      return { kind: 'enter', messages: [...decision.messages, pluginMessage(block, 'recall')] }
    } catch (err) {
      ctx.logger?.warn?.(`[dsh-liubian-notes] 本轮注入失败（已忽略，不影响对话）: ${(err && err.message) || err}`)
      return decision
    }
  })

  ctx.effect(() => {
    buffers.clear()
    poolCache.clear()
  }, 'dsh-liubian-notes: 清理会话缓冲与池缓存')

  ctx.logger?.info?.(
    `[dsh-liubian-notes] v${PLUGIN_VERSION} 便签雏形已挂载：池 ${cfg.poolSize}/注入 ${cfg.injectTop}/R ${cfg.aggregateRounds}`
    + `（m=${cfg.heatRounds}）/判重 ${cfg.dedupThreshold}，向量 ${cfg.embedUrl}，工具 ${TOOL_PREFIX}note`
    + `${defineTool ? '' : '（defineTool 缺失，裸对象注册）'}`,
  )
}

/* ── 纯函数测试缝（dev_stage_add 挂 staging 工具 import 本文件调 __test）── */
export const __test = {
  resolveConfig, configFile, sessionKeyFor, cosine, pruneHeat, heatScore,
  buildNoteBody, buildAutoHead, composeQueryText, previousQAPair, buildNotesBlock,
  addNoteToPool, loadPool, savePool, loadRetired, saveRetired, injectionBlock,
  noteToolAction, embedTexts, pluginMessage, messageText, isHumanMessage, currentPrompt,
  previousAssistantText, bufferFor, bumpStats, DEFAULTS, notesDir,
  buildPromoteTags, memoryConfigFile, MEMORY_KEYS,
}
