/**
 * dsh-liubian-infra —— 流变基建
 *
 * 三大职责：
 *   1. 独特名注册中心：全局独热唯一的智能体名，注册时自动派生 SHA-256 哈希作为身份
 *      唯一标识符；全家族插件统一查询注册表。（契约 v1）
 *   2. 会话↔身份独热绑定（v0.2.0，管理员钉）：对话哈希（sha256(sessionId) 前 8 位，
 *      与被炉同源派生）与名字哈希独热配对；未绑定会话在每回合注入一条注册提示。
 *      已绑定会话不注入（管理员原话只规定未绑定分支）。
 *   3. 向量服务所有权（v0.2.0 挂牌迁移）：autoEnsureOnLoad + 内存看门狗从
 *      dsh-liubian-embed 划归本插件；过渡期保留 `_dsh_external_dsh_liubian_embed`
 *      工具名别名（迁移随行项，见 docs/流变向量服务调用契约_v1.md 头部 contract-version 1.2
 *      的 §5 控制面迁移条款；家属迁移窗口结束后删）。
 *
 * 接口与构造依据：docs/流变插件族接口与构造标准_v0.1.md
 * 注册语义依据：docs/流变独特名注册契约_v1.md（本插件是参考实现）
 */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { defineTool } from '@deepseek-ai/dsh-tools'

export const PLUGIN_NAME = 'dsh-liubian-infra'
export const PLUGIN_VERSION = '0.2.2'
export const CONTRACT_VERSION = '1.0'

const HOME = process.env.USERPROFILE || process.env.HOME || 'C:/Users/Feng'
export const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh')

export const TOOL_NAME = '_dsh_external_dsh_liubian_infra'
/** 过渡期别名（embed 退役后保留，迁移窗口结束后删） */
export const ALIAS_TOOL_NAME = '_dsh_external_dsh_liubian_embed'

/* ══ 配置（标准 §5：DEFAULTS → config.json 剥 BOM → 宿主 input，单入口） ══ */

export const DEFAULTS = {
  /** 注册表数据库（§10 登记表：归属基建，消费方=全家只读，变更通报基石） */
  dbPath: join(DSH_HOME, 'liubian-infra', 'registry.db'),
  /** 会话绑定提示（管理员 2026-10-01：未绑定会话注入一条注册提示） */
  bindNag: true,
  /** 家族根（工作区归属推导用：会话 cwd 末段目录在 liubianRoot 下才算有效工作区） */
  liubianRoot: 'E:/DSH_data',
  /** 默认工作区（cwd 推导失败时回落；与家族共享键同名） */
  workspace: '中枢',
  /* ── 向量服务（与 dsh-liubian-embed 同一份配置源 ~/.dsh/liubian/embed.json，共享键同名）── */
  embedUrl: 'http://127.0.0.1:8082',
  embedPort: 8082,
  serverExe: 'E:/llama.cpp/llama-server.exe',
  serverArgs: [
    '-m', 'E:/llama.cpp/models/qwen3-emb/Qwen3-Embedding-0.6B-Q8_0.gguf',
    '--host', '127.0.0.1', '--port', '8082',
    '-c', '8192', '-ngl', '99', '--embeddings',
  ],
  serverCwd: 'E:/llama.cpp',
  readyTimeoutMs: 45000,
  probeTimeoutMs: 3000,
  /** v0.2.0 挂牌迁移：服务所有权划归基建（与 embed 插件默认值一致，键名同名） */
  autoEnsureOnLoad: true,
  /** 内存看门狗：llama-server 私有提交超限自动重启（泄漏史：5.5h→10.9GB，重启释放 9.2GB） */
  watchdogEnabled: true,
  watchdogIntervalSec: 300,
  watchdogLimitMb: 4096,
}

export function configFile() {
  return join(DSH_HOME, 'liubian-infra', 'config.json')
}

function readJson(file) {
  try {
    // 剥 BOM（标准 §5：Windows 写出的 JSON 可能带 BOM，直接 parse 会炸）
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {}
  } catch {
    return {}
  }
}

export function resolveConfig(input = {}) {
  const merged = {
    ...DEFAULTS,
    // 家族共享键（~/.dsh/liubian/config.json：liubianRoot / workspace 等，标准 §5 同名共享）
    ...readJson(join(DSH_HOME, 'liubian', 'config.json')),
    // embed 键从家族共享配置源读（embed.json），缺省回落 DEFAULTS
    ...readJson(join(DSH_HOME, 'liubian', 'embed.json')),
    ...readJson(configFile()),
  }
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

/* ══ 独特名：纯函数（契约 v1 §2 派生规则，消费方必须逐字对齐） ══ */

export function normalizeName(raw) {
  let name = String(raw ?? '').trim().normalize('NFC')
  if (!name) return { ok: false, error: '名字不能为空' }
  if (name.length > 64) return { ok: false, error: `名字过长（${name.length} > 64 字符）` }
  if (/^[@#]/.test(name)) return { ok: false, error: '名字不能以 @ 或 # 开头（保留语法字符）' }
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: '名字含控制字符' }
  return { ok: true, name, key: name.toLowerCase() }
}

/** 身份哈希：SHA-256(UTF-8(NFC(name))) 小写 hex 64 位。 */
export function deriveHash(name) {
  return createHash('sha256').update(name, 'utf8').digest('hex')
}

/**
 * 会话哈希（对话哈希）：SHA256(sessionId) 前 8 位十六进制。
 * ⚠ 与被炉 idFor 同源同配方（标准 §8：同一派生函数）——被炉房间 ID 即本值。
 */
export function sessionHashFor(sessionId) {
  return createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 8)
}

/** git 式最短唯一前缀（≥8；碰撞自动扩位，随表演化）。 */
export function computeShortIds(hashes, minLen = 8) {
  let len = minLen
  for (;;) {
    const seen = new Set()
    let collision = false
    for (const h of hashes) {
      const p = String(h).slice(0, len)
      if (seen.has(p)) { collision = true; break }
      seen.add(p)
    }
    if (!collision || len >= 64) break
    len += 1
  }
  const out = {}
  for (const h of hashes) out[h] = String(h).slice(0, len)
  return out
}

/* ══ 存储层（单写多读：只有本插件写；消费方只读 DB 文件，契约 v1 §3） ══ */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS identities (
  name        TEXT PRIMARY KEY,
  name_key    TEXT NOT NULL UNIQUE,
  hash        TEXT NOT NULL UNIQUE,
  short_id    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  workspace   TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL,
  retired_at  TEXT,
  retired_note TEXT
);
CREATE TABLE IF NOT EXISTS bindings (
  session_hash TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  bound_at     TEXT NOT NULL,
  note         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bindings_name ON bindings(name);
CREATE TABLE IF NOT EXISTS session_seen (
  session_hash TEXT PRIMARY KEY,
  workspace    TEXT,
  last_seen    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA busy_timeout=5000')
  db.exec(SCHEMA)
  // 既有库迁移：v0.2.0 建的 identities 无 workspace 列（duplicate column 错误即已迁移）
  try { db.exec('ALTER TABLE identities ADD COLUMN workspace TEXT') } catch { /* 列已存在 */ }
  return db
}

export function recomputeShortIds(db) {
  const rows = db.prepare('SELECT hash FROM identities').all()
  const map = computeShortIds(rows.map(r => r.hash))
  const upd = db.prepare('UPDATE identities SET short_id = ? WHERE hash = ?')
  for (const r of rows) upd.run(map[r.hash], r.hash)
}

/** 注册。名字全局独热：占用即拒绝（含已停用名——独热保留不回收）。workspace = 归属工作区（管理员 2026-10-01：名字按工作区归属）。 */
export function registerIdentity(db, rawName, note, workspace) {
  const norm = normalizeName(rawName)
  if (!norm.ok) throw new Error(`[拒绝] ${norm.error}`)
  const { name, key } = norm
  const hash = deriveHash(name)
  const ws = String(workspace ?? '').trim() || null
  const dup = db.prepare('SELECT name, status, short_id, created_at FROM identities WHERE name_key = ?').get(key)
  if (dup) {
    const st = dup.status === 'retired' ? `已停用于 ${dup.retired_at || '?'}（独热保留，不回收）` : '在册'
    throw new Error(`[拒绝] 名字「${name}」已被注册：${st}｜短ID ${dup.short_id}｜注册于 ${dup.created_at}。全局独热，同一名字不可二次注册。`)
  }
  const byHash = db.prepare('SELECT name FROM identities WHERE hash = ?').get(hash)
  if (byHash) throw new Error(`[拒绝] 哈希与在册条目「${byHash.name}」碰撞（SHA-256 碰撞属异常，请核查派生函数是否一致）`)
  const now = new Date().toISOString()
  db.prepare('INSERT INTO identities (name, name_key, hash, short_id, status, workspace, note, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(name, key, hash, hash.slice(0, 8), 'active', ws, note ? String(note) : null, now)
  recomputeShortIds(db)
  return db.prepare('SELECT * FROM identities WHERE name_key = ?').get(key)
}

/** 设置/更新归属工作区（名字独热不可重注册，归属修正走这里）。 */
export function attributeWorkspace(db, rawName, workspace) {
  const norm = normalizeName(rawName)
  if (!norm.ok) throw new Error(norm.error)
  const row = db.prepare('SELECT name FROM identities WHERE name_key = ?').get(norm.key)
  if (!row) throw new Error(`[错误] 名字「${norm.name}」不在册`)
  const ws = String(workspace ?? '').trim()
  if (!ws) throw new Error('[错误] workspace 不能为空')
  db.prepare('UPDATE identities SET workspace = ? WHERE name_key = ?').run(ws, norm.key)
  return db.prepare('SELECT * FROM identities WHERE name_key = ?').get(norm.key)
}

/** 会话出现登记（注入钩子每回合记录会话→工作区，bind 时做归属校验）。 */
export function noteSession(db, sessionHash, workspace) {
  const sh = normSessionHash(sessionHash)
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO session_seen (session_hash, workspace, last_seen) VALUES (?,?,?)
    ON CONFLICT(session_hash) DO UPDATE SET workspace = excluded.workspace, last_seen = excluded.last_seen
  `).run(sh, workspace || null, now)
}

/** 会话的实际工作区（session_seen 里登记的）。 */
export function seenWorkspaceFor(db, sessionHash) {
  try {
    const sh = normSessionHash(sessionHash)
    const row = db.prepare('SELECT workspace FROM session_seen WHERE session_hash = ?').get(sh)
    return row ? row.workspace : null
  } catch { return null }
}

export function verifyName(db, rawName) {
  const norm = normalizeName(rawName)
  if (!norm.ok) return { ok: false, available: false, error: norm.error }
  const row = db.prepare('SELECT name, status, short_id, created_at, retired_at, workspace FROM identities WHERE name_key = ?').get(norm.key)
  if (!row) return { ok: true, available: true, name: norm.name, hash: deriveHash(norm.name) }
  return {
    ok: true,
    available: false,
    name: row.name,
    status: row.status,
    shortId: row.short_id,
    workspace: row.workspace || undefined,
    registeredAt: row.created_at,
    retiredAt: row.retired_at || undefined,
    reason: row.status === 'retired' ? '已停用（独热保留，不回收）' : '在册',
  }
}

export function lookupIdentity(db, { name, id } = {}) {
  if (name) {
    const norm = normalizeName(name)
    if (!norm.ok) throw new Error(norm.error)
    const row = db.prepare('SELECT * FROM identities WHERE name_key = ?').get(norm.key)
    return { by: 'name', row: row || null }
  }
  if (id) {
    const q = String(id).trim().toLowerCase()
    if (!/^[0-9a-f]{8,64}$/.test(q)) throw new Error('[错误] id 须为 8~64 位十六进制（短或全 hash）')
    const rows = db.prepare('SELECT * FROM identities WHERE hash = ?').all(q)
    if (rows.length) return { by: 'hash', row: rows[0] }
    const cands = db.prepare('SELECT * FROM identities WHERE hash LIKE ?').all(q + '%')
    if (cands.length === 1) return { by: 'hash', row: cands[0] }
    if (cands.length > 1) return { by: 'hash', row: null, ambiguous: cands.map(r => ({ name: r.name, hash: r.hash })) }
    return { by: 'hash', row: null }
  }
  throw new Error('[错误] lookup 需要 name 或 id 之一')
}

export function listIdentities(db) {
  return db.prepare('SELECT name, hash, short_id, status, workspace, note, created_at, retired_at FROM identities ORDER BY created_at').all()
}

export function retireIdentity(db, rawName, note) {
  const norm = normalizeName(rawName)
  if (!norm.ok) throw new Error(norm.error)
  const row = db.prepare('SELECT * FROM identities WHERE name_key = ?').get(norm.key)
  if (!row) throw new Error(`[错误] 名字「${norm.name}」不在册`)
  if (row.status === 'retired') return { ...row, alreadyRetired: true }
  const now = new Date().toISOString()
  db.prepare('UPDATE identities SET status = ?, retired_at = ?, retired_note = ? WHERE name_key = ?')
    .run('retired', now, note ? String(note) : null, norm.key)
  return db.prepare('SELECT * FROM identities WHERE name_key = ?').get(norm.key)
}

/* ── 会话↔身份独热绑定（v0.2.0，管理员钉） ── */

/** 会话哈希合法化：8 位 hex（与被炉 idFor 同源派生的产物）。 */
function normSessionHash(raw) {
  const q = String(raw ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{8}$/.test(q)) throw new Error('[错误] 会话哈希须为 8 位十六进制（注入提示里给的那个）')
  return q
}

/** 绑定：会话↔名字独热配对。同会话同名幂等；改绑需先 unbind；名字需已注册。 */
export function bindSession(db, rawSessionHash, rawName, note) {
  const sh = normSessionHash(rawSessionHash)
  const norm = normalizeName(rawName)
  if (!norm.ok) throw new Error(`[拒绝] ${norm.error}`)
  const ident = db.prepare('SELECT name, short_id, status, workspace FROM identities WHERE name_key = ?').get(norm.key)
  if (!ident) throw new Error(`[拒绝] 名字「${norm.name}」尚未注册——先 register 再 bind。`)
  if (ident.status === 'retired') throw new Error(`[拒绝] 名字「${norm.name}」已停用，不能绑定。`)
  // 归属校验（管理员 2026-10-01：名字按工作区归属）——会话实际工作区（注入钩子登记）与身份归属不一致即拒
  const seen = seenWorkspaceFor(db, sh)
  if (ident.workspace && seen && seen !== ident.workspace) {
    throw new Error(`[拒绝] 归属不符：本会话实际工作区「${seen}」，而「${ident.name}」归属「${ident.workspace}」。名字按工作区归属，请注册/绑定本工作区的身份（或找基石核对归属登记）。`)
  }
  const existing = db.prepare('SELECT * FROM bindings WHERE session_hash = ?').get(sh)
  if (existing && existing.name === ident.name) return { ...existing, short_id: ident.short_id, already: true }
  if (existing) throw new Error(`[拒绝] 会话 ${sh} 已绑定「${existing.name}」（唯一绑定）。要改绑先 action=unbind 释放。`)
  const byName = db.prepare('SELECT session_hash FROM bindings WHERE name = ?').get(ident.name)
  if (byName) throw new Error(`[拒绝] 名字「${ident.name}」已绑定会话 ${byName.session_hash}（独热配对）。若旧会话已终结，用 action=unbind（name=${ident.name}）释放后重绑。`)
  const now = new Date().toISOString()
  db.prepare('INSERT INTO bindings (session_hash, name, bound_at, note) VALUES (?,?,?,?)')
    .run(sh, ident.name, now, note ? String(note) : null)
  return { session_hash: sh, name: ident.name, short_id: ident.short_id, bound_at: now }
}

export function unbindSession(db, { session, name } = {}) {
  if (session) {
    const sh = normSessionHash(session)
    const row = db.prepare('SELECT * FROM bindings WHERE session_hash = ?').get(sh)
    if (!row) return { ok: true, nothing: true }
    db.prepare('DELETE FROM bindings WHERE session_hash = ?').run(sh)
    return { ok: true, released: { session_hash: row.session_hash, name: row.name } }
  }
  if (name) {
    const norm = normalizeName(name)
    if (!norm.ok) throw new Error(norm.error)
    const row = db.prepare('SELECT * FROM bindings WHERE name = ?').get(norm.key)
    if (!row) return { ok: true, nothing: true }
    db.prepare('DELETE FROM bindings WHERE name = ?').run(norm.key)
    return { ok: true, released: { session_hash: row.session_hash, name: row.name } }
  }
  throw new Error('[错误] unbind 需要 session 或 name 之一')
}

/** 查绑定（带身份短 ID 与归属工作区）。 */
export function bindingFor(db, rawSessionHash) {
  const sh = normSessionHash(rawSessionHash)
  return db.prepare(`
    SELECT b.session_hash, b.name, b.bound_at, b.note, i.short_id, i.status, i.workspace
    FROM bindings b LEFT JOIN identities i ON i.name = b.name
    WHERE b.session_hash = ?
  `).get(sh) || null
}

export function listBindings(db) {
  return db.prepare(`
    SELECT b.session_hash, b.name, b.bound_at, b.note, i.short_id, i.workspace
    FROM bindings b LEFT JOIN identities i ON i.name = b.name
    ORDER BY b.bound_at
  `).all()
}

/* ══ 向量服务控制面（契约 v1.2；v0.2.0 起服务所有权归基建） ══ */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function probe(cfg) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.probeTimeoutMs || 3000)
  try {
    const res = await fetch(new URL('/health', cfg.embedUrl), { signal: controller.signal })
    return { ok: res.ok, status: res.status, body: (await res.text()).slice(0, 200) }
  } catch (err) {
    return { ok: false, status: 0, body: (err && err.message) || String(err) }
  } finally {
    clearTimeout(timer)
  }
}

export function launch(cfg) {
  try {
    const exe = String(cfg.serverExe || '')
    if (!exe || !existsSync(exe)) return `[错误] 未找到 llama-server：${exe}`
    const args = Array.isArray(cfg.serverArgs) ? cfg.serverArgs.map(String) : []
    // detached 故意为 false（embed 插件实测：true 会被 Node 升级成 CREATE_NEW_CONSOLE 冒黑框）
    const child = spawn(exe, args, {
      cwd: existsSync(String(cfg.serverCwd || '')) ? cfg.serverCwd : undefined,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return '已启动（直起 exe，无窗）'
  } catch (err) {
    return '[错误] ' + ((err && err.message) || String(err))
  }
}

export async function ensureReady(cfg) {
  const before = await probe(cfg)
  if (before.ok) return { ok: true, already: true, body: before.body }
  const launched = launch(cfg)
  if (launched.startsWith('[错误]')) return { ok: false, error: launched }
  const started = Date.now()
  const deadline = started + (Number(cfg.readyTimeoutMs) || 45000)
  for (;;) {
    if (Date.now() > deadline) return { ok: false, pending: true, seconds: Math.round((Date.now() - started) / 1000) }
    await sleep(2000)
    const now = await probe(cfg)
    if (now.ok) return { ok: true, already: false, seconds: Math.round((Date.now() - started) / 1000), body: now.body }
  }
}

export function listeningPid(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
      encoding: 'utf-8', windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
    })
    for (const line of String(out).split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length >= 5 && cols[3] === 'LISTENING' && cols[1].endsWith(':' + port)) {
        const pid = Number(cols[4])
        if (Number.isFinite(pid) && pid > 0) return pid
      }
    }
  } catch { /* netstat 不可用就当找不到 */ }
  return 0
}

export function stopService(cfg) {
  const pid = listeningPid(cfg.embedPort)
  if (!pid) return { ok: true, pid: 0 }
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 20000 })
    return { ok: true, pid }
  } catch (err) {
    return { ok: false, pid, error: (err && err.message) || String(err) }
  }
}

/* ── 服务所有权：加载自动带起 + 内存看门狗（自 embed 移交，2026-10-01 挂牌迁移） ── */

const POWER_SHELL = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

/** 读进程私有提交内存（MB）。看门狗用它与阈值比；读不到返回 0（跳过本轮）。 */
export function privateCommitMb(pid) {
  if (!pid) return 0
  try {
    const out = execFileSync(POWER_SHELL, [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).PrivateMemorySize64`,
    ], { encoding: 'utf-8', windowsHide: true, timeout: 20000, maxBuffer: 1 << 20 })
    const v = Number(String(out || '').trim())
    return Number.isFinite(v) && v > 0 ? v / 1048576 : 0
  } catch {
    return 0
  }
}

let lastEnsureAt = 0
/** 插件加载 / 冷却带起：探活在线就不动作（fire-and-forget，不阻塞宿主）。 */
export function ensureInFlow(cfg, logger, { force = false } = {}) {
  if (!force && !cfg.autoEnsureOnLoad) return
  if (!force && Date.now() - lastEnsureAt < 60000) return
  lastEnsureAt = Date.now()
  void (async () => {
    const before = await probe(cfg)
    if (before.ok) return
    launch(cfg)
    logger?.info?.(`[${PLUGIN_NAME}] 向量服务离线，已在后台拉起（直起 exe，无窗）`)
  })().catch(() => {})
}

let lastWatchdogRestart = ''

/** 单次看门狗检查：在线 → 读私有提交 → 超限 stop+launch。失败只 warn，绝不抛。 */
export async function watchdogTick(cfg, logger) {
  try {
    const up = await probe(cfg)
    if (!up.ok) return
    const pid = listeningPid(cfg.embedPort)
    if (!pid) return
    const mb = privateCommitMb(pid)
    if (!mb) return
    const limit = Math.max(512, Number(cfg.watchdogLimitMb) || 4096)
    if (mb <= limit) return
    logger?.warn?.(`[${PLUGIN_NAME}] 看门狗：llama-server(PID ${pid}) 私有提交 ${mb.toFixed(0)}MB 超过 ${limit}MB，自动重启`)
    const stopped = stopService(cfg)
    await sleep(1500)
    const launched = launch(cfg)
    lastWatchdogRestart =
      `${new Date().toLocaleString('zh-CN')}｜${mb.toFixed(0)}MB → 重启（stop=${stopped.ok ? 'ok' : 'fail'} launch=${launched}）`
    logger?.info?.(`[${PLUGIN_NAME}] 看门狗重启完成：${lastWatchdogRestart}`)
  } catch (err) {
    logger?.warn?.(`[${PLUGIN_NAME}] 看门狗异常：${(err && err.message) || err}`)
  }
}

/** 周期看门狗，随插件卸载清理。 */
export function mountWatchdog(ctx, cfg) {
  if (!cfg.watchdogEnabled) return
  let timer = null
  const loop = async () => {
    await watchdogTick(cfg, ctx.logger)
    timer = setTimeout(loop, (Number(cfg.watchdogIntervalSec) || 300) * 1000)
  }
  timer = setTimeout(loop, (Number(cfg.watchdogIntervalSec) || 300) * 1000)
  ctx.effect(() => {
    if (timer) clearTimeout(timer)
  }, 'dsh-liubian-infra: 内存看门狗')
}

/* ══ 注入钩子：未绑定会话注入一条注册提示（v0.2.0，管理员钉；已绑定不注入） ══ */

/** 会话归属工作区推导：cwd 末段目录名（且在 liubianRoot 下才有效），与记忆系统 resolveDiaryWorkspace 同源。 */
export function deriveSessionWorkspace(cfg, agent) {
  const cwd = String((agent && agent.session && agent.session.header && agent.session.header.cwd) || '')
  if (cwd) {
    const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
    const root = String(cfg.liubianRoot || '').replace(/[\\/]+$/, '')
    if (base && root && existsSync(join(root, base))) return base
  }
  return String(cfg.workspace || '') || null
}

/** 从工具执行上下文取调用方会话（exec.agent.session）——注册/绑定时主动完成归属的数据源。 */
export function callerSessionOf(exec) {
  const s = exec && exec.agent && exec.agent.session
  if (!s || !s.id) return null
  return { id: String(s.id), cwd: String((s.header && s.header.cwd) || '') }
}

export function mountBindingInjection(ctx, cfg, state) {
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    try {
      if (!decision || decision.kind !== 'enter' || signal?.aborted) return decision
      if (!cfg.bindNag) return decision
      const sessionId = agent?.session?.id
      if (!sessionId) return decision
      const db = state.tryDb()
      if (!db) return decision                      // 注册中心不可用 → 静默降级（门禁③）
      const sh = sessionHashFor(sessionId)
      const ws = deriveSessionWorkspace(cfg, agent)
      try { noteSession(db, sh, ws) } catch { /* 登记失败不影响注入 */ }
      if (bindingFor(db, sh)) return decision       // 已绑定：不注入（管理员只规定未绑定分支）
      const text = `【流变·基建｜独特名注册】本会话尚未绑定身份（会话哈希 ${sh}｜工作区 ${ws || '未知'}）。请两步完成：① _dsh_external_dsh_liubian_infra action=register 注册一个全局独热名字并带 workspace=${ws || '你的工作区名'}（名字按工作区归属；规范：非空、≤64 字符、不以 @/# 开头、注册即永久保留）；② action=bind 以会话哈希 ${sh} 绑定该名字。绑定后会话与身份独热配对，后续署名/贡献者归因此身份。`
      return { kind: 'enter', messages: [...decision.messages, {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'plugin:' + PLUGIN_NAME },
      }] }
    } catch (err) {
      ctx.logger?.warn?.(`[${PLUGIN_NAME}] 绑定注入异常（忽略，不影响本轮）：${err?.message || err}`)
      return decision
    }
  }, { prepend: true })
}

/* ══ 工具面 ══ */

const OUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

function fmtRow(r) {
  return [
    `[OK] ${r.status === 'retired' ? '（已停用）' : ''}「${r.name}」`,
    `  短ID   ${r.short_id}`,
    `  全hash ${r.hash}`,
    `  归属   ${r.workspace || '（未登记）'}`,
    `  注册   ${r.created_at}${r.retired_at ? `｜停用 ${r.retired_at}${r.retired_note ? `（${r.retired_note}）` : ''}` : ''}`,
    r.note ? `  说明   ${r.note}` : '',
  ].filter(Boolean).join('\n')
}

const REGISTRY_ACTIONS = 'register / verify / lookup / list / retire / attribute / bind / unbind / binding / bindings / status'
const EMBED_ACTIONS = 'embed-status / embed-ensure / embed-stop / embed-restart'

function fmtBindingRow(r) {
  return `「${r.name}」（#${r.short_id || '?'}）↔ 会话 ${r.session_hash}｜绑定于 ${r.bound_at}${r.note ? `｜${r.note}` : ''}`
}

function buildInfraTool(cfg, state, { name, descriptionNote }) {
  return defineTool({
    name,
    description: descriptionNote + '独特名注册中心：全局独热唯一的智能体名，注册时自动派生 SHA-256 哈希作为身份唯一标识符，'
      + '名字按工作区归属（register 带 workspace）；会话↔身份独热绑定：未绑定会话每回合收到一条注册提示；'
      + '向量服务控制面（挂牌迁移后服务所有权归基建）。'
      + `action: ${REGISTRY_ACTIONS}｜${EMBED_ACTIONS}`,
    parameters: {
      action: {
        type: 'string', required: true,
        description: `操作：${REGISTRY_ACTIONS}｜${EMBED_ACTIONS}`,
      },
      name: { type: 'string', description: 'register/verify/lookup/retire/attribute/bind/unbind/binding 用：独特名' },
      id: { type: 'string', description: 'lookup 用：短或全 hash（8~64 位十六进制）' },
      session: { type: 'string', description: 'bind/unbind/binding 用：会话哈希（8 位十六进制，注入提示里给的）' },
      workspace: { type: 'string', description: 'register/attribute 用：归属工作区名（名字按工作区归属）' },
      note: { type: 'string', description: 'register/retire/bind 用：备注（归属、用途等）' },
    },
    output: OUT,
    async execute(args, exec) {
      const action = String(args.action || 'status').toLowerCase()
      // 调用方会话（v0.2.2 注册/绑定主动完成归属的数据源；面板/无会话调用为 null）
      const caller = callerSessionOf(exec)
      const noteCaller = (db) => {
        if (!caller) return null
        const sh = sessionHashFor(caller.id)
        const ws = deriveSessionWorkspace(cfg, { session: { header: { cwd: caller.cwd } } })
        try { noteSession(db, sh, ws) } catch { /* 登记失败不阻塞 */ }
        return { hash: sh, workspace: ws }
      }

      /* ── 注册中心 ── */
      if (action === 'register') {
        const db = state.getDb()
        const seen = noteCaller(db)
        // 主动完成归属（管理员 2026-10-01）：显式 workspace > 调用方会话自动推导 > 未登记
        const autoWs = seen ? seen.workspace : null
        const ws = String(args.workspace ?? '').trim() || autoWs
        const row = registerIdentity(db, args.name, args.note, ws)
        const src = String(args.workspace ?? '').trim() ? '调用方指定' : (ws ? '自动推导自调用会话' : '未登记（无会话上下文）')
        return fmtRow(row) + `\n  └─ 归属来源：${src}｜注册表现有 ${listIdentities(db).length} 个身份`
      }
      if (action === 'attribute') {
        const db = state.getDb()
        const row = attributeWorkspace(db, args.name, args.workspace)
        return `[OK] 归属已更新：${fmtRow(row)}`
      }
      if (action === 'verify') {
        const db = state.getDb()
        const r = verifyName(db, args.name)
        if (!r.ok) return `[错误] ${r.error}`
        return r.available
          ? `[可用] 「${r.name}」未被占用，可注册。\n  注册后身份hash将为：${r.hash}`
          : `[占用] 「${r.name}」${r.reason}｜短ID ${r.shortId}｜注册于 ${r.registeredAt}`
      }
      if (action === 'lookup') {
        const db = state.getDb()
        const r = lookupIdentity(db, { name: args.name, id: args.id })
        if (r.row) return `[OK] （按${r.by === 'name' ? '名字' : 'hash'}命中）\n${fmtRow(r.row)}`
        if (r.ambiguous) return `[歧义] 前缀命中 ${r.ambiguous.length} 条，请用更长的 hash：\n` +
          r.ambiguous.map(c => `  ${c.name}  ${c.hash}`).join('\n')
        return `[未找到] 注册表中没有该${r.by === 'name' ? '名字' : 'hash'}对应的身份。`
      }
      if (action === 'list') {
        const db = state.getDb()
        const rows = listIdentities(db)
        if (!rows.length) return '注册表为空。'
        const lines = rows.map(r =>
          `  ${r.status === 'retired' ? '○' : '●'} ${r.name}  #${r.short_id}${r.workspace ? `  [${r.workspace}]` : ''}${r.note ? `  ｜${r.note}` : ''}`)
        return `注册表（${rows.length} 个，● 在册 ○ 停用，[工作区]）：\n${lines.join('\n')}`
      }
      if (action === 'retire') {
        const db = state.getDb()
        const row = retireIdentity(db, args.name, args.note)
        if (row.alreadyRetired) return `[OK] 「${row.name}」此前已停用（${row.retired_at}）。独热保留不回收。`
        return `[OK] 已停用「${row.name}」（${row.retired_at}）。名字独热保留，不可被再次注册。`
      }

      /* ── 会话绑定（v0.2.0） ── */
      if (action === 'bind') {
        const db = state.getDb()
        noteCaller(db)   // 绑定前刷新调用方会话登记（归属校验数据源）
        const r = bindSession(db, args.session, args.name, args.note)
        if (r.already) return `[OK] 已绑定（幂等）：${fmtBindingRow(r)}`
        return `[OK] 已绑定：${fmtBindingRow(r)}\n  └─ 独热配对成立，本会话身份归因「${r.name}」。`
      }
      if (action === 'unbind') {
        const db = state.getDb()
        const r = unbindSession(db, { session: args.session, name: args.name })
        if (r.nothing) return '[OK] 没有找到对应的绑定，无需释放。'
        return `[OK] 已释放：${fmtBindingRow(r.released)}`
      }
      if (action === 'binding') {
        const db = state.getDb()
        const row = bindingFor(db, args.session)
        if (row) return `[OK] ${fmtBindingRow(row)}`
        return `[未绑定] 会话 ${args.session || '?'} 尚未绑定身份。`
      }
      if (action === 'bindings') {
        const db = state.getDb()
        const rows = listBindings(db)
        if (!rows.length) return '当前没有会话绑定。'
        return `会话绑定（${rows.length} 对）：\n` + rows.map(r => `  「${r.name}」（#${r.short_id || '?'}）↔ ${r.session_hash}`).join('\n')
      }

      /* ── 总览 ── */
      if (action === 'status') {
        const up = await probe(cfg)
        let reg = '注册表不可用'
        try {
          const db = state.getDb()
          const rows = listIdentities(db)
          const binds = listBindings(db)
          const act = rows.filter(r => r.status === 'active').length
          reg = `${act} 在册 / ${rows.length - act} 停用｜绑定 ${binds.length} 对`
        } catch (e) {
          reg = '打开失败：' + ((e && e.message) || e)
        }
        const pid = listeningPid(cfg.embedPort)
        return [
          `[流变基建 v${PLUGIN_VERSION}｜契约 v${CONTRACT_VERSION}]`,
          `[注册表] ${reg}｜${cfg.dbPath}`,
          `[会话绑定] ${cfg.bindNag ? '未绑定会话注入注册提示（管理员 2026-10-01）' : '提示已关（bindNag=false）'}`,
          `[向量服务] ${up.ok ? `在线 ${cfg.embedUrl}` : `离线（${up.body}）`}${pid ? `｜PID ${pid}` : ''}｜所有权：基建（v0.2.0 挂牌迁移）`,
          `[看门狗] ${cfg.watchdogEnabled ? `开（>${cfg.watchdogLimitMb}MB / 每 ${cfg.watchdogIntervalSec}s）` : '关'}${lastWatchdogRestart ? `｜最近：${lastWatchdogRestart}` : ''}`,
        ].join('\n')
      }

      /* ── 向量服务控制面 ── */
      if (action === 'embed-stop') {
        const r = stopService(cfg)
        if (!r.ok) return `[错误] 关停失败（PID ${r.pid}）：${r.error}`
        return r.pid ? `[OK] 已关停向量服务（PID ${r.pid}）。注意：基建看门狗只重启不主动拉起，关停后想恢复用 embed-ensure。` : '[OK] 端口上没有监听进程。'
      }
      if (action === 'embed-restart') {
        const r = stopService(cfg)
        await sleep(1500)
        const up = await ensureReady(cfg)
        if (!up.ok) return `[错误] 重启失败：${up.error || '等待就绪超时'}`
        return `[OK] 向量服务已重启并就绪（${up.seconds}s）：${cfg.embedUrl}\n${up.body}`
      }
      if (action === 'embed-ensure') {
        const up = await ensureReady(cfg)
        if (up.ok) return up.already ? `[OK] 向量服务已在线：${cfg.embedUrl}\n${up.body}` : `[OK] 向量服务已就绪（${up.seconds}s）：${cfg.embedUrl}\n${up.body}`
        if (up.pending) return `[待加载] 已拉起，${up.seconds}s 未就绪（模型首次加载更久）。稍后 embed-status 复查。`
        return `[错误] ${up.error}`
      }
      if (action === 'embed-status') {
        const before = await probe(cfg)
        const pid = listeningPid(cfg.embedPort)
        return [
          before.ok ? `[OK] 向量服务在线：${cfg.embedUrl}` : `[离线] ${cfg.embedUrl}（${before.body}）`,
          `[端口] ${cfg.embedPort}${pid ? `　PID ${pid}` : '　（无监听进程）'}`,
          `[启动方式] 直起 exe ${cfg.serverExe}（无窗）｜所有权：基建（autoEnsure=${cfg.autoEnsureOnLoad}）`,
          before.ok ? before.body : '',
        ].filter(Boolean).join('\n')
      }

      return `[错误] 未知 action：${action}（可用：${REGISTRY_ACTIONS}｜${EMBED_ACTIONS}）`
    },
  })
}

function registerTools(ctx, cfg, state) {
  ctx.effect(() => ctx.tools.register(
    buildInfraTool(cfg, state, {
      name: TOOL_NAME,
      descriptionNote: '流变·基建（dsh-liubian-infra）。',
    }), TOOL_NAME))
  // 过渡期别名（embed 退役后由基建承接同名控制面；家属迁移窗口结束、全部换用 infra 后删）
  ctx.effect(() => ctx.tools.register(
    buildInfraTool(cfg, state, {
      name: ALIAS_TOOL_NAME,
      descriptionNote: `（过渡期别名：原 dsh-liubian-embed 控制面，v0.2.0 起由 dsh-liubian-infra 承载，注册中心动作同样可用。）`,
    }), ALIAS_TOOL_NAME))
}

/* ══ 入口 ══ */

export function apply(ctx, input = {}) {
  const cfg = resolveConfig(input)

  // 惰性开库：DB 打不开不拖垮插件挂载，注册动作时才报错；注入钩子侧降级静默
  const state = {
    _db: null,
    _err: null,
    getDb() {
      if (this._err) throw this._err
      if (!this._db) {
        try { this._db = openDb(cfg.dbPath) } catch (e) { this._err = e; throw e }
      }
      return this._db
    },
    tryDb() {
      try { return this.getDb() } catch { return null }
    },
  }

  registerTools(ctx, cfg, state)

  // 挂牌迁移（v0.2.0）：服务所有权——加载自动带起 + 内存看门狗
  ensureInFlow(cfg, ctx.logger, { force: true })
  mountWatchdog(ctx, cfg)

  // 会话绑定注入（未绑定 → 一条注册提示；已绑定 → 不注入）
  mountBindingInjection(ctx, cfg, state)

  ctx.effect(() => {
    try { state._db?.close() } catch { /* 卸载时关闭尽力而为 */ }
  }, 'dsh-liubian-infra: 关闭注册表')

  ctx.logger?.info?.(
    `[${PLUGIN_NAME}] v${PLUGIN_VERSION} 已挂载：注册表 ${cfg.dbPath}（契约 v${CONTRACT_VERSION}，bindNag=${cfg.bindNag}）`
    + `｜向量服务所有权已接管（autoEnsure=${cfg.autoEnsureOnLoad}，看门狗=${cfg.watchdogEnabled ? `>${cfg.watchdogLimitMb}MB/${cfg.watchdogIntervalSec}s` : '关'}）`
    + `｜过渡期别名 ${ALIAS_TOOL_NAME} 在位`,
  )
}

/** 纯函数/可测缝（标准 §8：桩测不依赖宿主） */
export const __test = {
  resolveConfig,
  configFile,
  normalizeName,
  deriveHash,
  sessionHashFor,
  computeShortIds,
  recomputeShortIds,
  openDb,
  registerIdentity,
  verifyName,
  lookupIdentity,
  listIdentities,
  retireIdentity,
  bindSession,
  unbindSession,
  bindingFor,
  listBindings,
  attributeWorkspace,
  noteSession,
  seenWorkspaceFor,
  deriveSessionWorkspace,
  callerSessionOf,
  probe,
  launch,
  ensureReady,
  listeningPid,
  stopService,
  privateCommitMb,
  watchdogTick,
}
