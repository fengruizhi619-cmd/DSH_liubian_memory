/**
 * v0.7.0 定向验证（**不依赖 8082**：noteLlmGen=false 走回退提炼，不调嵌入）
 *   $env:DSH_HOME='<隔离目录>'; node notes-v070-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const IMPL = 'E:/DSH_data/流变系统/dsh-liubian-notes/lib/impl.mjs'
const T = (await import(pathToFileURL(IMPL).href + '?t=' + Date.now())).__test
const HOME = process.env.DSH_HOME
if (!HOME) { console.error('必须设隔离 DSH_HOME'); process.exit(2) }
fs.mkdirSync(T.notesDir(), { recursive: true })

const out = []
const check = (n, ok, d) => out.push({ n, ok: !!ok, d })
const cfg = Object.assign(T.resolveConfig({}), { noteLlmGen: false })
const K = (s) => T.sessionKeyFor(s)
const mk = (k, sid, notes, rounds = 12) => ({
  sessionKey: k, sessionId: sid, lastTurn: rounds,
  meta: { rounds, humanRounds: rounds, humanChars: 0, assistantChars: 0 },
  sealed: [], current: null, notes,
})
const note = (id, heat, born) => ({ id, source: 'auto', status: 'active', head: 'h-' + id, body: 'b-' + id, born_turn: born, heat, vector: null })

/* ① 源码级护栏：上传记忆只能银杏做 + schema 与实现对齐 */
const src = fs.readFileSync(IMPL, 'utf8')
check('① 便签侧不写 wiki（liubianWiki 零引用 / 无 svc.create）',
  src.indexOf('liubianWiki') < 0 && !/svc\.create\(/.test(src), 'liubianWiki=' + (src.indexOf('liubianWiki') >= 0 ? '有' : '无'))
check('① schema 已声明 nowTurn（实现读得到）', /nowTurn: \{ type: 'number'/.test(src), '')

/* ② 池满 → 取热度最高 → 送出 → 出池 */
const s1 = 'sess-v070-full', k1 = K(s1)
const nine = Array.from({ length: 9 }, (_, i) => note('NT-' + (i + 1), [], 1))
T.savePool(mk(k1, s1, [...nine, note('NT-HOT', [10, 11, 12], 5), note('NT-COLD', [12], 6)], 12))
const calls = []
T.__testSetCtx({ reflect: { get: (n) => (n === 'kotatsuBoard' ? { version: 1, send: async (a) => { calls.push(a); return { ok: true, bid: 77, to: '银杏' } } } : null) } })
const r1 = await T.graduateOnce(cfg, T.loadPool(k1, s1), null)
check('② 池满 → 送出并出池', r1.ok === true && r1.bid === 77, JSON.stringify(r1))
check('② 挑的是**热度最高**那张（NT-HOT）', r1.id === 'NT-HOT', 'id=' + r1.id)
const p1 = T.loadPool(k1, s1)
check('② 出池：11→10 且 graduated 留档',
  p1.notes.length === 10 && !p1.notes.some((n) => n.id === 'NT-HOT') && (p1.graduated || []).length === 1 && p1.graduated[0].bid === 77,
  'n=' + p1.notes.length + ' grad=' + (p1.graduated || []).length)
const acc = T.pendingEntry(k1, 'NT-HOT')
check('② 账目 sent=true + 带全文 body + auto 标记',
  !!acc && acc.sent === true && acc.body === 'b-NT-HOT' && acc.auto === true, 'sent=' + (acc && acc.sent) + ' body=' + (acc && acc.body))
check('② 收件人=银杏、fromRef 带池键', calls.length === 1 && calls[0].to === '银杏' && String(calls[0].fromRef).indexOf(k1 + '/NT-HOT') >= 0, JSON.stringify({ to: calls[0] && calls[0].to, ref: calls[0] && calls[0].fromRef }))

/* ③ 池未满 → 一律不动（放满了才送） */
const s2 = 'sess-v070-notfull', k2 = K(s2)
T.savePool(mk(k2, s2, [note('NT-1', [1], 1)], 3))
const r2 = await T.graduateOnce(cfg, T.loadPool(k2, s2), null)
check('③ 池未满 → 一律不动', r2.ok === false && r2.skipped === '池未满' && T.loadPool(k2, s2).notes.length === 1, JSON.stringify(r2))

/* ④ 服务不可用 → 留在池内 + 账目 sent:false（不静默丢） */
T.__testSetCtx(null)
const nBefore = p1.notes.length
const r3 = await T.graduateOnce(cfg, p1, null)
check('④ 无服务 → 便签留在池内（不丢）', r3.ok === false && p1.notes.length === nBefore && !!T.pendingEntry(k1, 'NT-HOT'), 'n=' + p1.notes.length)

/* ⑤ raceEvict 容量按总数管：总数超限但可赛马不足时**也要腾位** */
const s3 = 'sess-v070-race', k3 = K(s3)
const queued = (i) => Object.assign(note('NT-Q' + i, [], 1), { status: 'queued' })
const act = (i) => note('NT-A' + i, [12], i + 2)
const p3 = mk(k3, s3, [queued(1), queued(2), ...Array.from({ length: 9 }, (_, i) => act(i))], 12)
check('⑤ 前置：11 总数 / 9 可赛马', p3.notes.length === 11 && T.racableNotes(p3).length === 9, 'n=' + p3.notes.length)
const ev = T.raceEvict(p3, Object.assign({}, cfg, { heatRounds: 5 }), 12)
check('⑤ 总数超限即腾位（旧实现此时一篇都不淘汰）', !!ev && p3.notes.length === 9, 'evicted=' + (ev && ev.id) + ' 剩=' + p3.notes.length)

T.__testSetCtx(null)
const bad = out.filter((r) => !r.ok)
for (const r of out) console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.n + (r.d ? '   [' + r.d + ']' : ''))
console.log('\n' + (bad.length ? 'FAIL' : 'ALL PASS') + `  ${out.length - bad.length}/${out.length}`)
process.exit(bad.length ? 1 : 0)
