/** v0.8.0 定向验证（任务三：pinned 分块注入 / lane 分区 / 建议去向透传）
 *  需 8082 在线（injectionBlock 真嵌入查询）。
 *  $env:DSH_HOME='<隔离目录>'; node notes-v080-check.mjs
 */
import fs from 'node:fs'
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
const V = [0.11, 0.22, 0.33, 0.44]
const mk = (k, sid, notes, rounds = 13) => ({
  sessionKey: k, sessionId: sid, lastTurn: rounds,
  meta: { rounds, humanRounds: rounds, humanChars: 0, assistantChars: 0 },
  sealed: [], current: null, notes,
})
const note = (id, heat, born, extra = {}) => Object.assign({
  id, source: 'auto', status: 'active', head: 'h-' + id, body: 'b-' + id,
  born_turn: born, heat, vector: [...V],
}, extra)

/* ① 源码级：枚举与 args 文档同步（D10 教训：schema 是接口的一部分） */
const src = fs.readFileSync(IMPL, 'utf8')
check('① 枚举含 pin/lane（schema 同步）', /'pin', 'lane'/.test(src), '')
check("① args 声明 pinned/lane", /pinned: \{ type: 'boolean'/.test(src) && /lane: \{ type: 'string'/.test(src), '')

/* ② 分块制：置顶块与算法块各自计额、互不挤占 */
const s1 = 'sess-v080-pin', k1 = K(s1)
T.savePool(mk(k1, s1, [
  note('NT-A', [10], 5),
  note('NT-B', [10, 11], 6, { pinned: true }),
  note('NT-C', [10, 11, 12], 7, { pinned: true }),
  note('NT-D', [], 8, { pinned: true }),
], 13))
let block = await T.injectionBlock(T.loadPool(k1, s1), cfg, '查询文本', 13)
const pos = ['h-NT-A', 'h-NT-B', 'h-NT-C', 'h-NT-D'].map((h) => block.indexOf(h))
check('② 置顶块超限截断：3 张 pinned 按热度 C/B/A，未 pinned 的 D 也在（分块互不挤占）',
  pos.every((p) => p >= 0) && pos[2] < pos[1] && pos[1] < pos[0],
  'pos=' + pos.join(','))

/* ③ pinned 少于块上限 → pinned 排最前，算法块照常补 */
const s2 = 'sess-v080-pin2', k2 = K(s2)
T.savePool(mk(k2, s2, [note('NT-1', [], 1), note('NT-2', [], 2, { pinned: true })], 13))
block = await T.injectionBlock(T.loadPool(k2, s2), cfg, '查询文本', 13)
check('③ 单 pinned 排最前、算法块照常', block.indexOf('h-NT-2') >= 0 && block.indexOf('h-NT-2') < block.indexOf('h-NT-1'), '')

/* ④ pin 动作：翻转 / 显式 / 未找到 */
const r1 = await T.noteToolAction(cfg, { action: 'pin', id: 'NT-1', session: s2 }, null)
check('④ pin 翻转（false→true）', /已置顶/.test(r1) && T.loadPool(k2, s2).notes[0].pinned === true, String(r1).slice(0, 24))
const r2 = await T.noteToolAction(cfg, { action: 'pin', id: 'NT-1', session: s2, pinned: false }, null)
check('④ pin 显式取消', /已取消置顶/.test(r2) && T.loadPool(k2, s2).notes[0].pinned !== true, String(r2).slice(0, 24))
const r3 = await T.noteToolAction(cfg, { action: 'pin', id: 'NT-404', session: s2 }, null)
check('④ 未找到如实报', /未找到/.test(r3), String(r3).slice(0, 20))

/* ⑤ lane 动作：设置 / 非法拒；建议去向随升格请求送银杏（池满前提） */
const r4 = await T.noteToolAction(cfg, { action: 'lane', id: 'NT-1', session: s2, lane: 'lesson' }, null)
check('⑤ lane=lesson 记入便签', /分区已记/.test(r4) && T.loadPool(k2, s2).notes[0].lane === 'lesson', String(r4).slice(0, 24))
const r5 = await T.noteToolAction(cfg, { action: 'lane', id: 'NT-1', session: s2, lane: ' garbage ' }, null)
check('⑤ 非法 lane 拒绝', /拒绝/.test(r5), String(r5).slice(0, 24))

/* 补满到 10 张（graduateOnce 要求池满），其余全空热度 → NT-1（0.20）为最高 */
const p2 = T.loadPool(k2, s2)
for (let i = 0; i < 8; i++) p2.notes.push(note('NT-F' + i, [], 100 + i))
T.savePool(p2)

const calls = []
T.__testSetCtx({ reflect: { get: (n) => (n === 'kotatsuBoard' ? {
  version: 1, send: async (a) => { calls.push(a); return { ok: true, bid: 9, to: '银杏' } },
} : null) } })
await T.noteToolAction(cfg, { action: 'pin', id: 'NT-1', session: s2, pinned: true }, null)
const g = await T.graduateOnce(cfg, T.loadPool(k2, s2), null)
check('⑤ 升格请求带建议去向（教训支路）',
  g.ok === true && calls.length === 1 && String(calls[0].content).indexOf('建议去向：教训支路') >= 0,
  'ok=' + g.ok + ' idx=' + String(calls[0] && calls[0].content).indexOf('建议去向'))
check('⑤ 毕业出池（NT-1 离池）', g.ok === true && !T.loadPool(k2, s2).notes.some((n) => n.id === 'NT-1'), '')
T.__testSetCtx(null)

/* ⑥ lane 清除 */
const r6 = await T.noteToolAction(cfg, { action: 'lane', id: 'NT-2', session: s2 }, null)
check('⑥ lane 留空清除', /分区已清除/.test(r6) && T.loadPool(k2, s2).notes[0].lane === null, String(r6).slice(0, 20))

const bad = out.filter((r) => !r.ok)
for (const r of out) console.log((r.ok ? '  OK ' : '  X  ') + r.n + (r.d ? '   [' + r.d + ']' : ''))
console.log('\n' + (bad.length ? 'FAIL' : 'ALL PASS') + `  ${out.length - bad.length}/${out.length}`)
process.exit(bad.length ? 1 : 0)
