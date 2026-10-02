/**
 * v0.6.3 定向验证（**不依赖 8082**：全程 noteLlmGen=false 走回退提炼，不调嵌入）
 *   $env:DSH_HOME='<隔离目录>'; node notes-v063-check.mjs
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
const check = (name, ok, detail) => out.push({ name, ok: !!ok, detail })
const cfg = Object.assign(T.resolveConfig({}), { noteLlmGen: false })
const s = 'sess-v063-check'
const k = T.sessionKeyFor(s)
T.savePool({
  version: 'test', sessionKey: k, sessionId: s, lastTurn: 0,
  meta: { rounds: 0, humanRounds: 0, humanChars: 0, assistantChars: 0 },
  sealed: [], current: null,
  notes: [{
    id: 'NT-1', source: 'auto', status: 'active', born_turn: 1, heat: [],
    head: '云端 LoRA 停训与复现对比结论',
    body: '结论：复现成立（逐窗 mean|Δ|=6.84e-4）。机制：bf16 非确定性，不是代码错。终态：云端已空闲，待跑 ep2/ep3。',
  }],
})

/* ① 回退提炼的合规性 */
const req = await T.buildPromoteRequest(cfg, T.loadPool(k, s).notes[0], null)
check('① slug 合规（无斜杠、非池编号）', !!req.slug && req.slug.indexOf('/') < 0 && !/^promote-NT-/.test(req.slug), 'slug=' + req.slug)
check('① 含三段式 + 来源痕迹，且不猜家族（无 familyPath）',
  /结论/.test(req.content) && /机制/.test(req.content) && /终态/.test(req.content)
  && /来源痕迹/.test(req.content) && req.content.indexOf('familyPath') < 0, 'gen=' + req.gen)

/* ② 无服务 → 明确报错、不置 queued、账目 sent:false */
T.__testSetCtx(null)
const noSvc = await T.noteToolAction(cfg, { action: 'promote', id: 'NT-1', session: s }, null)
check('② 无 board 服务 → 明确报错且池状态不动', /失败/.test(noSvc) && T.loadPool(k, s).notes[0].status === 'active', String(noSvc).slice(0, 30))
const e1 = T.pendingEntry(k, 'NT-1')
check('② 请求未丢：账目 sent=false 且带 slug', !!e1 && e1.sent === false && !!(e1.request && e1.request.slug), 'sent=' + (e1 && e1.sent))

/* ③ 有服务且送达 → queued + bid + fromRef 带池键 + 账目只一条 */
const calls = []
T.__testSetCtx({ reflect: { get: (n) => (n === 'kotatsuBoard' ? {
  version: 1, send: async (a) => { calls.push(a); return { ok: true, bid: 42, to: '银杏' } },
} : null) } })
const okOut = await T.noteToolAction(cfg, { action: 'promote', id: 'NT-1', session: s }, null)
check('③ 送达 → queued 且回执带 bid', /42/.test(okOut) && T.loadPool(k, s).notes[0].status === 'queued', String(okOut).slice(0, 34))
check('③ 收件人=银杏、fromRef 带池键', calls.length === 1 && calls[0].to === '银杏' && String(calls[0].fromRef).indexOf(k + '/NT-1') >= 0,
  JSON.stringify({ to: calls[0] && calls[0].to, fromRef: calls[0] && calls[0].fromRef }))
const dup = fs.readFileSync(T.pendingPromotionsFile(), 'utf8').split('\n').filter(Boolean)
  .filter((l) => l.indexOf(k) >= 0 && l.indexOf('"NT-1"') >= 0).length
check('③ 同 id 账目不重复两条', dup === 1, 'entries=' + dup)

/* ④ 幂等：已发出 → 只回跳过、不重发 */
const again = await T.noteToolAction(cfg, { action: 'promote', id: 'NT-1', session: s }, null)
check('④ 已发出 → 再 promote 只回跳过（不重发）', /跳过/.test(again) && calls.length === 1, String(again).slice(0, 26) + '｜calls=' + calls.length)

/* ⑤ 废掉的五连发标签派生必须 0 引用 */
const src = fs.readFileSync('E:/DSH_data/流变系统/dsh-liubian-notes/lib/impl.mjs', 'utf8')
check('⑤ 旧「五连发升格标签」已彻底移除', src.indexOf('buildPromoteTags') < 0, '残留=' + (src.indexOf('buildPromoteTags') >= 0 ? '有' : '无'))

T.__testSetCtx(null)
const bad = out.filter((r) => !r.ok)
for (const r of out) console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.name + (r.detail ? '   [' + r.detail + ']' : ''))
console.log('\n' + (bad.length ? 'FAIL' : 'ALL PASS') + `  ${out.length - bad.length}/${out.length}`)
process.exit(bad.length ? 1 : 0)
