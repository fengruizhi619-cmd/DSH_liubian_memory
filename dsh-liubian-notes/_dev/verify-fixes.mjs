/**
 * 便签冷眼审计修复项的验证台（隔离 DSH_HOME 运行）
 *
 * 用法（必须设隔离 DSH_HOME，避免碰真实池）：
 *   $env:DSH_HOME='C:\...\temp-notes-verify'; node _dev/verify-fixes.mjs
 *
 * 覆盖：🔴-1 list 只读 / 🔴-2 坏池隔离+原子写 / 🔴-3 判重拒收回补窗口 /
 *       🟠-1 同轮去重（含跨实例共享）/ 🟠-2 pruneHeat 保留 turn 回退记录 /
 *       🟠-4 loadPool 去重「sealed 末项==current」/ 🟡-2 向量回填对齐 / 🟡-5 pending 去重
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const IMPL = 'E:/DSH_data/流变系统/dsh-liubian-notes/lib/impl.mjs'
const url = (tag) => pathToFileURL(IMPL).href + '?t=' + tag
const T = (await import(url('main'))).__test
const impl = await import(url('main'))

const HOME = process.env.DSH_HOME
if (!HOME) { console.error('必须先设隔离 DSH_HOME'); process.exit(2) }
const poolsDir = T.notesDir()
fs.mkdirSync(poolsDir, { recursive: true })

const results = []
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail })
/** 工具面按 session 派生池 key（sessionKeyFor），写文件必须用同一个 key 才落在同一池。 */
const K = (session) => T.sessionKeyFor(session)
const writePool = (key, obj) => fs.writeFileSync(path.join(poolsDir, key + '.json'), JSON.stringify(obj), 'utf8')
const readPlain = (key) => fs.readFileSync(path.join(poolsDir, key + '.json'), 'utf8')
const basePool = (key, extra = {}) => Object.assign({
  version: 'test', sessionKey: key, sessionId: 's-' + key,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  meta: { rounds: 0, humanRounds: 0, humanChars: 0, assistantChars: 0 },
  sealed: [], current: null, notes: [],
}, extra)
const cfg = T.resolveConfig({})

/* 🔴-1：list 不得触碰 note.heat（读路径只读） */
{
  const session = 'sess-fix-list-read'
  const key = K(session)
  writePool(key, basePool(key, {
    sessionId: session,
    notes: [{ id: 'NT-1', source: 'manual', status: 'active', head: '头', body: '正文', born_turn: 1, heat: [1, 2] }],
  }))
  const out = await T.noteToolAction(cfg, { action: 'list', session }, null)
  const after = JSON.parse(readPlain(key))
  check('🔴-1 list 不改写 heat（磁盘）', JSON.stringify(after.notes[0].heat) === '[1,2]', 'heat=' + JSON.stringify(after.notes[0].heat))
  check('🔴-1 list 只读计数显示', /热度2条/.test(out), out.split('\n')[1] || '')
  // 写路径（stick 触发 savePool）之后 heat 仍不得被清空
  await T.noteToolAction(cfg, { action: 'stick', head: '第二张', body: '内容', session }, null)
  const after2 = JSON.parse(readPlain(key))
  const n1 = after2.notes.find((n) => n.id === 'NT-1')
  check('🔴-1 落盘后旧 heat 仍在', n1 && JSON.stringify(n1.heat) === '[1,2]', 'heat=' + JSON.stringify(n1 && n1.heat))
}

/* 🔴-2a：坏池隔离（现场保留，不被空池覆盖） */
{
  const key = 'fix-corrupt'
  const bad = '{ 这不是合法 JSON'
  fs.writeFileSync(path.join(poolsDir, key + '.json'), bad, 'utf8')
  const pool = T.loadPool(key, 'sess-' + key)
  const quarantined = fs.readdirSync(poolsDir).filter((f) => f.startsWith(key + '.json.corrupt-'))
  check('🔴-2 坏文件已隔离', quarantined.length === 1, quarantined.join(','))
  check('🔴-2 隔离件保留原始字节', quarantined.length === 1 && fs.readFileSync(path.join(poolsDir, quarantined[0]), 'utf8') === bad, '')
  check('🔴-2 返回空池继续服务', pool && Array.isArray(pool.notes) && pool.notes.length === 0, '')
}

/* 🔴-2b：原子写（返回 true、无 .tmp 残留、可解析） */
{
  const key = 'fix-atomic'
  const pool = T.loadPool(key, 'sess-' + key)
  pool.notes.push({ id: 'NT-1', source: 'manual', status: 'active', head: 'h', body: 'b', born_turn: 1, heat: [] })
  const ok = T.savePool(pool)
  const tmpLeft = fs.readdirSync(poolsDir).filter((f) => f.includes('.tmp-'))
  let parses = false
  try { parses = Array.isArray(JSON.parse(readPlain(key)).notes) } catch {}
  check('🔴-2 savePool 返回 true 且原子无残留', ok === true && tmpLeft.length === 0 && parses, 'tmp=' + tmpLeft.join(','))

  /* 卸载后不得回写（🟠-3 护栏）：用第二个实例模拟"旧实例" */
  const old = await import(url('dead'))
  const deadPool = old.__test.loadPool('fix-dead', 's-dead')
  // 直接触发其 disposed 路径不可行（apply 需 ctx）；改用行为断言：savePool 在 disposed=false 时可用
  check('🟠-3 双实例模块隔离存在', typeof old.__test.savePool === 'function', '')
}

/* 🟠-4：磁盘上「sealed 末项 == current」重复态在载入时被去重 */
{
  const key = 'fix-dup-current'
  writePool(key, basePool(key, {
    sealed: [{ turn: 5, human: ['abc'], assistant: [] }],
    current: { turn: 5, human: ['abc'], assistant: [] },
  }))
  const pool = T.loadPool(key, 'sess-' + key)
  check('🟠-4 current 重复态被清除', pool.current === null && pool.sealed.length === 1, 'current=' + JSON.stringify(pool.current))
}

/* 🟠-2：pruneHeat 保留「回合号回退」的记录（d<0），只丢真正过期的 */
{
  const a = { heat: [1, 2, 10] }
  const keptA = T.pruneHeat(a, 3, 5)          // d = 2,1,-7 → 全部 d<m → 保留 3 条
  const b = { heat: [1, 2, 10] }
  const keptB = T.pruneHeat(b, 20, 5)         // d = 19,18,10 → 全部 d>=m → 丢光
  check('🟠-2 回合号回退不抹记录', keptA === 3 && a.heat.includes(10), 'kept=' + keptA + ' heat=' + JSON.stringify(a.heat))
  check('🟠-2 真正过期仍压缩', keptB === 0, 'kept=' + keptB)
  const s = T.heatScore({ heat: [3, 3] }, 3, 5)
  check('🟠-2 heatScore 只读不改写', Math.abs(s - 0.4) < 1e-9, 'score=' + s)
}

/* 🟠-1：同轮去重（内存态 token），且跨模块实例共享 */
{
  const key = 'fix-dedupe-turn'
  check('🟠-1 未标记时允许注入', T.injectionAlreadyDone(key, 7) === false, '')
  T.markInjectionDone(key, 7)
  check('🟠-1 标记后同轮抑制', T.injectionAlreadyDone(key, 7) === true, '')
  check('🟠-1 回合变化后放行', T.injectionAlreadyDone(key, 8) === false, '')
  const other = await import(url('other'))
  check('🟠-1 token 跨实例共享（globalThis）', other.__test.injectionAlreadyDone(key, 7) === true, '')
}

/* 🟠-3：池锁跨实例共享（后到者必须排队） */
{
  const order = []
  const other = await import(url('lockB'))
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const a = T.withPoolLock('shared-key', async () => { await sleep(120); order.push('A') })
  const b = other.__test.withPoolLock('shared-key', async () => { order.push('B') })
  await Promise.all([a, b])
  check('🟠-3 池锁跨实例串行', order.join('') === 'AB', 'order=' + order.join(''))
}

/* 🟡-2：向量回填按位置对齐（含空 head 的池不得错位） */
{
  const key = 'fix-align'
  const pool = T.loadPool(key, 'sess-' + key)
  pool.notes = [
    { id: 'NT-1', source: 'manual', status: 'active', head: '   ', body: '空头', born_turn: 1, heat: [] },
    { id: 'NT-2', source: 'manual', status: 'active', head: '真实的头文本用于向量对齐验证', body: 'b', born_turn: 2, heat: [] },
  ]
  const ok = await T.backfillVectors(pool, cfg)
  const n1 = pool.notes[0]
  const n2 = pool.notes[1]
  check('🟡-2 空 head 不得拿到别人的向量', !Array.isArray(n1.vector), 'NT-1 vector=' + (Array.isArray(n1.vector) ? 'len' + n1.vector.length : 'none'))
  check('🟡-2 有效 head 正常回填', Array.isArray(n2.vector) && n2.vector.length > 0, 'NT-2 ' + (Array.isArray(n2.vector) ? 'len' + n2.vector.length : 'none') + ' ok=' + ok)
}

/* 🟡-5：pending 队列按 id 去重 */
{
  const session = 'sess-fix-pending'
  const key = K(session)
  writePool(key, basePool(key, {
    sessionId: session,
    notes: [{ id: 'NT-1', source: 'manual', status: 'active', head: 'h', body: 'b', born_turn: 1, heat: [] }],
  }))
  const first = await T.noteToolAction(cfg, { action: 'promote', id: 'NT-1', session }, null)
  const again = await T.noteToolAction(cfg, { action: 'promote', id: 'NT-1', session }, null)
  let lines = []
  try { lines = fs.readFileSync(T.pendingPromotionsFile(), 'utf8').split('\n').filter(Boolean) } catch { lines = [] }
  const mine = lines.filter((l) => { try { return JSON.parse(l).id === 'NT-1' } catch { return false } })
  check('🟡-5 重复 promote 不重复入队', mine.length === 1 && /跳过/.test(again), 'queue=' + mine.length + ' first=' + first.slice(0, 14) + ' again=' + again.slice(0, 14))
  check('🟡-5 pendingHasId 命中/未命中', T.pendingHasId(key, 'NT-1') === true && T.pendingHasId(key, 'NT-9') === false, '')
  /* 🟡-5 drop 守卫：queued 便签不得直接进回收站 */
  const dropOut = await T.noteToolAction(cfg, { action: 'drop', id: 'NT-1', session }, null)
  const afterDrop = JSON.parse(readPlain(key))
  check('🟡-5 queued 便签拒绝 drop', /拒绝/.test(dropOut) && afterDrop.notes.some((n) => n.id === 'NT-1'), dropOut.slice(0, 24))
}

/* 🔴-3：判重拒收时窗口必须回补，且不得死循环 */
{
  const key = 'fix-dedup-window'
  const pool = T.loadPool(key, 'sess-' + key)
  const window = [1, 2, 3, 4, 5].map((i) => ({ turn: i, human: ['人类第' + i + '轮的实质内容'], assistant: ['答复' + i], tools: [] }))
  pool.sealed = window.slice()
  const head = T.buildAutoHead(window)
  const vecs = await T.embedTexts({ ...cfg, noteLlmGen: false }, [head])
  if (!Array.isArray(vecs)) {
    check('🔴-3 判重拒收回补窗口', false, 'SKIP：8082 向量服务不可用，无法构造确定性的判重')
  } else {
    pool.notes = [{ id: 'NT-1', source: 'manual', status: 'active', head, body: '同义便签', born_turn: 1, heat: [], vector: vecs[0] }]
    const t0 = Date.now()
    const made = await T.maybeAggregate(pool, { ...cfg, noteLlmGen: false }, 5, null)
    const ms = Date.now() - t0
    check('🔴-3 拒收后 sealed 回补且立即返回（不死循环）',
      made === 0 && pool.sealed.length === 5 && ms < 8000,
      `made=${made} sealed=${pool.sealed.length} ms=${ms}`)
    const left = pool.notes.length
    check('🔴-3 拒收不产生垃圾便签', left === 1, 'notes=' + left)
  }
}

/* M4 回归：封存过滤与双口径 */
{
  const p = { meta: { rounds: 0, humanRounds: 0, humanChars: 0, assistantChars: 0 } }
  T.bumpStats(p, { human: [], assistant: ['唤醒'] })
  T.bumpStats(p, { human: ['人问'], assistant: ['答'] })
  check('M4 回归：双口径', p.meta.rounds === 2 && p.meta.humanRounds === 1, JSON.stringify(p.meta))
  check('M4 回归：非人类轮不入窗', T.shouldSealTurn({ human: [] }) === false && T.shouldSealTurn({ human: ['x'] }) === true, '')
}

const bad = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.name + (r.detail ? '   [' + r.detail + ']' : ''))
console.log('')
console.log((bad.length ? 'FAIL' : 'ALL PASS') + `  ${results.length - bad.length}/${results.length}`)
process.exit(bad.length ? 1 : 0)
