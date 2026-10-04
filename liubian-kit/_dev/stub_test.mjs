/**
 * liubian-kit 桩测（协议 §19 纪律 2：kit 改动必带桩测；本文件同时是继承者的合规桩测模板）。
 * 跑法：node.cmd liubian-kit/_dev/stub_test.mjs
 * 夹具纪律：临时目录 + 内存态，**绝不 junction 真实仓库**（青芷事故）。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { BaseLiubianService, consumeLiubianService, BaseTombstones, BaseJsonlFile, KIT_VERSION } from '../index.mjs'

let pass = 0, fail = 0
const t = (label, fn) => {
  try { const extra = fn(); pass++; console.log(`  ✓ ${label}${extra ? '｜' + extra : ''}`) }
  catch (e) { fail++; console.log(`  ✗ ${label}\n      ${e.message}`) }
}
const eq = (a, b, msg = '') => { if (a !== b) throw new Error(`期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)} ${msg}`) }
const ta = async (label, fn) => {
  try { const extra = await fn(); pass++; console.log(`  ✓ ${label}${extra ? '｜' + extra : ''}`) }
  catch (e) { fail++; console.log(`  ✗ ${label}\n      ${e.message}`) }
}
const throws = (fn, frag) => {
  try { fn() } catch (e) { if (!String(e.message).includes(frag)) throw new Error(`错误消息缺「${frag}」：${e.message}`); return }
  throw new Error(`应当抛出含「${frag}」的错误，但没有抛`)
}

console.log(`liubian-kit v${KIT_VERSION}\n`)

const dir = mkdtempSync(join(tmpdir(), 'liubian-kit-'))
const db = new DatabaseSync(join(dir, 'kit.db'))

console.log('== BaseLiubianService ==')
const calls = []
class FakeCtx {
  constructor(mode) { this.mode = mode; this.registered = []; this.reflect = { provide: undefined, get: undefined } }
}
t('call：方法正常返回', () => {
  const s = new BaseLiubianService({ name: 'liubianT', version: 3, methods: { ping: async () => ({ ok: true }) } })
  eq(s.name, 'liubianT'); eq(s.version, 3)
  return 'ok'
})
await ta('call：业务异常 → 绝不抛，折成 {ok:false,error}', async () => {
  const s = new BaseLiubianService({ name: 'liubianT', methods: { boom: async () => { throw new Error('炸了') } } })
  const r = await s.call('boom')
  eq(r.ok, false)
  if (!/炸了/.test(String(r.error))) throw new Error('应保留原错误信息')
  return String(r.error)
})
await ta('call：未知方法名 → 显式报错（不静默兜底）', async () => {
  const s = new BaseLiubianService({ name: 'liubianT', methods: {} })
  const r = await s.call('不存在')
  eq(r.ok, false)
  if (!/未知方法/.test(String(r.error))) throw new Error('应报未知方法')
})
t('mount：ctx.provide 优先，服务戳行含 via 与 kit 版本', () => {
  const lines = []
  const logger = { info: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push('W ' + a.join(' ')) }
  const registered = []
  const ctx = { provide: (n, v) => { registered.push(n); return () => {} }, logger }
  const s = new BaseLiubianService({ name: 'liubianT', version: 2, kitVersion: KIT_VERSION, logger, pluginName: 'p' })
  s.mount(ctx)
  eq(registered.length, 1)
  if (!lines.join('\n').includes('ctx.provide')) throw new Error('应标注 via')
  if (!lines.join('\n').includes('liubian-kit v' + KIT_VERSION)) throw new Error('挂载行应带 kit 版本')
  return registered.join(',')
})
t('mount：无 ctx.provide 但有 reflect.provide → 回退', () => {
  const registered = []
  const ctx = { reflect: { provide: (n, v) => { registered.push(n); return () => {} } }, logger: { info() {}, warn() {} } }
  new BaseLiubianService({ name: 'liubianT', logger: ctx.logger, pluginName: 'p' }).mount(ctx)
  eq(registered.length, 1)
})
t('mount：两通道皆无 → warn + 服务缺席（不抛）', () => {
  const lines = []
  const ctx = { logger: { info: () => {}, warn: (...a) => lines.push(a.join(' ')) } }
  new BaseLiubianService({ name: 'liubianT', logger: ctx.logger, pluginName: 'p' }).mount(ctx)
  if (!lines.join('').includes('未挂载')) throw new Error('应显式说明服务缺席')
})
t('mount：注册动作抛异常 → warn 留痕、不向上抛', () => {
  const lines = []
  const ctx = { provide: () => { throw new Error('重名') }, logger: { info: () => {}, warn: (...a) => lines.push(a.join(' ')) } }
  new BaseLiubianService({ name: 'liubianT', logger: ctx.logger, pluginName: 'p' }).mount(ctx)
  if (!lines.join('').includes('挂载失败')) throw new Error('应留痕挂载失败')
})
t('consumeLiubianService：拿得到就返回、拿不到 null、ctx 异常 null', () => {
  eq(consumeLiubianService({ get: () => 'svc' }, 'x'), 'svc')
  eq(consumeLiubianService({ reflect: { get: () => null } }, 'x'), null)
  eq(consumeLiubianService(null, 'x'), null)
})

await ta('直调形态：方法铺到实例上（协议 §17 模板 + 全部既有消费方的调用方式）', async () => {
  const s = new BaseLiubianService({ name: 'liubianT', version: 2, methods: { foo: async () => ({ ok: true }), version: 99 } })
  eq(typeof s.foo, 'function', 'v0.1.0 缺这个——被炉三个消费点直调落空的根因')
  eq((await s.foo()).ok, true, '直调应能用')
  eq(s.version, 2, '方法表里的 version 字段不得覆盖声明的版本')
  eq((await s.call('foo')).ok, true, '直调与 call() 应并存')
  return 'typeof 与 call() 双形态'
})
await ta('直调的业务异常：方法自身守约返回 {ok,error}（kit 不二次包装直调）', async () => {
  const s = new BaseLiubianService({ name: 'liubianT', methods: { bad: async () => ({ ok: false, error: '按契约返回' }) } })
  const r = await s.bad()
  eq(r.ok, false)
  eq(r.error, '按契约返回')
})

console.log('== BaseTombstones ==')
const tom = new BaseTombstones(db, { keyColumn: 'session_hash' })
tom.ensureSchema()
tom.ensureSchema()   // 幂等

t('markForgotten：追加 forget 事件；幂等不重复追加', () => {
  const r1 = tom.markForgotten('k1', { actor: '测试', reason: 'r' })
  eq(r1.appended, true)
  const n0 = db.prepare('SELECT COUNT(*) AS c FROM tombstones').get().c
  const r2 = tom.markForgotten('k1')
  eq(r2.appended, false, '已在墓碑态不得重复追加')
  eq(db.prepare('SELECT COUNT(*) AS c FROM tombstones').get().c, n0, '事件数不得增加')
})
t('isForgotten：状态 = 最新事件的 op', () => eq(tom.isForgotten('k1'), true))
t('markLifted：复活留痕（新事件，不删历史）', () => {
  const n0 = db.prepare('SELECT COUNT(*) AS c FROM tombstones').get().c
  const r = tom.markLifted('k1', { actor: '管理员' })
  eq(r.appended, true)
  eq(tom.isForgotten('k1'), false)
  eq(db.prepare('SELECT COUNT(*) AS c FROM tombstones').get().c, n0 + 1, '复活是一条新事件')
})
t('lift 幂等：不在墓碑态不追加', () => eq(tom.markLifted('k1').appended, false))
t('changesSince：增量事件 + forgotten 全量快照两路都在', () => {
  tom.markForgotten('k2', { actor: 'x' })
  const full = tom.changesSince(0)
  if (!full.events.some(e => e.key === 'k2' && e.op === 'forget')) throw new Error('增量应含 k2 forget')
  if (!full.forgotten.includes('k2')) throw new Error('快照应含 k2')
  const delta = tom.changesSince(full.seq)
  eq(delta.events.length, 0, '水位之后应无新事件')
  eq(delta.forgotten.includes('k2'), true, '快照与水位无关——查态不该被水位坑')
  return `seq=${full.seq}｜forgotten=${JSON.stringify(full.forgotten)}`
})
t('跨水位可见复活（一行一状态的写法会在这里漏）', () => {
  const before = tom.changesSince(0).seq
  tom.markLifted('k2', { actor: 'x' })
  const delta = tom.changesSince(before).events
  eq(delta.length, 1)
  eq(delta[0].op, 'lift')
})
t('keyColumn 可配：既有库列名（session_hash）直接可用', () => {
  const t2 = new BaseTombstones(db, { keyColumn: 'session_hash' })
  t2.markForgotten('ab12cd34', { actor: 'x' })
  eq(t2.isForgotten('ab12cd34'), true)
  if (!tom.changesSince(0).forgotten.includes('ab12cd34')) throw new Error('两实例应共享同一张表')
})

console.log('== BaseJsonlFile（协议 §7 #19/#21：JSONL 数据文件即接口） ==')
{
  const jf = new BaseJsonlFile({ file: join(dir, 'pending-demo.jsonl'), schema: 'pending-demo', version: 1 })
  t('首写强制 _meta：meta 行存在、**不带 id**', () => {
    jf.append({ id: 'NT-1', session_key: 'aa11', queued_at: '2026-10-05T00:00:00Z', head: 'h1' })
    const raw = jf.rawLines()
    const meta = JSON.parse(raw[0])
    if (meta._meta !== true) throw new Error('首行应是 _meta')
    if ('id' in meta) throw new Error('meta 行禁带 id（§7 #19）')
    if (meta.schema !== 'pending-demo' || meta.version !== 1) throw new Error('meta 形状不对')
    return raw[0].slice(0, 60)
  })
  t('存量文件无 _meta：ensureMeta 补插且**原行无损**（读侧容忍旧形态）', () => {
    const f2 = new BaseJsonlFile({ file: join(dir, 'legacy.jsonl'), schema: 'legacy' })
    writeFileSync(join(dir, 'legacy.jsonl'), '{"id":"old-1"}\n', 'utf8')
    const r = f2.ensureMeta()
    eq(r.inserted, true)
    const rows = f2.rows()
    eq(rows.length, 1)
    eq(rows[0].id, 'old-1', '原行必须无损')
    eq(f2.hasMeta(), true)
    f2.ensureMeta()
    eq(f2.rows().length, 1, '二次 ensureMeta 幂等')
  })
  t('rows()：跳过 _meta 行与坏行（读侧容忍）', () => {
    const f3 = new BaseJsonlFile({ file: join(dir, 'messy.jsonl'), schema: 'messy' })
    f3.append({ id: 'a' })
    const f = f3.file
    writeFileSync(f, readFileSync(f, 'utf8') + '这不是JSON\n' + '{"id":"b","extra":1}\n', 'utf8')
    const rows = f3.rows()
    eq(rows.map(r => r.id).join(','), 'a,b', '坏行跳过、未知字段容忍')
  })
  // NT-16 真事故形态：同 id 双条（不同 queued_at）——三元组摘除只删命中行
  const f4 = new BaseJsonlFile({ file: join(dir, 'triple.jsonl'), schema: 'triple', version: 1,
    keyOf: row => `${row.session_key}+${row.id}+${row.queued_at}` })
  f4.append({ id: 'NT-16', session_key: 'aa11', queued_at: '2026-10-04T10:00:00Z', bid: 47 })
  f4.append({ id: 'NT-16', session_key: 'aa11', queued_at: '2026-10-04T11:00:00Z', bid: 56 })
  t('三元组摘除：同 id 双条，摘 bid=56 那条、bid=47 历史无损（NT-16 真事故形态）', () => {
    const removed = f4.removeByKey('aa11+NT-16+2026-10-04T11:00:00Z')
    eq(removed, 1, '只删命中行')
    const rest = f4.rows().filter(r => r.id === 'NT-16')
    eq(rest.length, 1)
    eq(rest[0].bid, 47, '历史条目必须无损')
    return '摘 1 存 1'
  })
  t('removeWhere：_meta 行与坏行**原样保留**（摘除不含糊）', () => {
    writeFileSync(f4.file, readFileSync(f4.file, 'utf8') + '坏行\n', 'utf8')
    const removed = f4.removeWhere(row => row.id === 'NT-16')
    eq(removed, 1)
    const raw = f4.rawLines()
    if (!raw.some(l => l.includes('坏行'))) throw new Error('坏行必须原样保留')
    if (raw[0].indexOf('_meta') !== 0 && !JSON.parse(raw[0])._meta) throw new Error('_meta 行必须保留')
    return `removed=${removed}｜总行=${raw.length}`
  })
  t('没删到 = 0（与 -1 写失败严格区分）', () => eq(f4.removeWhere(row => row.id === '查无此人'), 0))
  t('append 后文件以换行结尾（append-only 卫生）', () => {
    const s = readFileSync(f4.file, 'utf8')
    if (!s.endsWith('\n')) throw new Error('尾行应有换行')
  })
}

db.close()
try { rmSync(dir, { recursive: true, force: true }) } catch {}

console.log(`\nliubian-kit 桩测结果：${pass} 过 / ${fail} 败`)
process.exitCode = fail ? 1 : 0
