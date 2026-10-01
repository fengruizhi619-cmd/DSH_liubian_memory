/**
 * B：按 DSH 会话日志重建便签缺口（probe / dry-run / apply）。
 *
 * 背景：池曾因 🔴-8（实例生来 disposed）从 14:44 起停止落盘；本会话 14:39→现在的轮次只在内存里封存过，
 * 随实例消亡。本脚本从 `session.v4.jsonl.zstd` 重放事件，用**与线上同一套判据**重建这些轮次，
 * 再走生产聚合路径（maybeAggregate：LLM 生成 → 向量 → 判重 → 赛马 → 原子落盘）把它们变成便签。
 *
 * 口径与线上一致：
 *   - 人类消息：user/message 且 source.kind ∈ {undefined, null, 'user'}（plugin: 前缀与 runtime-context 等注入不算）
 *   - 助手文本：assistant/message 的 message.content 里 type==='text' 的块（reasoning 不计）
 *   - 窗口：R 个人类轮一窗；非人类内容的轮不入窗
 *   - 缺口起点：池内 sealed 的最大轮号（已覆盖到此）
 *
 * 安全：apply 前把池文件复制成 .bak-rebuild-<ts>；每步只调生产函数，不手改 JSON 结构。
 *
 * 用法：
 *   node _dev/rebuild-notes-from-session.mjs probe   [sessionId]
 *   node _dev/rebuild-notes-from-session.mjs dry-run [sessionId]
 *   node _dev/rebuild-notes-from-session.mjs apply   [sessionId]
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

const MODE = process.argv[2] || 'probe'
const SESSION_ID = process.argv[3] || process.env.DSH_SESSION_ID || ''
const IMPL_PATH = 'E:/DSH_data/流变系统/dsh-liubian-notes/lib/impl.mjs'
const log = (s) => console.log(s)

/* ── 多帧 zstd 扫描（照抄 dsh-session-persistence-jsonl 的 scanZstdFrames 语义） ── */
const ZSTD_MAGIC = 4247762216
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('invalid frame magic at byte ' + offset)
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset); offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames }
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) { if (buffer.length - offset < 4) return { frames }; offset += 4 }
    frames.push({ start, end: offset })
  }
  return { frames }
}

function sessionLogPath(sessionId) {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
  const base = path.join(home, 'sessions')
  for (const proj of fs.readdirSync(base)) {
    const dir = path.join(base, proj, sessionId)
    if (fs.existsSync(dir)) {
      const f = fs.readdirSync(dir).find(x => x.startsWith('session.v4.jsonl'))
      if (f) return path.join(dir, f)
    }
  }
  throw new Error('找不到会话日志: ' + sessionId)
}

function readSessionObjects(sessionId) {
  const file = sessionLogPath(sessionId)
  const bytes = fs.readFileSync(file)
  const { frames } = scanZstdFrames(bytes)
  const objs = []
  for (const fr of frames) {
    const text = zlib.zstdDecompressSync(bytes.subarray(fr.start, fr.end)).toString('utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { objs.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
    }
  }
  return { file, frames: frames.length, objs }
}

/* ── 与线上同口径的重放：还原每轮 {turn, human[], assistant[], tools[]} ── */
const messageText = (message) => {
  if (!message || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
}
const isHumanMessage = (message) => {
  if (!message || message.role !== 'user') return false
  const kind = message.source?.kind
  return kind === undefined || kind === null || kind === 'user'
}

function replayTurns(objs) {
  const turns = new Map()
  const ensure = (n) => {
    const key = Number(n) || 0
    if (!turns.has(key)) turns.set(key, { turn: key, human: [], assistant: [], tools: [] })
    return turns.get(key)
  }
  let current = 0
  for (const o of objs) {
    const d = o.data || {}
    if (o.type === 'turn/start') { current = Number(d.turn) || current; ensure(current) }
    else if (o.type === 'user/message') {
      if (isHumanMessage(d)) { const t = messageText(d).trim(); if (t) ensure(current).human.push(t) }
    } else if (o.type === 'assistant/message') {
      const t = messageText(d.message).trim()
      if (t) ensure(d.turn ?? current).assistant.push(t)
    } else if (o.type === 'tool/call') {
      if (d.name) ensure(d.turn ?? current).tools.push(String(d.name))
    }
  }
  return [...turns.values()].sort((a, b) => a.turn - b.turn)
}

/* ── 主流程 ── */
const { file, frames, objs } = readSessionObjects(SESSION_ID)
const turns = replayTurns(objs)
const humanTurns = turns.filter(t => t.human.length > 0)
log('会话日志: ' + file)
log('zstd 帧 ' + frames + '｜事件 ' + objs.length + '｜轮 ' + turns.length + '｜含人类内容的轮 ' + humanTurns.length)
log('人类轮号: ' + humanTurns.map(t => t.turn).join(','))

if (MODE === 'probe') process.exit(0)

const url = pathToFileURL(IMPL_PATH).href + '?t=' + Date.now()
const impl = await import(url)
const T = impl.__test
const cfg = T.resolveConfig({})
const key = T.sessionKeyFor(SESSION_ID)
const pool = T.loadPool(key, SESSION_ID)
const poolFile = path.join(T.notesDir(), key + '.json')

const sealedTurns = (pool.sealed || []).map(s => Number(s.turn) || 0)
const T0 = sealedTurns.length ? Math.max(...sealedTurns) : 0
const gap = humanTurns.filter(t => t.turn > T0)
log('池: 便签 ' + (pool.notes || []).length + ' 篇｜sealed ' + (pool.sealed || []).length + ' 轮（最大轮号 ' + T0 + '）')
log('缺口（轮号 > ' + T0 + ' 且含人类内容）: ' + gap.length + ' 轮 → ' + gap.map(t => t.turn).join(','))
log('按 R=' + cfg.aggregateRounds + ' 计：可聚合 ' + Math.floor(((pool.sealed || []).filter(s => (s.human || []).length).length + gap.length) / cfg.aggregateRounds) + ' 窗')
for (const t of gap) log('  turn ' + t.turn + '  human=' + t.human.length + ' assistant=' + t.assistant.length + '  首句=' + String(t.human[0] || '').slice(0, 46).replace(/\s+/g, ' '))

if (MODE === 'dry-run') process.exit(0)

/* apply：先备份，再①排空已有 sealed ②分块补入缺口轮 ③再排空 */
const backup = poolFile + '.bak-rebuild-' + Date.now()
fs.copyFileSync(poolFile, backup)
log('已备份池文件 → ' + path.basename(backup))
const logger = { info: (s) => log('    ' + s), warn: (s) => log('    ⚠ ' + s) }
const drain = async (label) => {
  let total = 0
  for (let i = 0; i < 12; i++) {
    const made = await impl.maybeAggregate(pool, cfg, Number(pool.lastTurn) || 0, logger)
    if (!made) break
    total += made
  }
  log(label + '：新增 ' + total + ' 篇（现有 ' + (pool.notes || []).length + ' 篇，sealed 剩 ' + (pool.sealed || []).length + '）')
  return total
}
let madeAll = await drain('① 排空原有 sealed')
/* 分块补入（sealed 上限 16，避免被 cap 丢掉最旧轮） */
let queue = gap.slice()
while (queue.length) {
  const room = Math.max(1, 16 - (pool.sealed || []).length)
  const chunk = queue.splice(0, room)
  for (const t of chunk) { pool.sealed.push(t); T.bumpStats(pool, t) }
  log('② 补入 ' + chunk.length + ' 轮（' + chunk[0].turn + '..' + chunk[chunk.length - 1].turn + '）→ sealed ' + pool.sealed.length)
  madeAll += await drain('② 聚合')
}
pool.lastTurn = humanTurns.length
madeAll += await drain('③ 收尾排空')
log('合计新增便签 ' + madeAll + ' 篇；池现有 ' + (pool.notes || []).length + ' 篇')
for (const n of (pool.notes || [])) log('  ' + n.id + ' [' + (n.gen || '?') + '] ' + String(n.head || '').slice(0, 52))
