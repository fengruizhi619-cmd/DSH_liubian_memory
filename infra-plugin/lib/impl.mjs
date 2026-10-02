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
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { defineTool } from '@deepseek-ai/dsh-tools'

export const PLUGIN_NAME = 'dsh-liubian-infra'
export const PLUGIN_VERSION = '0.4.0'
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
  /** 功能性自检超时（2026-10-02 补）：真发一次 embeddings 的等待上限。正常 10~30ms；
   *  进入"僵死态"（/health 200 但干不了活）时它会超时——这正是我们要看见的信号。 */
  probeEmbedTimeoutMs: 8000,
  /** v0.2.0 挂牌迁移：服务所有权划归基建（与 embed 插件默认值一致，键名同名） */
  autoEnsureOnLoad: true,
  /** 内存看门狗：llama-server 私有提交超限自动重启（泄漏史：5.5h→10.9GB，重启释放 9.2GB）
   *  2026-10-01 阈值纠偏：实测本机空载稳态私有提交即 ~10.8GB（活体测量 privateCommitMb(监听PID)
   *  = 10787MB），旧默认 4096MB 永远超限——旧 embed 看门狗因此全天击杀 80 次（凌晨无任务也
   *  每 5 分钟杀一次），每次击杀 = 整模 GPU 重载尖峰，即「没任务也跑满 GPU」的根因。
   *  新默认 12288MB = 稳态之上、真泄漏（历史泄漏终点 10.9GB 附近徘徊）可辨；仍可被 embed.json
   *  的 watchdogLimitMb 键覆盖。 */
  watchdogEnabled: true,
  watchdogIntervalSec: 300,
  watchdogLimitMb: 12288,
  /** 子进程输出落盘（2026-10-01 事故后新增）：旧版 `stdio:'ignore'` 把 llama-server 的
   *  stdout/stderr 全丢了——服务当晚静默死亡 ≥90 分钟，**死因无从查起**。
   *  追加写，不经轮转；文件不存在即创建。置空字符串可退回"丢弃输出"的旧行为。 */
  serverLogFile: 'C:/Users/Feng/.dsh/liubian-infra/llama-server.log',
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
/* v0.3.0 改名支持（管理员 2026-10-01 联合任务 · B1 模型）：
   hash = 账号 ID（注册时派生，此后不可变）；name = 可变展示名。
   改名只动 identities.name/name_key；旧名入别名表供 lookup 回查（历史引用不断裂）；每次改名留账。 */
CREATE TABLE IF NOT EXISTS name_aliases (
  name_key   TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  renamed_at TEXT NOT NULL,
  note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_aliases_hash ON name_aliases(hash);
CREATE TABLE IF NOT EXISTS renames (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  hash     TEXT NOT NULL,
  old_name TEXT NOT NULL,
  new_name TEXT NOT NULL,
  at       TEXT NOT NULL,
  actor    TEXT,
  note     TEXT
);
CREATE INDEX IF NOT EXISTS idx_renames_hash ON renames(hash);
/* v0.4.0 删除与同步（管理员 2026-10-01 裁定：删除用户 = L1 退房 + L2 删运行身份 + L3 注销名字）。
   墓碑**只增不改**（与 renames 同纪律）：忘记一条'forget'事件、复活一条'lift'事件，
   当前状态 = 该会话 id 最大的那行。这样消费方按 id 水位轮询时，**复活事件不会漏水**
   （若用「一行一状态 + 更新列」的写法，复活只改列不改 id，水位轮询永远看不到它）。 */
CREATE TABLE IF NOT EXISTS tombstones (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_hash TEXT NOT NULL,
  op           TEXT NOT NULL,        -- 'forget' | 'lift'
  at           TEXT NOT NULL,
  actor        TEXT,
  reason       TEXT
);
CREATE INDEX IF NOT EXISTS idx_tombstones_session ON tombstones(session_hash, id);
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
  const dup = db.prepare('SELECT name, status, short_id, created_at, retired_at FROM identities WHERE name_key = ?').get(key)
  if (dup) {
    const st = dup.status === 'retired' ? `已停用于 ${dup.retired_at || '?'}（独热保留，不回收）` : '在册'
    throw new Error(`[拒绝] 名字「${name}」已被注册：${st}｜短ID ${dup.short_id}｜注册于 ${dup.created_at}。全局独热，同一名字不可二次注册。`)
  }
  const byHash = db.prepare('SELECT name FROM identities WHERE hash = ?').get(hash)
  if (byHash) {
    // v0.3.0：改名不改身份，旧名的 hash 仍归原身份 → 旧名不可被二次注册
    const wasAlias = db.prepare('SELECT renamed_at FROM name_aliases WHERE name_key = ? AND hash = ?').get(key, hash)
    throw new Error(wasAlias
      ? `[拒绝] 名字「${name}」是「${byHash.name}」的历史名（${wasAlias.renamed_at} 改名）——改名不改身份，旧名不可被二次注册。`
      : `[拒绝] 哈希与在册条目「${byHash.name}」碰撞（SHA-256 碰撞属异常，请核查派生函数是否一致）`)
  }
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
  if (!row) {
    const alias = db.prepare('SELECT hash, renamed_at FROM name_aliases WHERE name_key = ?').get(norm.key)
    if (alias) {
      const cur = db.prepare('SELECT name FROM identities WHERE hash = ?').get(alias.hash)
      return {
        ok: true, available: false, name: norm.name, status: 'alias',
        aliasOf: cur ? cur.name : null, hash: alias.hash, shortId: alias.hash.slice(0, 8),
        reason: `是「${cur ? cur.name : '?'}」的历史名（${alias.renamed_at} 改名）——改名不改身份，不可注册`,
      }
    }
    return { ok: true, available: true, name: norm.name, hash: deriveHash(norm.name) }
  }
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
    if (row) return { by: 'name', row }
    // v0.3.0：旧名回查（历史引用不断裂）
    const alias = db.prepare('SELECT name, hash, renamed_at FROM name_aliases WHERE name_key = ?').get(norm.key)
    return { by: 'name', row: null, alias: alias || null }
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

/**
 * 改名（v0.3.0，B1 模型）：hash 是账号 ID **不可变**，name 是可变展示名。
 * 只改 identities.name/name_key；hash / short_id / created_at / workspace / note / status 与 bindings **全不动**；
 * 旧名登记进 name_aliases（lookup 旧名可回查，历史引用不断裂），并写一行 renames 账目。
 * 校验任一不过 → 抛错且零写入。
 */
export function renameIdentity(db, rawName, rawNew, actor, note) {
  const norm = normalizeName(rawName)
  if (!norm.ok) throw new Error(`[拒绝] ${norm.error}`)
  const nn = normalizeName(rawNew)
  if (!nn.ok) throw new Error(`[拒绝] 新名无效：${nn.error}`)
  const row = db.prepare('SELECT * FROM identities WHERE name_key = ?').get(norm.key)
  if (!row) {
    const viaAlias = db.prepare('SELECT hash FROM name_aliases WHERE name_key = ?').get(norm.key)
    if (viaAlias) {
      const cur = db.prepare('SELECT name FROM identities WHERE hash = ?').get(viaAlias.hash)
      throw new Error(`[错误] 「${norm.name}」是历史名（现名「${cur ? cur.name : '?'}」，#${viaAlias.hash.slice(0, 8)}）——请用当前名发起改名。`)
    }
    throw new Error(`[错误] 名字「${norm.name}」不在册`)
  }
  if (row.status === 'retired') throw new Error(`[拒绝] 「${row.name}」已停用（${row.retired_at || '?'}），停用身份不可改名。`)
  if (nn.key === row.name_key) return { ...row, noop: true }
  const dup = db.prepare('SELECT name, status FROM identities WHERE name_key = ?').get(nn.key)
  if (dup) throw new Error(`[拒绝] 新名「${nn.name}」已被占用（${dup.status === 'retired' ? '已停用身份，独热保留' : '在册身份'}）。`)
  const aliasOf = db.prepare('SELECT hash FROM name_aliases WHERE name_key = ?').get(nn.key)
  if (aliasOf && aliasOf.hash !== row.hash) {
    throw new Error(`[拒绝] 新名「${nn.name}」是另一身份（#${aliasOf.hash.slice(0, 8)}）的历史名，不可占用。`)
  }
  const now = new Date().toISOString()
  // 多条写入包事务：拒绝路径在写入前已全部拦下（真零写入），此处防"写到一半失败"留下半截状态
  db.exec('BEGIN')
  let moved
  try {
    db.prepare('UPDATE identities SET name = ?, name_key = ? WHERE hash = ?').run(nn.name, nn.key, row.hash)
    // 绑定行存的是名字副本 → 改名必须传播（否则出现「两处真相」，与管理员 2026-10-01 要治的毛病同源）
    moved = db.prepare('UPDATE bindings SET name = ? WHERE name = ?').run(nn.name, row.name)
    // 改回自己的历史名时，该别名不再是"历史"，先摘掉再登记旧名
    db.prepare('DELETE FROM name_aliases WHERE name_key = ? AND hash = ?').run(nn.key, row.hash)
    db.prepare('INSERT OR REPLACE INTO name_aliases (name_key, name, hash, renamed_at, note) VALUES (?,?,?,?,?)')
      .run(row.name_key, row.name, row.hash, now, note ? String(note) : null)
    db.prepare('INSERT INTO renames (hash, old_name, new_name, at, actor, note) VALUES (?,?,?,?,?,?)')
      .run(row.hash, row.name, nn.name, now, actor ? String(actor) : null, note ? String(note) : null)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 回滚失败也要把原错抛出 */ }
    throw e
  }
  const out = db.prepare('SELECT * FROM identities WHERE hash = ?').get(row.hash)
  return { ...out, bindingsMoved: moved.changes ?? 0 }
}

/* ── 跨插件服务通道（2026-10-01 管理员账号指令）：被炉等消费方以服务调用写注册中心，
 *    按单写者规矩由本插件落笔；消费方不直写 registry.db。 ── */

/** 按 hash（全值或唯一前缀）或当前名定位身份行。 */
export function resolveIdentityRef(db, ref) {
  const q = String(ref ?? '').trim()
  if (!q) throw new Error('[错误] 需要 hash（全值或唯一前缀）或名字')
  if (/^[0-9a-fA-F]{8,64}$/.test(q)) {
    const h = q.toLowerCase()
    const exact = db.prepare('SELECT * FROM identities WHERE hash = ?').get(h)
    if (exact) return exact
    const cands = db.prepare('SELECT * FROM identities WHERE hash LIKE ?').all(h + '%')
    if (cands.length === 1) return cands[0]
    if (cands.length > 1) throw new Error(`[歧义] hash 前缀命中 ${cands.length} 条，请给更长的 hash`)
  }
  // 会话哈希路径（2026-10-01 交接首日实测补）：消费方（被炉 account 工具）传的 `hash` 是
  // **会话哈希**（= 被炉成员 ID = `bindings.session_hash`，由 sessionId 派生），而 `identities.hash`
  // 由**名字**派生——两者**不同源**（实测生产库 13 条绑定里同源 0 条），当身份 hash 直查必然落空。
  // 故先按绑定反查名字、再取身份行；随后才回落名字路径。
  if (/^[0-9a-f]{8}$/.test(q.toLowerCase())) {
    const bound = db.prepare('SELECT name FROM bindings WHERE session_hash = ?').get(q.toLowerCase())
    if (bound) {
      const byBind = db.prepare('SELECT * FROM identities WHERE name = ?').get(bound.name)
      if (byBind) return byBind
    }
  }
  const norm = normalizeName(q)
  if (norm.ok) {
    const row = db.prepare('SELECT * FROM identities WHERE name_key = ?').get(norm.key)
    if (row) return row
  }
  throw new Error(`[错误] 未找到身份：${q}`)
}

/** 服务实现（纯函数化：只依赖 state.getDb，便于桩测）。错误一律折成 {ok:false,error} 不抛。 */
export function buildInfraService(state) {
  return {
    version: 1,
    /** 改名：hash 不变 + 旧名入别名 + 改名账目。ref/hash 二者给一个即可。 */
    rename: async ({ ref, hash, newName, actor, note } = {}) => {
      try {
        const db = state.getDb()
        const row = resolveIdentityRef(db, ref ?? hash)
        const out = renameIdentity(db, row.name, newName, actor, note)
        if (out.noop) return { ok: true, noop: true, hash: out.hash, name: out.name, shortId: out.short_id }
        return { ok: true, hash: out.hash, name: out.name, shortId: out.short_id, bindingsMoved: out.bindingsMoved ?? 0 }
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) }
      }
    },
    /** 解绑会话（删 bindings 行）。仅在「删除账号」时使用；退房不解绑。 */
    unbind: async ({ sessionHash } = {}) => {
      try {
        const db = state.getDb()
        const r = unbindSession(db, { session: sessionHash })
        return { ok: true, removed: r.nothing ? 0 : 1, name: r.released ? r.released.name : null }
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) }
      }
    },
    /**
     * L2（＋可选 L3）删除会话运行身份：解绑 + 清登记 + 写墓碑 +（可选）注销名字。
     * 单事务、幂等。`retireName` **默认 false**——名字不回收，烧名字必须显式点；
     * 管理员裁定的产品语义（删除账号 ⇒ 一并 retire）由消费方显式传 `retireName: true`。
     */
    forgetSession: async ({ sessionHash, actor, reason, retireName = false } = {}) => {
      try {
        const db = state.getDb()
        return forgetSession(db, { sessionHash, actor, reason, retireName })
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) }
      }
    },
    /** 复活：写 'lift' 事件。**当前语义 = 管理员专用**（工具动作 revive 是唯一入口，契约 §8.2 硬拒裁定）。 */
    liftTombstone: async ({ sessionHash, actor, reason } = {}) => {
      try {
        const db = state.getDb()
        return liftTombstone(db, { sessionHash, actor, reason })
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) }
      }
    },
    /** 单点查态：该会话当前是否被删。消费方查"是否被删"用这个，别用 since:0 拉全量事件流（会踩水位坑）。 */
    isForgotten: async ({ sessionHash } = {}) => {
      try {
        const db = state.getDb()
        return { ok: true, forgotten: isForgotten(db, sessionHash) }
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) }
      }
    },
    /** 同步游标：{ seq, identities（全量）, bindings（全量）, forgotten（全量）, tombstones（id > since 增量） }。 */
    changes: async ({ since = 0 } = {}) => {
      try {
        const db = state.getDb()
        return { ok: true, ...changesSince(db, since) }
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) }
      }
    },
  }
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

/* ── 删除与跨系统同步（v0.4.0，管理员 2026-10-01 裁定：删除 = L1 退房 + L2 删运行身份 + L3 注销名字） ── */

/** 该会话当前是否处于「已忘记」态。墓碑**只增不改**：当前状态 = 该会话 id 最大的那行。 */
export function isForgotten(db, rawSessionHash) {
  const sh = normSessionHash(rawSessionHash)
  const row = db.prepare('SELECT op FROM tombstones WHERE session_hash = ? ORDER BY id DESC LIMIT 1').get(sh)
  return !!row && row.op === 'forget'
}

/**
 * L2（＋可选 L3）：删除一个会话的运行身份。单事务完成：
 * 解绑 `bindings` → 清 `session_seen` 登记 → 写 'forget' 墓碑 →（可选）retire 持久名。
 * 幂等：重复调用不新增墓碑事件，`unbound` 返回 0。
 * ⚠ `retireName` 默认 **false**：名字独热不回收 ⇒ retire 等于**永久烧掉一个名字**，必须显式点。
 *   管理员裁定的产品语义是「删除账号 ⇒ 一并 retire」，由消费方（被炉 account delete）显式传 true——
 *   「接口默认」与「产品语义」分开写，避免两处真相。
 * ⚠ 事务内任一步失败即整单回滚（不做"删了一半"），错误原样抛出由工具/服务折成显式失败。
 */
export function forgetSession(db, { sessionHash, actor, reason, retireName = false } = {}) {
  const sh = normSessionHash(sessionHash)
  const now = new Date().toISOString()
  const already = isForgotten(db, sh)
  const bound = db.prepare('SELECT name FROM bindings WHERE session_hash = ?').get(sh)
  let retired = false
  db.exec('BEGIN')
  let removed = 0
  try {
    removed = db.prepare('DELETE FROM bindings WHERE session_hash = ?').run(sh).changes ?? 0
    db.prepare('DELETE FROM session_seen WHERE session_hash = ?').run(sh)
    if (!already) {
      db.prepare('INSERT INTO tombstones (session_hash, op, at, actor, reason) VALUES (?,?,?,?,?)')
        .run(sh, 'forget', now, actor ? String(actor) : null, reason ? String(reason) : null)
    }
    if (retireName && bound && bound.name) {
      const r = retireIdentity(db, bound.name, reason ? String(reason) : null)
      retired = r.alreadyRetired ? 'already-retired' : 'retired'
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 回滚失败也要把原错抛出 */ }
    throw e
  }
  return { ok: true, sessionHash: sh, tombstone: true, alreadyForgotten: already, unbound: removed, name: bound ? bound.name : null, retired, at: now }
}

/**
 * 复活：写一条 'lift' 事件（**不删历史**，与 renames 同纪律）。
 * ⚠ 顺序：显式再注册路径必须**先调它、再建自己的本地记录**——否则消费方下一轮轮询看到
 * 仍是 'forget'，会把刚建好的本地记录当成墓碑清掉（自删除环）。
 */
export function liftTombstone(db, { sessionHash, actor, reason } = {}) {
  const sh = normSessionHash(sessionHash)
  if (!isForgotten(db, sh)) return { ok: true, sessionHash: sh, lifted: false, alreadyActive: true }
  db.prepare('INSERT INTO tombstones (session_hash, op, at, actor, reason) VALUES (?,?,?,?,?)')
    .run(sh, 'lift', new Date().toISOString(), actor ? String(actor) : null, reason ? String(reason) : null)
  return { ok: true, sessionHash: sh, lifted: true }
}

/**
 * 同步游标：**小表全量快照 + 墓碑流按 id 增量**。
 * 为什么不给每个写路径都记一笔事件：现有 6 个写身份的动作 + bind/unbind 都要记得 append，
 * **漏一个就是静默漏事件**；而 identities/bindings 只有十几行，全量重读成本≈0。
 * 于是「只有一处需要写对」——墓碑表由 forgetSession / liftTombstone 独占写入。
 * 改名/别名**不进事件流**：读取时按 hash 解析已覆盖（C1 口径）。
 */
export function changesSince(db, since = 0) {
  const from = Number.isFinite(Number(since)) ? Number(since) : 0
  const tombstones = db.prepare('SELECT id, session_hash, op, at, actor, reason FROM tombstones WHERE id > ? ORDER BY id').all(from)
  const maxRow = db.prepare('SELECT MAX(id) AS m FROM tombstones').get()
  // 当前仍处于墓碑态的会话（最新一条事件是 'forget'）——**全量快照**，与 identities/bindings 同构。
  // 为什么要有它：消费方要回答"这个会话是不是被删了"，若只能拉 since:0 的全量事件流来查态，
  // 就会踩上「顺手推水位 → 漏事件」的坑（被炉实测踩到过，本字段因此补）。查态与消费事件由此分开。
  const forgotten = db.prepare(`
    SELECT session_hash FROM tombstones t
    WHERE t.op = 'forget'
      AND t.id = (SELECT MAX(id) FROM tombstones WHERE session_hash = t.session_hash)
    ORDER BY session_hash
  `).all().map(r => r.session_hash)
  return {
    seq: maxRow && maxRow.m ? maxRow.m : 0,
    identities: listIdentities(db),
    bindings: listBindings(db),
    forgotten,
    tombstones,
  }
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

/**
 * **功能性**探活：真发一次 embeddings，要求 200 + 向量维度 > 0。
 * 2026-10-02 青简实测（我复核时那台已被换掉、无法复现，但形态成立）：llama-server 会进入
 * 「`/health` 200 但真嵌入全部超时」的僵死态——此时 `probe()`（只看 `/health`）**会说谎**：
 * 看门狗判"在线"→ 既不告警也不恢复，`embed-status` 也报"在线"，消费方则全部等满超时。
 * 与 2026-10-01 的存活恢复同族：**探针只验了"HTTP 活着"，没验"活儿能干"**。
 * 维度判 `>0` 而非硬编码 1024（换模型 = 全量重嵌，维度判据不该钉死在探针里）。
 */
export async function probeEmbed(cfg, { timeoutMs } = {}) {
  const ms = Number(timeoutMs) || Number(cfg.probeEmbedTimeoutMs) || 8000
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const res = await fetch(new URL('/v1/embeddings', cfg.embedUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: ['ping'] }),
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, status: res.status, elapsedMs: Date.now() - started, error: `HTTP ${res.status}` }
    const j = await res.json().catch(() => null)
    const dims = j && Array.isArray(j.data) && j.data[0] && Array.isArray(j.data[0].embedding) ? j.data[0].embedding.length : 0
    if (!dims) return { ok: false, status: res.status, elapsedMs: Date.now() - started, error: '响应里没有向量' }
    return { ok: true, status: res.status, dims, elapsedMs: Date.now() - started }
  } catch (err) {
    const timeout = err && err.name === 'AbortError'
    return { ok: false, status: 0, elapsedMs: Date.now() - started, error: timeout ? `超时 ${ms}ms` : ((err && err.message) || String(err)) }
  } finally {
    clearTimeout(timer)
  }
}

export function launch(cfg) {
  try {
    const exe = String(cfg.serverExe || '')
    if (!exe || !existsSync(exe)) return `[错误] 未找到 llama-server：${exe}`
    const args = Array.isArray(cfg.serverArgs) ? cfg.serverArgs.map(String) : []
    // 子进程输出落盘（2026-10-01 事故后新增）：旧版 stdio:'ignore' 把 llama-server 的输出全丢了，
    // 服务当晚静默死亡 ≥90 分钟而**死因无从查起**。落盘之后"为什么死"才有据可查。
    // 落盘失败一律退回旧行为——绝不因为写日志而拉不起服务。
    let stdio = 'ignore'
    let outFd = null
    const logFile = String(cfg.serverLogFile || '').trim()
    if (logFile) {
      try {
        mkdirSync(dirname(logFile), { recursive: true })
        appendFileSync(logFile, `\n===== launch @ ${new Date().toISOString()} =====\n`)
        outFd = openSync(logFile, 'a')
        stdio = ['ignore', outFd, outFd]
      } catch { outFd = null; stdio = 'ignore' }
    }
    // detached 故意为 false（embed 插件实测：true 会被 Node 升级成 CREATE_NEW_CONSOLE 冒黑框）
    const child = spawn(exe, args, {
      cwd: existsSync(String(cfg.serverCwd || '')) ? cfg.serverCwd : undefined,
      stdio,
      windowsHide: true,
    })
    if (outFd !== null) { try { closeSync(outFd) } catch { /* 父端关掉，子进程仍持有 */ } }
    child.unref()
    explicitStop = false   // 任何一次拉起都表示"我们要它活着"——清掉显式停止标记
    return `已启动（直起 exe，无窗${outFd !== null ? `，输出→${logFile}` : '，输出已丢弃'}）`
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

/** 某端口当前 ESTABLISHED 连接数（0 = 空闲）。看门狗顺延判据用。 */
export function establishedOnPort(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
      encoding: 'utf-8', windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
    })
    let n = 0
    for (const line of String(out).split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length >= 4 && cols[3] === 'ESTABLISHED' && (cols[1].endsWith(':' + port) || cols[2].endsWith(':' + port))) n++
    }
    return n
  } catch { return 0 }
}

/** 按映像名列出存活 PID（tasklist CSV）。防重复拉起判据：进程在（哪怕还没监听）就不许再 spawn。 */
export function serverPids(exe) {
  try {
    const image = String(exe || '').split(/[\\/]/).pop() || 'llama-server.exe'
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf-8', windowsHide: true, timeout: 20000, maxBuffer: 1 << 20,
    })
    const pids = []
    for (const line of String(out).split(/\r?\n/)) {
      if (!line.includes(image)) continue
      const cols = line.split('","')
      const pid = Number((cols[1] || '').replace(/"/g, ''))
      if (Number.isFinite(pid) && pid > 0) pids.push(pid)
    }
    return pids
  } catch { return [] }
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
/** 操作员是否显式停过服务（embed-stop 置 true，任何一次成功 launch / embed-ensure 清 false）。
 *  作用：让"存活恢复"不去抢人有意关掉的服务——「谁关的」必须可分辨，否则又是一个两处真相。 */
let explicitStop = false

/**
 * 存活恢复判据（**纯函数**，便于桩测）：探活失败 + 无进程 + 不是显式停的 + 自动拉起开着 → 该恢复。
 * 2026-10-01 事故（服务静默死亡 ≥90 分钟、消费方三次 `嵌入请求失败(fetch failed)`）：
 * 旧看门狗**只查内存超限**，服务不在线就直接 return —— 进程崩了没人拉起，直到下次 DSH 重启。
 * 判据抽成纯函数是刻意的：这条规则错一次就是"服务死了没人管"，必须有可跑的用例钉住。
 */
export function shouldRecoverLiveness({ probeOk, pids, explicitStop: stopped, autoEnsureOnLoad } = {}) {
  if (probeOk) return false
  if (Array.isArray(pids) && pids.length) return false   // 进程在（可能在载入模型）→ 不重复拉起
  if (stopped) return false                              // 操作员显式停过 → 不抢
  if (!autoEnsureOnLoad) return false                     // 配置关了自动拉起 → 不抢
  return true
}

/** 插件加载 / 冷却带起：探活在线就不动作（fire-and-forget，不阻塞宿主）。
 *  2026-10-01 教训（GPU 空转满载排查）：churn 期本函数曾被每分钟触发一次、probe 一失败就
 *  无脑 spawn → 一天 18 个 llama-server 实例抢 8082，每次 spawn 都是整模 GPU 载入。
 *  现改为：冷却 180s + spawn 前先查存活进程——进程在（哪怕还在载入模型）就不许再拉一个。 */
export function ensureInFlow(cfg, logger, { force = false } = {}) {
  if (!force && !cfg.autoEnsureOnLoad) return
  if (!force && Date.now() - lastEnsureAt < 180000) return
  lastEnsureAt = Date.now()
  void (async () => {
    const before = await probe(cfg)
    if (before.ok) return
    const exist = serverPids(cfg.serverExe)
    if (exist.length) {
      logger?.info?.(`[${PLUGIN_NAME}] /health 未就绪但已有 llama-server 进程（PID ${exist.join('/')}，可能在载入模型）——不重复拉起，等它自愈`)
      return
    }
    const res = launch(cfg)
    // 拉起结果**按实际返回值**记账：旧版无条件报「已在后台拉起」，spawn 失败时同样报成功 = 静默失败
    if (String(res).startsWith('[错误]')) {
      logger?.warn?.(`[${PLUGIN_NAME}] 向量服务拉起失败：${res}`)
      return
    }
    logger?.info?.(`[${PLUGIN_NAME}] 向量服务离线，已在后台拉起（${res}）`)
    // 存活自证：3s 后复查进程；起不来必须说出来，不能让"已拉起"这句话替事实背书
    setTimeout(() => {
      try {
        if (!serverPids(cfg.serverExe).length) {
          logger?.warn?.(`[${PLUGIN_NAME}] 拉起后 3s 仍无 llama-server 进程——拉起可能失败，请查 ${cfg.serverExe} 与显存`)
        }
      } catch { /* 复查失败不抛 */ }
    }, 3000)
  })().catch(() => {})
}

let lastWatchdogRestart = ''
let overLimitStreak = 0
let funcFailStreak = 0

/** 单次看门狗检查：在线 → 读私有提交 → 连续两轮超限且空闲才 stop+launch。失败只 warn，绝不抛。
 *  2026-10-01 教训（本日事故复盘）：旧 embed 看门狗「单次超限即杀」，同日击杀 80 次
 *  （凌晨无任务时段也每 5 分钟杀一次）——每次击杀都是整模 GPU 重载尖峰。
 *  现加两道闸：①连续 2 轮超限才动手（防抖，300s 间隔下 = 需持续超限 10 分钟）；
 *  ②8082 有活动连接就顺延（不在批量向量化进行到一半时杀）。 */
export async function watchdogTick(cfg, logger) {
  try {
    const up = await probe(cfg)
    if (!up.ok) {
      overLimitStreak = 0
      // 2026-10-01 事故修复：旧版这里直接 return —— 看门狗**只管内存超限、不管进程还在不在**，
      // 于是 llama-server 一崩就再没人拉起（当晚 ≥90 分钟无人察觉，消费方三次 fetch failed）。
      const pids = serverPids(cfg.serverExe)
      if (shouldRecoverLiveness({ probeOk: up.ok, pids, explicitStop, autoEnsureOnLoad: cfg.autoEnsureOnLoad })) {
        logger?.warn?.(`[${PLUGIN_NAME}] 看门狗：向量服务不在线且无 llama-server 进程 → 按存活恢复拉起（explicitStop=false）`)
        ensureInFlow(cfg, logger)
      } else if (!pids.length && explicitStop) {
        logger?.info?.(`[${PLUGIN_NAME}] 看门狗：向量服务不在线，但此前被**显式停过**（explicitStop=true）——不抢，恢复请用 embed-ensure`)
      }
      return
    }
    const pid = listeningPid(cfg.embedPort)
    if (!pid) { overLimitStreak = 0; return }
    // 功能性自检（2026-10-02 补，青简实测逼出）：`/health` 200 不等于"活儿能干"——
    // 僵死态下 probe() 说在线、看门狗既不告警也不恢复，消费方却全部等满超时。
    // 故在线之后必须**真发一次请求**验功能；连续 2 轮失败即判僵死并重启（防抖同上）。
    const fn = await probeEmbed(cfg)
    if (!fn.ok) {
      funcFailStreak++
      const busy = establishedOnPort(cfg.embedPort)
      logger?.warn?.(`[${PLUGIN_NAME}] 看门狗：/health 在线但**实调自检失败**（${fn.error}｜${fn.elapsedMs}ms｜活动连接 ${busy}｜连续第 ${funcFailStreak} 轮）`)
      if (funcFailStreak >= 2) {
        logger?.warn?.(`[${PLUGIN_NAME}] 看门狗：实调自检连续 ${funcFailStreak} 轮失败——判定**僵死**（HTTP 活着但干不了活），执行 stop+launch`)
        const stopped = stopService(cfg)
        await sleep(1500)
        const launched = launch(cfg)
        funcFailStreak = 0
        lastWatchdogRestart = `${new Date().toLocaleString('zh-CN')}｜实调自检僵死 → 重启（stop=${stopped.ok ? 'ok' : 'fail'} launch=${launched}）`
        logger?.info?.(`[${PLUGIN_NAME}] 看门狗重启完成：${lastWatchdogRestart}`)
      }
      return
    }
    funcFailStreak = 0
    const mb = privateCommitMb(pid)
    if (!mb) return
    const limit = Math.max(512, Number(cfg.watchdogLimitMb) || 4096)
    if (mb <= limit) { overLimitStreak = 0; return }
    overLimitStreak++
    if (overLimitStreak < 2) {
      logger?.warn?.(`[${PLUGIN_NAME}] 看门狗：私有提交 ${mb.toFixed(0)}MB 超过 ${limit}MB（连续第 ${overLimitStreak} 轮，下轮仍超才重启）`)
      return
    }
    const busy = establishedOnPort(cfg.embedPort)
    if (busy > 0) {
      logger?.warn?.(`[${PLUGIN_NAME}] 看门狗：私有提交 ${mb.toFixed(0)}MB 已连续 ${overLimitStreak} 轮超限，但有 ${busy} 条活动连接——顺延到空闲再重启`)
      return
    }
    logger?.warn?.(`[${PLUGIN_NAME}] 看门狗：llama-server(PID ${pid}) 私有提交 ${mb.toFixed(0)}MB 连续 ${overLimitStreak} 轮超过 ${limit}MB 且已空闲，自动重启`)
    const stopped = stopService(cfg)
    await sleep(1500)
    const launched = launch(cfg)
    overLimitStreak = 0
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

/**
 * 账目 actor 解析：**显式 actor > 调用方会话绑定的身份名 > null**。
 * v0.4.0 补齐（拾遗 2026-10-01 实测）：`forget` 原样取 `args.actor || null`，调用方不写 actor
 * 时账目里"**谁删的**"就丢了（三条墓碑 actor=null）——"做了什么"和"谁做的"在账号体系里同等重要。
 * 与 register/bind 的归属推导同源（callerSessionOf + sessionHashFor + bindings）。
 */
export function resolveActor(db, { actor, exec } = {}) {
  const explicit = String(actor || '').trim()
  if (explicit) return explicit
  const caller = callerSessionOf(exec)
  if (!caller) return null
  try {
    const b = bindingFor(db, sessionHashFor(caller.id))
    return b ? b.name : null
  } catch { return null }
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

const REGISTRY_ACTIONS = 'register / verify / lookup / list / rename / retire / attribute / bind / unbind / binding / bindings / forget / revive / status'
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
        description: `操作：${REGISTRY_ACTIONS}｜${EMBED_ACTIONS}。`
          + 'revive 是**唯一**的复活入口——被炉等消费方对墓碑采取**硬拒**语义（join / mode 等入房路径都会拒绝，不会自动恢复，管理员 2026-10-01 裁定）。',
      },
      name: { type: 'string', description: 'register/verify/lookup/rename/retire/attribute/bind/unbind/binding 用：独特名（rename 时为旧名）' },
      new: { type: 'string', description: 'rename 用：新名（全局独热；hash 不变，只换展示名）' },
      actor: { type: 'string', description: 'rename/forget/revive 用：发起者（独特名，可选；省略则按调用方会话绑定的身份名落账目——账目里"谁做的"与"做了什么"同等重要）' },
      id: { type: 'string', description: 'lookup 用：短或全 hash（8~64 位十六进制）' },
      session: { type: 'string', description: 'bind/unbind/binding/forget/revive 用：会话哈希（8 位十六进制，注入提示里给的）' },
      retire: { type: 'string', description: "forget 用：传 'true' 才同时注销持久名（默认只解绑不烧名字；名字独热不回收，烧了不可逆）" },
      workspace: { type: 'string', description: 'register/attribute 用：归属工作区名（名字按工作区归属）' },
      note: { type: 'string', description: 'register/retire/bind/forget/revive 用：备注（归属、用途、删除原因等）' },
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
        if (r.available) return `[可用] 「${r.name}」未被占用，可注册。\n  注册后身份hash将为：${r.hash}`
        if (r.status === 'alias') return `[历史名] 「${r.name}」${r.reason}（现名「${r.aliasOf}」，#${r.shortId}）`
        return `[占用] 「${r.name}」${r.reason}｜短ID ${r.shortId}｜注册于 ${r.registeredAt}`
      }
      if (action === 'lookup') {
        const db = state.getDb()
        const r = lookupIdentity(db, { name: args.name, id: args.id })
        if (r.row) return `[OK] （按${r.by === 'name' ? '名字' : 'hash'}命中）\n${fmtRow(r.row)}`
        if (r.alias) {
          const cur = db.prepare('SELECT * FROM identities WHERE hash = ?').get(r.alias.hash)
          return `[历史名] 「${r.alias.name}」是旧名（${r.alias.renamed_at} 改名）——现名「${cur ? cur.name : '?'}」：\n`
            + (cur ? fmtRow(cur) : `  #${r.alias.hash.slice(0, 8)}`)
        }
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
      if (action === 'forget') {
        const db = state.getDb()
        const retireName = String(args.retire || '').toLowerCase() === 'true'
        const r = forgetSession(db, { sessionHash: args.session, actor: resolveActor(db, { actor: args.actor, exec }), reason: args.note || null, retireName })
        return `[OK] 已删除会话运行身份：${r.sessionHash}`
          + `\n  └─ 解绑 ${r.unbound} 条｜墓碑已写${r.alreadyForgotten ? '（此前已在墓碑中，幂等未重复记账）' : ''}`
          + `｜名字「${r.name || '(无绑定)'}」${r.retired === 'retired' ? '**已注销**（独热保留、不回收）' : r.retired === 'already-retired' ? '此前已注销' : '保持 active（未烧名字）'}`
          + `\n  └─ 消费方（被炉/便签）按服务 changes(since) 游标各自清理自己的库`
      }
      if (action === 'revive') {
        const db = state.getDb()
        const r = liftTombstone(db, { sessionHash: args.session, actor: resolveActor(db, { actor: args.actor, exec }), reason: args.note || null })
        return r.lifted
          ? `[OK] 已复活会话 ${r.sessionHash}（墓碑留痕 'lift'，历史不删）。`
            + `\n  └─ 消费方（被炉等）按 changes(since) 消费到这条 lift 事件后解除本地墓碑；这是**唯一**的复活通道。`
          : `[OK] 会话 ${r.sessionHash} 无墓碑（本就活跃），无需复活。`
      }
      if (action === 'rename') {
        const db = state.getDb()
        const r = renameIdentity(db, args.name, args.new, resolveActor(db, { actor: args.actor, exec }), args.note)
        if (r.noop) return `[OK] 新旧同名（幂等）：「${r.name}」#${r.short_id}，未产生变更与账目。`
        const rev = db.prepare('SELECT COUNT(*) AS c FROM renames WHERE hash = ?').get(r.hash).c
        return `[OK] 改名成功：「${args.name}」→「${r.name}」（#${r.short_id}）`
          + `\n  └─ hash 不变（账号 ID 不随名字变）｜旧名「${args.name}」已登记别名（lookup 旧名可回查）`
          + `｜改名账目 rev ${rev}｜同步绑定行 ${r.bindingsMoved ?? 0} 条`
          + '\n' + fmtRow(r)
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
        explicitStop = true   // 显式停：看门狗"存活恢复"从此不抢（谁关的必须可分辨）
        return r.pid
          ? `[OK] 已关停向量服务（PID ${r.pid}）。\n  └─ 已标记**显式停止**：看门狗不会把它抢回来（防"我关了它又自己活了"）。恢复用 embed-ensure 或 embed-restart。`
          : '[OK] 端口上没有监听进程。'
      }
      if (action === 'embed-restart') {
        const r = stopService(cfg)
        await sleep(1500)
        const up = await ensureReady(cfg)
        if (!up.ok) return `[错误] 重启失败：${up.error || '等待就绪超时'}`
        return `[OK] 向量服务已重启并就绪（${up.seconds}s）：${cfg.embedUrl}\n${up.body}`
      }
      if (action === 'embed-ensure') {
        explicitStop = false   // ensure 表示"要它活着"——清掉显式停止标记
        const up = await ensureReady(cfg)
        if (up.ok) return up.already ? `[OK] 向量服务已在线：${cfg.embedUrl}\n${up.body}` : `[OK] 向量服务已就绪（${up.seconds}s）：${cfg.embedUrl}\n${up.body}`
        if (up.pending) return `[待加载] 已拉起，${up.seconds}s 未就绪（模型首次加载更久）。稍后 embed-status 复查。`
        return `[错误] ${up.error}`
      }
      if (action === 'embed-status') {
        const before = await probe(cfg)
        const pid = listeningPid(cfg.embedPort)
        // 2026-10-02（青简要的那条）：把"探活"与"实调自检"分开显示——**让"在线"这个词不再有歧义**。
        // 僵死态（/health 200 但干不了活）下旧版会报"在线"，把消费方和运维一起骗过去。
        const fn = before.ok ? await probeEmbed(cfg) : null
        const head = !before.ok
          ? `[离线] ${cfg.embedUrl}（${before.body}）`
          : (fn && fn.ok
            ? `[OK] 向量服务在线且**实调可用**：${cfg.embedUrl}`
            : `[可疑] /health 在线，但**实调自检失败**：${fn ? fn.error : '未测'}——消费方调用会等满超时，建议 embed-restart`)
        return [
          head,
          `[端口] ${cfg.embedPort}${pid ? `　PID ${pid}` : '　（无监听进程）'}`,
          `[实调自检] ${fn ? (fn.ok ? `✅ 维度 ${fn.dims}｜${fn.elapsedMs}ms` : `❌ ${fn.error}｜已等 ${fn.elapsedMs}ms`) : '（服务不在线，未测）'}`,
          `[启动方式] 直起 exe ${cfg.serverExe}（无窗）｜所有权：基建（autoEnsure=${cfg.autoEnsureOnLoad}）`,
          before.ok ? before.body : '',
        ].filter(Boolean).join('\n')
      }

      return `[错误] 未知 action：${action}（可用：${REGISTRY_ACTIONS}｜${EMBED_ACTIONS}）`
    },
  })
}

function registerTools(ctx, cfg, state) {  ctx.effect(() => ctx.tools.register(
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

/** 把服务挂上宿主通道：优先 ctx.provide（cordis 标准形），回退 ctx.reflect.provide；
 *  两者都没有 → 明确告警（不静默），工具面仍可单独承担改名/解绑。 */
function provideService(ctx, state) {
  const svc = buildInfraService(state)
  const arm = (label, fn) => {
    try {
      const disposer = fn('liubianInfra', svc)
      ctx.logger?.info?.(`[${PLUGIN_NAME}] 跨插件服务已挂载：liubianInfra v${svc.version}（${label}）`)
      return disposer
    } catch (e) {
      ctx.logger?.warn?.(`[${PLUGIN_NAME}] 跨插件服务挂载失败（${label}）：${(e && e.message) || e}`)
      return undefined
    }
  }
  if (typeof ctx.provide === 'function') {
    ctx.effect(() => arm('ctx.provide', (n, v) => ctx.provide(n, v)), 'dsh-liubian-infra: 跨插件服务')
  } else if (typeof ctx.reflect?.provide === 'function') {
    ctx.effect(() => arm('ctx.reflect.provide', (n, v) => ctx.reflect.provide(n, v)), 'dsh-liubian-infra: 跨插件服务')
  } else {
    ctx.logger?.warn?.(`[${PLUGIN_NAME}] 宿主无 provide 通道（ctx.provide / ctx.reflect.provide 皆不可用）——跨插件写服务未挂载；改名/解绑仍可走 infra 工具面`)
  }
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
  provideService(ctx, state)

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
  isForgotten,
  forgetSession,
  liftTombstone,
  changesSince,
  shouldRecoverLiveness,
  probeEmbed,
  bindingFor,
  listBindings,
  attributeWorkspace,
  noteSession,
  seenWorkspaceFor,
  deriveSessionWorkspace,
  callerSessionOf,
  resolveActor,
  probe,
  launch,
  ensureReady,
  listeningPid,
  stopService,
  privateCommitMb,
  watchdogTick,
}
