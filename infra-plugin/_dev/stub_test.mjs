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
  resolveIdentityRef, buildInfraService,
  bindSession, unbindSession, bindingFor, listBindings,
  isForgotten, forgetSession, liftTombstone, changesSince,
  shouldRecoverLiveness,
  attributeWorkspace, noteSession, seenWorkspaceFor,
  callerSessionOf,
  resolveActor,
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

console.log('== 跨插件服务通道（reflect provide：被炉账号工具用） ==')
const ta = async (label, fn) => {
  try { const extra = await fn(); pass++; console.log(`  ✓ ${label}${extra ? '｜' + extra : ''}`) }
  catch (e) { fail++; console.log(`  ✗ ${label}\n      ${e.message}`) }
}
const svc = buildInfraService({ getDb: () => db })

await ta('resolveIdentityRef：全 hash / 唯一前缀 / 名字 三路都能定位', () => {
  const h = deriveHash('基石')
  eq(resolveIdentityRef(db, h).name, '基石')
  eq(resolveIdentityRef(db, h.slice(0, 10)).name, '基石')
  eq(resolveIdentityRef(db, '基石').name, '基石')
})
await ta('服务 rename（按 hash）→ ok + hash 不变 + 名字变 + 账目 +1', async () => {
  const h = deriveHash('基石')
  const n0 = db.prepare('SELECT COUNT(*) AS c FROM renames WHERE hash = ?').get(h).c
  const r = await svc.rename({ hash: h, newName: '基石Svc', actor: '拾遗', note: '服务通道用例' })
  eq(r.ok, true, JSON.stringify(r))
  eq(r.hash, h); eq(r.name, '基石Svc')
  eq(db.prepare('SELECT COUNT(*) AS c FROM renames WHERE hash = ?').get(h).c, n0 + 1, '账目应 +1')
  return `rev ${n0} → ${n0 + 1}｜bindingsMoved=${r.bindingsMoved}`
})
await ta('服务改名后：旧名可回查（别名指向同一 hash）', () => {
  eq(lookupIdentity(db, { name: '基石' }).alias.hash, deriveHash('基石'))
})
await ta('服务改名失败不抛，折成 {ok:false,error}', async () => {
  const r = await svc.rename({ hash: 'deadbeefdeadbeef', newName: '谁' })
  eq(r.ok, false)
  if (!r.error) throw new Error('应带 error 字段')
  return String(r.error).slice(0, 34)
})
await ta('服务改名撞名 → ok:false 且零写入', async () => {
  const snap = () => listIdentities(db).map(x => x.name + '|' + x.hash).join(',')
  const before = snap()
  const r = await svc.rename({ hash: deriveHash('基石'), newName: 'Jasmine' })
  eq(r.ok, false)
  eq(snap(), before, '拒绝时必须零写入')
})
await ta('会话哈希路径：resolveIdentityRef 按 bindings 反查（消费方传的 hash 是成员 ID）', () => {
  // 事实：identities.hash 由**名字**派生、bindings.session_hash 由**会话**派生——两者不同源
  // （生产库实测：13 条绑定里同源 0 条）。被炉 account 工具的 `{ hash: mine.id }` 就是后者。
  const row = resolveIdentityRef(db, 'a1b2c3d4')
  eq(row.name, 'JasminePro')
  return `a1b2c3d4 → ${row.name} #${row.short_id}`
})
await ta('服务 rename（消费方真实形态：hash = 会话哈希）→ ok + 绑定副本同步', async () => {
  const r = await svc.rename({ hash: 'a1b2c3d4', newName: 'JasmineSvc', actor: '契约探针', note: '会话哈希路径' })
  eq(r.ok, true, JSON.stringify(r))
  eq(r.name, 'JasmineSvc')
  eq(r.bindingsMoved, 1, '绑定名字副本应同步')
})
await ta('反向对照：未绑定的会话哈希 → 明确报错，不静默定位到别处', () => {
  throws(() => resolveIdentityRef(db, 'deadbeef'), '未找到身份')
})
await ta('服务 unbind：删绑定（removed 1 → 二次 0 幂等）', async () => {
  const r1 = await svc.unbind({ sessionHash: 'a1b2c3d4' })
  eq(r1.ok, true); eq(r1.removed, 1)
  const r2 = await svc.unbind({ sessionHash: 'a1b2c3d4' })
  eq(r2.removed, 0)
})
await ta('服务 unbind 非法会话哈希 → ok:false 不抛', async () => {
  const r = await svc.unbind({ sessionHash: 'zzz' })
  eq(r.ok, false)
})
await ta('服务改回原名（收尾复原）', async () => {
  const r = await svc.rename({ hash: deriveHash('基石'), newName: '基石', actor: '基石' })
  eq(r.ok, true)
  eq(resolveIdentityRef(db, deriveHash('基石')).name, '基石')
})

console.log('== 删除与跨系统同步（v0.4.0：墓碑 + forgetSession + changes 游标） ==')
registerIdentity(db, '删除测试员', '删除用例')
bindSession(db, 'aaaa1111', '删除测试员', '删除用例')
noteSession(db, 'aaaa1111', '中枢')

await ta('forgetSession 默认只解绑不烧名字：绑没、登记清、墓碑在、名字仍 active', () => {
  const r = forgetSession(db, { sessionHash: 'aaaa1111', actor: '验收', reason: '用例' })
  eq(r.ok, true); eq(r.unbound, 1); eq(r.retired, false)
  eq(bindingFor(db, 'aaaa1111'), null, '绑定应已删')
  eq(db.prepare('SELECT COUNT(*) AS c FROM session_seen WHERE session_hash=?').get('aaaa1111').c, 0, '登记应已清')
  eq(isForgotten(db, 'aaaa1111'), true, '墓碑应在')
  eq(listIdentities(db).find(x => x.name === '删除测试员').status, 'active', '默认不得烧名字')
})
await ta('幂等：二次 forget → unbound 0 且不新增墓碑事件', () => {
  const n0 = db.prepare('SELECT COUNT(*) AS c FROM tombstones').get().c
  const r = forgetSession(db, { sessionHash: 'aaaa1111', actor: '验收' })
  eq(r.unbound, 0); eq(r.alreadyForgotten, true)
  eq(db.prepare('SELECT COUNT(*) AS c FROM tombstones').get().c, n0, '墓碑事件数不得增加')
})
await ta('验收第 11 条：热路径连调 noteSession 后墓碑仍在（不被擦掉）', () => {
  noteSession(db, 'aaaa1111', '中枢'); noteSession(db, 'aaaa1111', '中枢'); noteSession(db, 'aaaa1111', '中枢')
  eq(isForgotten(db, 'aaaa1111'), true)
  return '3 次 noteSession 后墓碑未丢'
})
await ta('changes 游标：能看见 forget 事件（按 id 增量）', () => {
  const c = changesSince(db, 0)
  const mine = c.tombstones.filter(t => t.session_hash === 'aaaa1111')
  eq(mine.length >= 1, true); eq(mine[0].op, 'forget')
  return `seq=${c.seq}｜identities=${c.identities.length}｜bindings=${c.bindings.length}`
})
await ta('liftTombstone：复活后 isForgotten=false，且 lift 事件按 id 增量可见（水位不漏）', () => {
  const before = changesSince(db, 0).seq
  const r = liftTombstone(db, { sessionHash: 'aaaa1111', actor: '验收' })
  eq(r.lifted, true)
  eq(isForgotten(db, 'aaaa1111'), false)
  const delta = changesSince(db, before).tombstones
  eq(delta.length, 1, '复活的 lift 事件必须能被 since=before 看见（一行一状态的写法会在这里漏）')
  eq(delta[0].op, 'lift')
  return `seq ${before} → ${changesSince(db, 0).seq}`
})
await ta('复活幂等：再 lift → lifted:false', () => {
  eq(liftTombstone(db, { sessionHash: 'aaaa1111' }).lifted, false)
})
await ta('retireName=true：显式烧名字（可读状态 + 不可再注册）', () => {
  bindSession(db, 'bbbb2222', '删除测试员', '再绑一次')
  const r = forgetSession(db, { sessionHash: 'bbbb2222', retireName: true, reason: '注销' })
  eq(r.retired, 'retired')
  eq(listIdentities(db).find(x => x.name === '删除测试员').status, 'retired')
  throws(() => registerIdentity(db, '删除测试员'), '已被注册')
})
await ta('反向对照：非法会话哈希 → 抛错且零写入', () => {
  const snap = () => db.prepare('SELECT COUNT(*) AS c FROM tombstones').get().c + '|' + listBindings(db).length
  const before = snap()
  throws(() => forgetSession(db, { sessionHash: 'zzz' }), '8 位十六进制')
  eq(snap(), before, '拒绝路径必须零写入')
})
await ta('服务面：svc.forgetSession + svc.changes（消费方调用形态）', async () => {
  const r = await svc.forgetSession({ sessionHash: 'cccc3333', actor: '被炉 account delete', retireName: false })
  eq(r.ok, true)
  const c = await svc.changes({ since: 0 })
  eq(c.ok, true); eq(Array.isArray(c.tombstones), true)
  return `changes: identities=${c.identities.length}｜tombstones=${c.tombstones.length}`
})

await ta('changes.forgotten 快照：查态不必再 since:0 拉全量事件流（水位坑的解法）', () => {
  const c = changesSince(db, 999999)          // 水位推到最后 → 事件增量为空
  eq(c.tombstones.length, 0, '增量应为空')
  eq(c.forgotten.includes('bbbb2222'), true, '但"当前墓碑态"快照必须仍列出它')
  eq(c.forgotten.includes('cccc3333'), true)
  eq(c.forgotten.includes('aaaa1111'), false, 'aaaa1111 已 lift，不该在墓碑态里')
  return `forgotten=${JSON.stringify(c.forgotten)}`
})
await ta('复活后从 forgotten 快照移除（唯一复活入口的后果）', () => {
  liftTombstone(db, { sessionHash: 'bbbb2222', actor: '管理员 revive' })
  eq(changesSince(db, 999999).forgotten.includes('bbbb2222'), false)
  eq(isForgotten(db, 'cccc3333'), true, '未复活的仍在墓碑态')
})
await ta('服务面 isForgotten 单点查询（消费方查态的省事路）', async () => {
  eq((await svc.isForgotten({ sessionHash: 'cccc3333' })).forgotten, true)
  eq((await svc.isForgotten({ sessionHash: 'bbbb2222' })).forgotten, false)
  eq((await svc.isForgotten({ sessionHash: 'zzz' })).ok, false, '非法哈希折成 ok:false 不抛')
})
await ta('lift 事件仍能被水位看见（查态与消费事件两条路互不干扰）', () => {
  const before = changesSince(db, 0).seq
  liftTombstone(db, { sessionHash: 'cccc3333', actor: '管理员 revive' })
  const delta = changesSince(db, before).tombstones
  eq(delta.length, 1); eq(delta[0].op, 'lift')
  eq(changesSince(db, 999999).forgotten.includes('cccc3333'), false)
})

console.log('== 存活恢复判据（纯函数：服务崩了该不该自动拉起） ==')
t('探活失败 + 无进程 + 未显式停 + 自动拉起开 → 恢复', () =>
  eq(shouldRecoverLiveness({ probeOk: false, pids: [], explicitStop: false, autoEnsureOnLoad: true }), true))
t('探活成功 → 不动作', () =>
  eq(shouldRecoverLiveness({ probeOk: true, pids: [], explicitStop: false, autoEnsureOnLoad: true }), false))
t('有进程（可能在载入模型）→ 不重复拉起', () =>
  eq(shouldRecoverLiveness({ probeOk: false, pids: [1234], explicitStop: false, autoEnsureOnLoad: true }), false))
t('显式停过 → 不抢（我关了它，别自己活过来）', () =>
  eq(shouldRecoverLiveness({ probeOk: false, pids: [], explicitStop: true, autoEnsureOnLoad: true }), false))
t('配置关了自动拉起 → 不抢', () =>
  eq(shouldRecoverLiveness({ probeOk: false, pids: [], explicitStop: false, autoEnsureOnLoad: false }), false))
t('空参数防御：不抛、默认不动作', () => eq(shouldRecoverLiveness(), false))
t('2026-10-01 事故回放：崩了（无进程）且没人显式停 → 必须恢复', () =>
  eq(shouldRecoverLiveness({ probeOk: false, pids: [], explicitStop: false, autoEnsureOnLoad: true }), true))

console.log('== 账目 actor 解析（v0.4.0 补齐：调用方不写 actor 时不能丢"谁做的"） ==')
const actorSid = 'session-actor-case'
const actorSh = sessionHashFor(actorSid)
registerIdentity(db, '账目测试员', 'actor 用例')
bindSession(db, actorSh, '账目测试员')

t('显式 actor 优先（调用方身份不夺权）', () =>
  eq(resolveActor(db, { actor: '手写方', exec: { agent: { session: { id: actorSid } } } }), '手写方'))
t('未传 actor → 按调用方会话绑定的身份名落账（拾遗实测的那格）', () =>
  eq(resolveActor(db, { actor: null, exec: { agent: { session: { id: actorSid } } } }), '账目测试员'))
t('无 exec（面板/程序化调用）→ null，不抛', () =>
  eq(resolveActor(db, { actor: null }), null))
t('有 exec 但该会话未绑定 → null，不抛', () =>
  eq(resolveActor(db, { actor: null, exec: { agent: { session: { id: 'session-unbound-xyz' } } } }), null))
t('空白 actor 视为未传（不让空格落进账目）', () =>
  eq(resolveActor(db, { actor: '   ', exec: { agent: { session: { id: actorSid } } } }), '账目测试员'))

db.close()
try { rmSync(dir, { recursive: true, force: true }) } catch {}

console.log(`\n桩测结果：${pass} 过 / ${fail} 败`)
process.exitCode = fail ? 1 : 0
