/**
 * dsh-liubian-infra —— 流变·基建
 *
 * 两大职责（管理员 2026-10-01 钉）：
 *   1. 独特名注册中心：每个智能体一个全局独热唯一的名字；注册时自动从名字
 *      派生 SHA-256 哈希作为身份唯一标识符；全家族插件统一查询注册表。
 *   2. 向量服务控制面：移植自 dsh-liubian-embed（服务本体不变）。
 *      ⚠ v0.1 过渡期：embed 插件仍是服务所有者（加载自动带起 + 看门狗），
 *      本插件只提供手动控制面（status/ensure/stop/restart），不开看门狗、
 *      不自动拉起 —— 避免双看门狗与双 ensure 竞争。挂牌迁移完成后切换。
 *
 * 接口与构造依据：docs/流变插件族接口与构造标准_v0.1.md
 * 注册语义依据：docs/流变独特名注册契约_v1.md（本插件是该契约的参考实现）
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { defineTool } from '@deepseek-ai/dsh-tools'

export const PLUGIN_VERSION = '0.1.0'
export const CONTRACT_VERSION = '1.0'

const HOME = process.env.USERPROFILE || process.env.HOME || 'C:/Users/Feng'
export const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh')

export const TOOL_NAME = '_dsh_external_dsh_liubian_infra'

/* ══ 配置（标准 §5：DEFAULTS → config.json 剥 BOM → 宿主 input，单入口） ══ */

export const DEFAULTS = {
  /** 注册表数据库（共享资源登记表 §10：归属基建，消费方=全家只读，变更通报基石） */
  dbPath: join(DSH_HOME, 'liubian-infra', 'registry.db'),
  /** 向量服务（与 dsh-liubian-embed 同一份配置源 ~/.dsh/liubian/embed.json，共享键同名） */
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

/* ══ 独特名：纯函数（契约 v1 的派生规则，消费方照此实现必须得到同一结果） ══ */

/**
 * 名字规范化（标准 §8：注册与校验两侧必须调用同一派生函数）。
 * 规则：去首尾空白 → NFC 规范化 → 非空、≤64 字符、不含控制字符、
 *       不以 @ 或 # 开头（保留给提及/标签语法）。
 * name_key = 小写化（大小写不敏感唯一：中文不受影响，ASCII 防混淆）。
 */
export function normalizeName(raw) {
  let name = String(raw ?? '').trim().normalize('NFC')
  if (!name) return { ok: false, error: '名字不能为空' }
  if (name.length > 64) return { ok: false, error: `名字过长（${name.length} > 64 字符）` }
  if (/^[@#]/.test(name)) return { ok: false, error: '名字不能以 @ 或 # 开头（保留语法字符）' }
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: '名字含控制字符' }
  return { ok: true, name, key: name.toLowerCase() }
}

/** 身份哈希：SHA-256(UTF-8(NFC(name))) 十六进制小写 64 位。全局唯一标识符。 */
export function deriveHash(name) {
  return createHash('sha256').update(name, 'utf8').digest('hex')
}

/**
 * git 式最短唯一前缀（被炉的「会话号 SHA256 前 8 位」惯例的无碰撞推广）：
 * 从 8 位起找能让集合内所有 hash 前缀互不相同的长度；无碰撞时恒为 8。
 * short_id 随表演化（新注册可能使既有条目扩位），语义与 git 短哈希一致。
 */
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

/* ══ 注册表存储（单写多读：只有本插件写；其他插件只读 DB 文件，契约 v1 §4） ══ */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS identities (
  name        TEXT PRIMARY KEY,
  name_key    TEXT NOT NULL UNIQUE,
  hash        TEXT NOT NULL UNIQUE,
  short_id    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  note        TEXT,
  created_at  TEXT NOT NULL,
  retired_at  TEXT,
  retired_note TEXT
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA busy_timeout=5000')
  db.exec(SCHEMA)
  return db
}

export function recomputeShortIds(db) {
  const rows = db.prepare('SELECT hash FROM identities').all()
  const map = computeShortIds(rows.map(r => r.hash))
  const upd = db.prepare('UPDATE identities SET short_id = ? WHERE hash = ?')
  for (const r of rows) upd.run(map[r.hash], r.hash)
}

/** 注册。名字全局独热：占用即拒绝（含已停用名——独热保留不回收）。 */
export function registerIdentity(db, rawName, note) {
  const norm = normalizeName(rawName)
  if (!norm.ok) throw new Error(`[拒绝] ${norm.error}`)
  const { name, key } = norm
  const hash = deriveHash(name)
  const dup = db.prepare('SELECT name, status, short_id, created_at FROM identities WHERE name_key = ?').get(key)
  if (dup) {
    const st = dup.status === 'retired' ? `已停用于 ${dup.retired_at || '?'}（独热保留，不回收）` : '在册'
    throw new Error(`[拒绝] 名字「${name}」已被注册：${st}｜短ID ${dup.short_id}｜注册于 ${dup.created_at}。全局独热，同一名字不可二次注册。`)
  }
  const byHash = db.prepare('SELECT name FROM identities WHERE hash = ?').get(hash)
  if (byHash) throw new Error(`[拒绝] 哈希与在册条目「${byHash.name}」碰撞（SHA-256 碰撞属异常，请核查派生函数是否一致）`)
  const now = new Date().toISOString()
  db.prepare('INSERT INTO identities (name, name_key, hash, short_id, status, note, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(name, key, hash, hash.slice(0, 8), 'active', note ? String(note) : null, now)
  recomputeShortIds(db)
  return db.prepare('SELECT * FROM identities WHERE name_key = ?').get(key)
}

/** 唯一性校验（无副作用）：可用 / 已被谁占用。 */
export function verifyName(db, rawName) {
  const norm = normalizeName(rawName)
  if (!norm.ok) return { ok: false, available: false, error: norm.error }
  const row = db.prepare('SELECT name, status, short_id, created_at, retired_at FROM identities WHERE name_key = ?').get(norm.key)
  if (!row) return { ok: true, available: true, name: norm.name, hash: deriveHash(norm.name) }
  return {
    ok: true,
    available: false,
    name: row.name,
    status: row.status,
    shortId: row.short_id,
    registeredAt: row.created_at,
    retiredAt: row.retired_at || undefined,
    reason: row.status === 'retired' ? '已停用（独热保留，不回收）' : '在册',
  }
}

/** 查询：按 name，或按短/全 hash（≥8 位 hex 前缀）。 */
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
  return db.prepare('SELECT name, hash, short_id, status, note, created_at, retired_at FROM identities ORDER BY created_at').all()
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

/* ══ 向量服务控制面（移植自 dsh-liubian-embed；契约 v1.2 语义不变） ══ */

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
    `  注册   ${r.created_at}${r.retired_at ? `｜停用 ${r.retired_at}${r.retired_note ? `（${r.retired_note}）` : ''}` : ''}`,
    r.note ? `  说明   ${r.note}` : '',
  ].filter(Boolean).join('\n')
}

function registerInfraTool(ctx, cfg, state) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: '流变·基建（dsh-liubian-infra）：独特名注册中心 + 向量服务控制面。'
      + '独特名 = 全局独热唯一的智能体名，注册时自动派生 SHA-256 哈希作为身份唯一标识符，'
      + '全家族插件统一查询注册表（契约 v1.0：docs/流变独特名注册契约_v1.md）。'
      + 'action: register 注册｜verify 唯一性校验（无副作用）｜lookup 按 name 或 hash 查｜list 全表｜retire 停用（独热保留）'
      + '｜status 总览｜embed-status / embed-ensure / embed-stop / embed-restart 向量服务控制（v0.1 过渡期手动控制）。',
    parameters: {
      action: {
        type: 'string', required: true,
        description: '操作：register / verify / lookup / list / retire / status / embed-status / embed-ensure / embed-stop / embed-restart',
      },
      name: { type: 'string', description: 'register/verify/lookup/retire 用：独特名' },
      id: { type: 'string', description: 'lookup 用：短或全 hash（8~64 位十六进制）' },
      note: { type: 'string', description: 'register/retire 用：备注（归属、用途等）' },
    },
    output: OUT,
    async execute(args) {
      const action = String(args.action || 'status').toLowerCase()

      /* ── 注册中心 ── */
      if (action === 'register') {
        const db = state.getDb()
        const row = registerIdentity(db, args.name, args.note)
        return fmtRow(row) + `\n  └─ 注册表现有 ${listIdentities(db).length} 个身份`
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
          `  ${r.status === 'retired' ? '○' : '●'} ${r.name}  #${r.short_id}${r.note ? `  ｜${r.note}` : ''}`)
        return `注册表（${rows.length} 个，● 在册 ○ 停用）：\n${lines.join('\n')}`
      }
      if (action === 'retire') {
        const db = state.getDb()
        const row = retireIdentity(db, args.name, args.note)
        if (row.alreadyRetired) return `[OK] 「${row.name}」此前已停用（${row.retired_at}）。独热保留不回收。`
        return `[OK] 已停用「${row.name}」（${row.retired_at}）。名字独热保留，不可被再次注册。`
      }

      /* ── 总览 ── */
      if (action === 'status') {
        const up = await probe(cfg)
        let reg = '注册表不可用'
        let count = '0'
        try {
          const db = state.getDb()
          const rows = listIdentities(db)
          count = String(rows.length)
          const act = rows.filter(r => r.status === 'active').length
          reg = `${act} 在册 / ${rows.length - act} 停用`
        } catch (e) {
          reg = '打开失败：' + ((e && e.message) || e)
        }
        return [
          `[流变基建 v${PLUGIN_VERSION}｜契约 v${CONTRACT_VERSION}]`,
          `[注册表] ${reg}｜${cfg.dbPath}`,
          `[向量服务] ${up.ok ? `在线 ${cfg.embedUrl}` : `离线（${up.body}）`}${listeningPid(cfg.embedPort) ? `｜PID ${listeningPid(cfg.embedPort)}` : ''}`,
          `[过渡期说明] v0.1：向量服务所有权仍在 dsh-liubian-embed（加载自动带起+看门狗）；基建仅手动控制面，不重复看门狗。挂牌迁移后切换。`,
        ].join('\n')
      }

      /* ── 向量服务控制面（移植自 embed 工具，语义一致） ── */
      if (action === 'embed-stop') {
        const r = stopService(cfg)
        if (!r.ok) return `[错误] 关停失败（PID ${r.pid}）：${r.error}`
        return r.pid ? `[OK] 已关停向量服务（PID ${r.pid}）。注意：v0.1 过渡期 embed 插件的看门狗/ensure 在线检查会把它带回来——彻底关停应先停 embed 插件。` : '[OK] 端口上没有监听进程。'
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
          `[启动方式] 直起 exe ${cfg.serverExe}（无窗）`,
          `[所有者] v0.1 过渡期：dsh-liubian-embed（autoEnsure+看门狗）；本插件仅手动控制`,
          before.ok ? before.body : '',
        ].filter(Boolean).join('\n')
      }

      return `[错误] 未知 action：${action}（可用：register / verify / lookup / list / retire / status / embed-status / embed-ensure / embed-stop / embed-restart）`
    },
  })), TOOL_NAME)
}

/* ══ 入口 ══ */

export function apply(ctx, input = {}) {
  const cfg = resolveConfig(input)

  // 惰性开库：DB 打不开不拖垮插件挂载，注册动作时才报错
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
  }

  registerInfraTool(ctx, cfg, state)

  ctx.effect(() => {
    try { state._db?.close() } catch { /* 卸载时关闭尽力而为 */ }
  }, 'dsh-liubian-infra: 关闭注册表')

  ctx.logger?.info?.(
    `[dsh-liubian-infra] v${PLUGIN_VERSION} 已挂载：注册表 ${cfg.dbPath}（契约 v${CONTRACT_VERSION}）｜向量服务控制面就绪（过渡期手动）`,
  )
}

/** 纯函数/可测缝（标准 §8：桩测不依赖宿主） */
export const __test = {
  resolveConfig,
  configFile,
  normalizeName,
  deriveHash,
  computeShortIds,
  recomputeShortIds,
  openDb,
  registerIdentity,
  verifyName,
  lookupIdentity,
  listIdentities,
  retireIdentity,
  probe,
  launch,
  ensureReady,
  listeningPid,
  stopService,
}
