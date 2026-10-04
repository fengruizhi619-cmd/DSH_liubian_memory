#!/usr/bin/env node
/**
 * 改名预演（真实数据副本）——重启前的最强证据：
 * 把**生产 registry.db 连同 WAL/SHM** 复制到临时目录，用新版实现对副本跑一次真实改名
 * （顺带验证 v0.3.0 的 DDL 迁移），全程生产库零改动（前后哈希比对自证）。
 *
 * 跑法：node.cmd _dev/rename_drill.mjs [源名] [新名]
 * 默认：源名 = 玉簪，新名 = 玉簪Pro（预演完即丢弃副本）
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb, renameIdentity, lookupIdentity, listIdentities, listBindings } from '../lib/impl.mjs'

const PROD = process.env.INFRA_DB || 'C:/Users/Feng/.dsh/liubian-infra/registry.db'
// 2026-10-05 教训：默认源名**不能写死某个具体身份**——身份会按管理员裁定退役（玉簪 10-01
// retired 后本 drill 3 项红，全是"对 retired 身份正确拒绝"的正确行为）。默认改为
// 「现取一个 active 且有绑定的身份」，显式参数仍可覆盖。
function pickDefaultSource(db) {
  const binds = listBindings(db)
  const idents = listIdentities(db)
  const hit = binds.find(b => idents.find(i => i.name === b.name && i.status === 'active'))
  return hit ? hit.name : null
}
const argFrom = process.argv[2]

const sha = f => createHash('sha256').update(readFileSync(f)).digest('hex')
const prodBefore = sha(PROD)

const dir = mkdtempSync(join(tmpdir(), 'infra-drill-'))
const dbPath = join(dir, 'registry.db')
for (const suffix of ['', '-wal', '-shm']) {
  const src = PROD + suffix
  if (existsSync(src)) copyFileSync(src, dbPath + suffix)
}
if (dbPath === PROD) throw new Error('安全阀：副本路径不得等于生产路径')

const db = openDb(dbPath)
// 挑默认源名在**副本**上做——绝不为了挑名去开生产库的可写连接（WAL/检查点可能动生产文件）。
const FROM = argFrom || pickDefaultSource(db)
const TO = process.argv[3] || (FROM ? FROM + 'Pro' : undefined)
if (!FROM || !TO) throw new Error('找不到可预演的 active 身份，且未给显式参数：rename_drill.mjs [源名] [新名]')

let pass = 0, fail = 0
const t = (label, fn) => {
  try { const extra = fn(); pass++; console.log(`  ✓ ${label}${extra ? '｜' + extra : ''}`) }
  catch (e) { fail++; console.log(`  ✗ ${label}\n      ${e.message}`) }
}
const eq = (a, b, msg = '') => { if (a !== b) throw new Error(`期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)} ${msg}`) }

console.log(`源库（副本）: ${dbPath}`)
console.log(`预演改名: ${FROM} → ${TO}\n`)

t('v0.3.0 DDL 迁移：两张新表已在（对既有库幂等）', () => {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name)
  if (!names.includes('name_aliases')) throw new Error('缺 name_aliases')
  if (!names.includes('renames')) throw new Error('缺 renames')
  return names.join(', ')
})

const before = listIdentities(db)
const target = before.find(r => r.name === FROM)
const bindBefore = listBindings(db).find(b => b.name === FROM)

t(`真实数据已读出：${before.length} 个身份、${listBindings(db).length} 对绑定`, () => {
  if (!target) throw new Error(`源名「${FROM}」不在真实注册表中`)
  return `${FROM} #${target.short_id}${bindBefore ? ` ↔ 会话 ${bindBefore.session_hash}` : '（无绑定）'}`
})

t('改名成功：hash / short_id / created_at / workspace 全不变', () => {
  const r = renameIdentity(db, FROM, TO, '基石', '预演（副本）')
  eq(r.name, TO)
  eq(r.hash, target.hash, 'hash 必须不变')
  eq(r.short_id, target.short_id, 'short_id 不变')
  eq(r.created_at, target.created_at, 'created_at 不变')
  eq(r.workspace || null, target.workspace || null, 'workspace 不变')
  const rev = db.prepare('SELECT COUNT(*) AS c FROM renames WHERE hash = ?').get(r.hash).c
  eq(rev, 1)
  return `账目 rev ${rev}｜同步绑定 ${r.bindingsMoved ?? 0} 条`
})

t('旧名回查：lookup 旧名 → 指向现名同一 hash', () => {
  const r = lookupIdentity(db, { name: FROM })
  eq(r.row, null)
  eq(r.alias.hash, target.hash)
  return `别名 ${r.alias.renamed_at}`
})

t('bindings 名字副本已同步为现名（防两处真相）', () => {
  if (!bindBefore) return '（该身份无绑定，跳过）'
  const b = listBindings(db).find(x => x.session_hash === bindBefore.session_hash)
  eq(b.name, TO)
  return `${bindBefore.session_hash} → ${b.name}`
})

t('其余身份零扰动（逐行比对）', () => {
  const now = listIdentities(db)
  eq(now.length, before.length, '身份数不变')
  for (const old of before) {
    if (old.name === FROM) continue
    const cur = now.find(x => x.hash === old.hash)
    if (!cur) throw new Error(`身份 ${old.name} 丢失`)
    eq(cur.name, old.name); eq(cur.status, old.status); eq(cur.short_id, old.short_id)
  }
  return `${before.length - 1} 个身份逐字段一致`
})

t('改回原名（幂等方向）也可行', () => {
  const back = renameIdentity(db, TO, FROM, '基石', '预演回滚')
  eq(back.name, FROM)
  eq(back.hash, target.hash)
  eq(db.prepare('SELECT COUNT(*) AS c FROM name_aliases WHERE name_key = ?').get(FROM).c, 0, '改回后该名不再算别名')
})

db.close()
try { rmSync(dir, { recursive: true, force: true }) } catch {}

const prodAfter = sha(PROD)
t('生产库零改动（前后 SHA-256 一致）', () => {
  eq(prodAfter, prodBefore)
  return `${prodBefore.slice(0, 16)}…`
})

console.log(`\n预演结果：${pass} 过 / ${fail} 败`)
process.exitCode = fail ? 1 : 0
