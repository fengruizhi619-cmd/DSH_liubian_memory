/**
 * dsh-liubian-infra 纯函数/真库桩测（家族标准 §8 第一层：不依赖宿主可跑）
 * 跑法：node.cmd _dev/stub_test.mjs  （临时 DB，不碰生产注册表）
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  normalizeName, deriveHash, computeShortIds, recomputeShortIds, sessionHashFor,
  openDb, registerIdentity, verifyName, lookupIdentity, listIdentities, retireIdentity, renameIdentity,
  bindSession, unbindSession, bindingFor, listBindings,
  attributeWorkspace, noteSession, seenWorkspaceFor,
  callerSessionOf,
  resolveConfig,
} from '../lib/impl.mjs'

let pass = 0, fail = 0
function t(label, fn) {
  try { fn(); pass++; console.log(`  ✓ ${label}`) }
  catch (e) { fail++; console.log(`  ✗ ${label}\n      ${e.message}`) }
}
function eq(a, b, msg = '') { if (a !== b) throw new Error(`期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)} ${msg}`) }
function throws(fn, frag) {
  try { fn() } catch (e) { if (!String(e.message).includes(frag)) throw new Error(`错误消息缺「${frag}」：${e.message}`); return }
  throw new Error(`应当抛出含「${frag}」的错误，但没有抛`)
}

console.log('== normalizeName ==')
t('合法中文名', () => eq(normalizeName('基石').ok, true))
t('去首尾空白', () => eq(normalizeName('  基石  ').name, '基石'))
t('空名拒绝', () => eq(normalizeName('   ').ok, false))
t('超长拒绝', () => eq(normalizeName('x'.repeat(65)).ok, false))
t('@开头拒绝', () => eq(normalizeName('@基石').ok, false))
t('#开头拒绝', () => eq(normalizeName('#基石').ok, false))
t('控制字符拒绝', () => eq(normalizeName('a\u0000b').ok, false))
t('大小写不敏感 key', () => eq(normalizeName('Alice').key, 'alice'))
t('NFC 规范化', () => eq(normalizeName('e\u0301').name, 'é'))

console.log('== deriveHash ==')
t('SHA-256/UTF-8 配方', () => eq(deriveHash('基石'), createHash('sha256').update('基石', 'utf8').digest('hex')))
t('全长 64 hex 小写', () => eq(/^[0-9a-f]{64}$/.test(deriveHash('基石')), true))
t('同名同 hash、异名异 hash', () => {
  eq(deriveHash('基石'), deriveHash('基石'))
  if (deriveHash('基石') === deriveHash('博物君')) throw new Error('不同名不应同 hash')
})
t('NFC 等价形式同 hash', () => eq(deriveHash(normalizeName('e\u0301').name), deriveHash('é')))

console.log('== computeShortIds（git 式最短唯一前缀） ==')
t('无碰撞 → 恒 8 位', () => {
  const m = computeShortIds(['aaaaaaaa' + '0'.repeat(56), 'bbbbbbbb' + '0'.repeat(56)])
  eq(m['aaaaaaaa' + '0'.repeat(56)].length, 8)
})
t('前 8 位碰撞 → 双双扩位到 9', () => {
  const h1 = 'abcdef01' + '0'.repeat(56), h2 = 'abcdef01' + 'f'.repeat(56)
  const m = computeShortIds([h1, h2])
  eq(m[h1], h1.slice(0, 9), 'h1 扩到 9')
  eq(m[h2], h2.slice(0, 9), 'h2 扩到 9')
})
t('空集合/单条 → 8 位', () => {
  eq(computeShortIds([])['x'], undefined)
  eq(computeShortIds(['ab12cd34' + '9'.repeat(56) ])['ab12cd34' + '9'.repeat(56)].length, 8)
})

console.log('== 注册表（临时真库） ==')
const dir = mkdtempSync(join(tmpdir(), 'infra-stub-'))
const dbPath = join(dir, 'registry.db')
const db = openDb(dbPath)

t('注册返回完整身份', () => {
  const row = registerIdentity(db, '基石', '流变基建维护者')
  eq(row.name, '基石'); eq(row.status, 'active')
  eq(row.hash, deriveHash('基石'))
  eq(row.short_id.length, 8)
  if (!row.created_at) throw new Error('缺 created_at')
})
t('重复注册拒绝（独热）', () => throws(() => registerIdentity(db, '基石'), '已被注册'))
t('大小写变体同 key 拒绝', () => {
  registerIdentity(db, 'Jasmine', '大小写用例')
  throws(() => registerIdentity(db, 'jasmine'), '已被注册')
})
t('verify 未占用 → available', () => {
  const r = verifyName(db, '博物君')
  eq(r.available, true); if (!r.hash) throw new Error('应给出将来的 hash')
})
t('verify 已占用 → 拒绝理由', () => {
  const r = verifyName(db, '基石')
  eq(r.available, false); eq(r.status, 'active')
})
t('lookup 按名', () => eq(lookupIdentity(db, { name: '基石' }).row.hash, deriveHash('基石')))
t('lookup 按短 ID', () => {
  const short = lookupIdentity(db, { name: '基石' }).row.short_id
  eq(lookupIdentity(db, { id: short }).row.name, '基石')
})
t('lookup 按全 hash', () => eq(lookupIdentity(db, { id: deriveHash('基石') }).row.name, '基石'))
t('lookup 未命中', () => eq(lookupIdentity(db, { id: 'deadbeef' + '0'.repeat(56) }).row, null))
t('lookup 非法 id 拒绝', () => throws(() => lookupIdentity(db, { id: 'xyz' }), '十六进制'))
t('构造 8 位前缀碰撞 → 扩位后 lookup 不歧义', () => {
  // 直接插两条手工 hash（绕过注册派生），再触发重算
  db.prepare('INSERT INTO identities (name, name_key, hash, short_id, status, created_at) VALUES (?,?,?,?,?,?)')
    .run('碰撞甲', '碰撞甲', 'abcdef01' + '0'.repeat(56), 'abcdef01', 'active', '2026-01-01T00:00:00Z')
  db.prepare('INSERT INTO identities (name, name_key, hash, short_id, status, created_at) VALUES (?,?,?,?,?,?)')
    .run('碰撞乙', '碰撞乙', 'abcdef01' + 'f'.repeat(56), 'abcdef01', 'active', '2026-01-01T00:01:00Z')
  recomputeShortIds(db)
  const rows = listIdentities(db)
  const jia = rows.find(r => r.name === '碰撞甲'), yi = rows.find(r => r.name === '碰撞乙')
  if (jia.short_id.length < 9 || yi.short_id.length < 9) throw new Error(`应扩位到 ≥9：${jia.short_id} / ${yi.short_id}`)
  eq(lookupIdentity(db, { id: jia.short_id }).row.name, '碰撞甲')
})
t('retire 停用但独热保留', () => {
  registerIdentity(db, '临时测试员', '桩测用')
  const r = retireIdentity(db, '临时测试员', '桩测结束')
  eq(r.status, 'retired')
  throws(() => registerIdentity(db, '临时测试员'), '独热保留')
})
t('retire 幂等', () => {
  const r = retireIdentity(db, '临时测试员')
  eq(r.alreadyRetired, true)
})
t('未注册名 retire 拒绝', () => throws(() => retireIdentity(db, '不存在的人'), '不在册'))

console.log('== sessionHashFor（与被炉 idFor 同源） ==')
t('配方 = sha256(sessionId) 前 8', () => eq(sessionHashFor('test-session'), createHash('sha256').update('test-session').digest('hex').slice(0, 8)))
t('同会话同哈希', () => eq(sessionHashFor('abc'), sessionHashFor('abc')))

console.log('== 会话↔身份独热绑定（临时真库） ==')
registerIdentity(db, '绑定甲', '绑定测试')
registerIdentity(db, '绑定乙', '绑定测试')
t('绑定成功', () => {
  const r = bindSession(db, 'aaaa0000', '绑定甲', '桩测')
  eq(r.name, '绑定甲'); eq(r.session_hash, 'aaaa0000')
})
t('同会话同名幂等', () => {
  const r = bindSession(db, 'aaaa0000', '绑定甲')
  eq(r.already, true)
})
t('同会话改名 → 拒绝（唯一绑定）', () => throws(() => bindSession(db, 'aaaa0000', '绑定乙'), '唯一绑定'))
t('同名字绑第二会话 → 拒绝（独热配对）', () => throws(() => bindSession(db, 'bbbb0000', '绑定甲'), '独热配对'))
t('未注册名绑定 → 拒绝', () => throws(() => bindSession(db, 'cccc0000', '没注册的人'), '尚未注册'))
t('bindingFor 命中带短ID', () => {
  const r = bindingFor(db, 'aaaa0000')
  eq(r.name, '绑定甲'); if (!r.short_id) throw new Error('应带身份短 ID')
})
t('bindingFor 未命中 → null', () => eq(bindingFor(db, 'ffffff00'), null))
t('unbind 按 session 释放', () => {
  const r = unbindSession(db, { session: 'aaaa0000' })
  eq(r.released.name, '绑定甲')
  eq(bindingFor(db, 'aaaa0000'), null)
})
t('释放后可重绑（旧会话终结场景）', () => {
  const r = bindSession(db, 'bbbb0000', '绑定甲', '重绑')
  eq(r.name, '绑定甲')
  unbindSession(db, { session: 'bbbb0000' })
})
t('unbind 按 name 释放', () => {
  bindSession(db, 'dddd0000', '绑定乙')
  const r = unbindSession(db, { name: '绑定乙' })
  eq(r.released.session_hash, 'dddd0000')
})
t('非法会话哈希拒绝', () => throws(() => bindSession(db, 'xyz', '绑定甲'), '8 位十六进制'))
t('bindings 计数', () => {
  bindSession(db, 'eeee0000', '绑定甲')
  if (listBindings(db).length < 1) throw new Error('应有绑定行')
  unbindSession(db, { name: '绑定甲' })
})

console.log('== 工作区归属（v0.2.1 管理员钉） ==')
t('注册带归属 → 落库', () => {
  const row = registerIdentity(db, '归属测试员', '归属测试', '中枢')
  eq(row.workspace, '中枢')
})
t('attribute 修正归属', () => {
  const row = attributeWorkspace(db, '归属测试员', '工作组')
  eq(row.workspace, '工作组')
})
t('verify 输出带归属', () => {
  const r = verifyName(db, '归属测试员')
  eq(r.workspace, '工作组')
})
t('会话登记 → seen 工作区', () => {
  noteSession(db, 'aa000000', '中枢')
  eq(seenWorkspaceFor(db, 'aa000000'), '中枢')
})
t('bind 归属不符 → 拒绝', () => {
  noteSession(db, 'bb000000', '银砂纪年')
  throws(() => bindSession(db, 'bb000000', '归属测试员'), '归属不符')
})
t('bind 归属一致 → 通过', () => {
  noteSession(db, 'cc000000', '工作组')
  const r = bindSession(db, 'cc000000', '归属测试员')
  eq(r.name, '归属测试员')
  unbindSession(db, { session: 'cc000000' })
})
t('会话未见登记（无工作区）→ 不拦（无法判定时不误伤）', () => {
  const r = bindSession(db, 'dd000000', '归属测试员')
  eq(r.name, '归属测试员')
})
t('身份无归属 → 不拦', () => {
  registerIdentity(db, '无归属者', '未登记归属')
  noteSession(db, 'ee000000', '随便哪里')
  const r = bindSession(db, 'ee000000', '无归属者')
  eq(r.name, '无归属者')
})
t('attribute 空工作区拒绝', () => throws(() => attributeWorkspace(db, '归属测试员', '  '), '不能为空'))

console.log('== callerSessionOf（注册主动归属的数据源） ==')
t('正常 exec → 会话 id + cwd', () => {
  const c = callerSessionOf({ agent: { session: { id: 'sess-1', header: { cwd: 'E:/DSH_data/中枢' } } } })
  eq(c.id, 'sess-1'); eq(c.cwd, 'E:/DSH_data/中枢')
})
t('无会话 → null（面板调用）', () => eq(callerSessionOf({}), null))
t('exec 缺失 → null', () => eq(callerSessionOf(undefined), null))
t('与 sessionHashFor 闭环：caller.id 可直接派生会话哈希', () => {
  const c = callerSessionOf({ agent: { session: { id: 'sess-1', header: {} } } })
  eq(sessionHashFor(c.id), sessionHashFor('sess-1'))
})

console.log('== resolveConfig ==')
t('默认值 + input 覆盖 + 字符串布尔收敛', () => {
  const c = resolveConfig({ probeTimeoutMs: '5000', embedPort: '' })
  eq(c.probeTimeoutMs, 5000)
  eq(c.embedPort, 8082, '空串不覆盖')
  if (typeof c.dbPath !== 'string' || !c.dbPath.includes('registry.db')) throw new Error('dbPath 默认值异常')
})

console.log('== rename（v0.3.0：hash 不变 + 别名 + 改名账目） ==')
t('改名成功：hash/short_id/注册时间不变，只换名', () => {
  const before = lookupIdentity(db, { name: '基石' }).row
  const after = renameIdentity(db, '基石', '基石Pro', '基石', '契约 v1.1 改名用例')
  eq(after.name, '基石Pro')
  eq(after.hash, before.hash, 'hash 必须不变')
  eq(after.short_id, before.short_id, 'short_id 不变')
  eq(after.created_at, before.created_at, '注册时间不变')
  eq(db.prepare('SELECT COUNT(*) AS c FROM renames WHERE hash = ?').get(after.hash).c, 1)
})
t('新名 lookup 命中；旧名回查 → 别名指向同一 hash', () => {
  const h = deriveHash('基石')
  eq(lookupIdentity(db, { name: '基石Pro' }).row.hash, h)
  const r = lookupIdentity(db, { name: '基石' })
  eq(r.row, null)
  eq(r.alias.hash, h)
})
t('verify 旧名 → 判为历史名（不可注册）', () => {
  const r = verifyName(db, '基石')
  eq(r.available, false)
  eq(r.status, 'alias')
  eq(r.aliasOf, '基石Pro')
})
t('重复注册旧名被拒（改名不改身份）', () => throws(() => registerIdentity(db, '基石'), '历史名'))
t('改回自己的历史名 → 允许，且该名不再算别名', () => {
  const back = renameIdentity(db, '基石Pro', '基石', '基石')
  eq(back.name, '基石')
  eq(back.hash, deriveHash('基石'))
  eq(lookupIdentity(db, { name: '基石' }).row.hash, back.hash)
  eq(db.prepare('SELECT COUNT(*) AS c FROM name_aliases WHERE name_key = ?').get('基石').c, 0)
})
t('撞他人名 → 拒且零写入（身份表逐行比对）', () => {
  const snap = () => listIdentities(db).map(r => `${r.name}|${r.hash}|${r.status}`).join(',')
  const before = snap()
  throws(() => renameIdentity(db, '基石', 'Jasmine'), '已被占用')
  eq(snap(), before, '拒绝时必须零写入')
})
t('新名为空 / 超长 → 拒', () => {
  throws(() => renameIdentity(db, '基石', '   '), '新名无效')
  throws(() => renameIdentity(db, '基石', 'x'.repeat(65)), '新名无效')
})
t('同名改名 → 幂等 noop，不新增账目', () => {
  const n0 = db.prepare('SELECT COUNT(*) AS c FROM renames').get().c
  eq(renameIdentity(db, '基石', '基石').noop, true)
  eq(db.prepare('SELECT COUNT(*) AS c FROM renames').get().c, n0)
})
t('停用身份不可改名', () => {
  registerIdentity(db, '待停用', null)
  retireIdentity(db, '待停用', '用例')
  throws(() => renameIdentity(db, '待停用', '待停用2'), '停用身份不可改名')
})
t('占用他人历史名作新名 → 拒', () => {
  registerIdentity(db, '甲', null)
  registerIdentity(db, '乙', null)
  renameIdentity(db, '甲', '甲Pro', null)
  throws(() => renameIdentity(db, '乙', '甲'), '历史名')
})
t('不存在的名字 → 拒', () => throws(() => renameIdentity(db, '不存在的人', 'X'), '不在册'))
t('改名不影响会话绑定（独热配对仍在，只是显示新名）', () => {
  const sh = 'a1b2c3d4'
  bindSession(db, sh, 'Jasmine')
  renameIdentity(db, 'Jasmine', 'JasminePro', '基石')
  eq(bindingFor(db, sh).name, 'JasminePro')
  eq(lookupIdentity(db, { name: 'JasminePro' }).row.hash, deriveHash('Jasmine'))
})

db.close()
try { rmSync(dir, { recursive: true, force: true }) } catch {}

console.log(`\n桩测结果：${pass} 过 / ${fail} 败`)
process.exitCode = fail ? 1 : 0
