#!/usr/bin/env node
/**
 * 跨插件服务契约探针（v0.3.2 起常驻）——被炉 account 工具 ↔ liubianInfra 的接口回归网。
 *
 * 为什么需要它（桩测盖不住的那一半）：
 *   `identities.hash` 由**名字**派生，`bindings.session_hash` 由**会话**派生——**两种不同源的派生**。
 *   被炉 account 工具传的 `{ hash: mine.id }` 是后者。桩测用合成数据、两种派生都由测试自己造，
 *   天然"同源"；只有**真实注册库**才暴露这个接缝（2026-10-01 实测：13 条绑定同源 0 条，
 *   改前 `svc.rename({hash:'16dd4280'})` 报「未找到身份」，重启验收必炸）。
 *
 * 安全：把生产 registry.db **连同 -wal/-shm** 复制到临时目录，全程只动副本，末尾自证生产库 SHA-256 未变。
 * 跑法：node.cmd _dev/svc_contract_probe.mjs   （全过 exit 0）
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb, listIdentities, listBindings, buildInfraService } from '../lib/impl.mjs'

const PROD = process.env.INFRA_DB || 'C:/Users/Feng/.dsh/liubian-infra/registry.db'
const sha = f => createHash('sha256').update(readFileSync(f)).digest('hex')
const prodBefore = sha(PROD)

const dir = mkdtempSync(join(tmpdir(), 'infra-svc-probe-'))
const dbPath = join(dir, 'registry.db')
for (const suffix of ['', '-wal', '-shm']) {
  const src = PROD + suffix
  if (existsSync(src)) copyFileSync(src, dbPath + suffix)
}
if (dbPath === PROD) throw new Error('安全阀：副本路径不得等于生产路径')

let pass = 0, fail = 0
const t = async (label, fn) => {
  try { const extra = await fn(); pass++; console.log(`  ✓ ${label}${extra ? '｜' + extra : ''}`) }
  catch (e) { fail++; console.log(`  ✗ ${label}\n      ${e.message}`) }
}
const eq = (a, b, msg = '') => { if (a !== b) throw new Error(`期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)} ${msg}`) }

const db = openDb(dbPath)
const svc = buildInfraService({ getDb: () => db })
const byName = n => listIdentities(db).find(i => i.name === n)

console.log(`源库（副本）: ${dbPath}\n`)

await t('真实库形状：会话哈希与身份哈希**不同源**（这是本探针存在的原因）', () => {
  const binds = listBindings(db), idents = listIdentities(db)
  const same = binds.filter(b => (idents.find(i => i.name === b.name)?.hash || '').startsWith(b.session_hash)).length
  return `${binds.length} 对绑定，同源 ${same} 对`
})

const probe = listBindings(db)[0]
if (!probe) throw new Error('真实库里没有任何绑定，无法探针')
const original = probe.name
const originalHash = byName(original).hash
console.log(`探针对象：${original}（会话 ${probe.session_hash}）\n`)

// ① 消费方真实形态：hash = 会话哈希（= 被炉成员 ID）
await t('① 会话哈希路径：svc.rename({ hash: <成员ID> }) → ok + 绑定副本同步（改前此处报"未找到身份"）', async () => {
  const r = await svc.rename({ hash: probe.session_hash, newName: original + 'Probe', actor: '契约探针', note: '副本' })
  eq(r.ok, true, JSON.stringify(r))
  eq(r.hash, originalHash, 'hash 必须不变')
  eq(r.bindingsMoved, 1, '绑定名字副本应同步')
  return `${original} → ${r.name}｜bindingMoved=${r.bindingsMoved}`
})

// ② 名字路径（ref）
await t('② 名字路径：svc.rename({ ref: <当前名> }) → ok', async () => {
  const r = await svc.rename({ ref: original + 'Probe', newName: original + 'Probe2', actor: '契约探针', note: '副本' })
  eq(r.ok, true, JSON.stringify(r))
  return `→ ${r.name}`
})

// ③ 身份 hash 全值 → 幂等（同值改名不算账目）
await t('③ 身份 hash 全值路径：svc.rename({ hash: <identities.hash> }) 同名 → ok + noop', async () => {
  const r = await svc.rename({ hash: originalHash, newName: original + 'Probe2', actor: '契约探针', note: '副本' })
  eq(r.ok, true, JSON.stringify(r))
  eq(r.noop, true, '同值改名应幂等')
  return 'noop=true'
})

// ④ 反向对照：未绑定的会话哈希 → 明确报错，不静默定位到别处
await t('④ 反向对照：未绑定的会话哈希 → ok:false（不静默命中他人）', async () => {
  const r = await svc.rename({ hash: 'deadbeef', newName: '谁' })
  eq(r.ok, false)
  if (!/未找到身份/.test(String(r.error))) throw new Error('错误话术应含「未找到身份」：' + r.error)
  return String(r.error).slice(0, 30)
})

// ⑤ unbind 形态（会话哈希即 bindings 主键，与 rename 的键**不是**同一个）
await t('⑤ svc.unbind({ sessionHash: <成员ID> }) → ok（退房不解绑，仅删账号用）', async () => {
  const r = await svc.unbind({ sessionHash: probe.session_hash })
  eq(r.ok, true, JSON.stringify(r))
  eq(r.removed, 1)
  return `removed=${r.removed}`
})

// 收尾：改回原名（同样走服务，验证双向）
await t('⑥ 收尾复原：改回原名 + 名字可再被解析', async () => {
  const r = await svc.rename({ ref: original + 'Probe2', newName: original, actor: '契约探针', note: '复原' })
  eq(r.ok, true, JSON.stringify(r))
  eq(byName(original).hash, originalHash)
  return `${original} 已复原`
})

db.close()
try { rmSync(dir, { recursive: true, force: true }) } catch {}

await t('⑦ 生产库零改动（前后 SHA-256 一致）', () => {
  eq(sha(PROD), prodBefore)
  return `${prodBefore.slice(0, 16)}…`
})

console.log(`\n契约探针结果：${pass} 过 / ${fail} 败`)
process.exitCode = fail ? 1 : 0
