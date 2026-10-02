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
const ROOT = 'E:/DSH_data/流变系统/dsh-liubian-notes'   // 源码级护栏用（读 lib/impl.mjs 文本断言）
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

/* 「跟对话走」：按会话 id 取池（op=pool 的数据源） */
{
  const session = 'sess-follow-conversation'
  const key = K(session)
  writePool(key, basePool(key, {
    sessionId: session,
    lastTurn: 4,
    sealed: [{ turn: 1, human: ['a'], assistant: [] }, { turn: 2, human: ['b'], assistant: [] }],
    notes: [{ id: 'NT-1', source: 'auto', gen: 'llm', status: 'active', head: '本对话的便签', body: 'b', born_turn: 1, heat: [3, 4], vector: [1, 0] }],
  }))
  const mine = T.poolPayloadForSession(session, cfg)
  check('会话绑定：取到本会话的池', mine && mine.key === key && mine.notes.length === 1 && mine.empty !== true,
    'key=' + (mine && mine.key) + ' notes=' + (mine && mine.notes.length))
  check('会话绑定：载荷含热度分与封存轮数', mine && typeof mine.notes[0].heatNow === 'number' && mine.sealed === 2,
    'heatNow=' + (mine && mine.notes[0] && mine.notes[0].heatNow) + ' sealed=' + (mine && mine.sealed))
  check('会话绑定：载荷带 sessionId（供前端核对）', mine && mine.sessionId === session, mine && mine.sessionId)
  const other = T.poolPayloadForSession('sess-never-existed', cfg)
  check('会话绑定：无池会话返回空态而非 404 数据', other && other.empty === true && Array.isArray(other.notes) && other.notes.length === 0,
    'empty=' + (other && other.empty) + ' key=' + (other && other.key))
  check('会话绑定：空态 key 仍是该会话的池键', other && other.key === K('sess-never-existed'), other && other.key)
}

/* 赛马门槛（管理员 2026-10-01）：缓存满 poolSize 篇后才开始赛马——池未满一个都不淘汰 */
{
  const session = 'sess-race-gate'
  const key = K(session)
  const pool = T.loadPool(key, session)
  const mk = (i) => ({ id: 'NT-' + i, source: 'auto', gen: 'llm', status: 'active', head: '便签' + i, body: 'b', born_turn: i, heat: [] })
  // 塞满 9 篇（< poolSize=10）：再来一篇不得触发淘汰
  for (let i = 1; i <= 9; i++) pool.notes.push(mk(i))
  const r9 = await T.addNoteToPool(pool, { head: '第10篇', body: 'b', source: 'manual' }, cfg, 10)
  check('赛马门槛：池未满（9→10）不淘汰', r9.ok === true && pool.notes.length === 10 && !r9.evicted,
    'notes=' + pool.notes.length + ' evicted=' + (r9.evicted ? r9.evicted.id : '无'))
  // 第 11 篇：池已满 10 → 赛马启动，淘汰一篇，池保持 10
  const r11 = await T.addNoteToPool(pool, { head: '第11篇', body: 'b', source: 'manual' }, cfg, 11)
  const retiredCount = T.loadRetired(key).length
  check('赛马门槛：满 10 后第 11 篇触发赛马', r11.ok === true && !!r11.evicted && pool.notes.length === 10 && retiredCount >= 1,
    'evicted=' + (r11.evicted ? r11.evicted.id : '无') + ' notes=' + pool.notes.length + ' retired=' + retiredCount)
  // 清理本测试产生的回收站文件，避免污染其他用例
  try { fs.rmSync(path.join(poolsDir, key + '.retired.jsonl'), { force: true }) } catch {}
}

/* 设置读写：settingsWrite 只动 llmApi* 三键、其余键保留；有备份；settingsRead 掩码 */
{
  const liubianDir = path.join(HOME, 'liubian')
  fs.mkdirSync(liubianDir, { recursive: true })
  const file = path.join(liubianDir, 'config.json')
  fs.writeFileSync(file, JSON.stringify({ liubianRoot: 'C:/x', workspace: '工作组', memoryScript: 'm.py', llmApiUrl: 'https://old.example/v1', llmApiKey: 'OLDKEY', llmApiModel: 'old-model' }, null, 2), 'utf8')
  const w = T.settingsWrite({ llmApiUrl: 'https://new.example/v1', llmApiKey: 'NEWKEY', llmApiModel: 'new-model' })
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  const baks = fs.readdirSync(liubianDir).filter((f) => f.startsWith('config.json.bak-notes-settings-'))
  check('设置写：返回 ok 且三键更新', !!(w && w.ok === true)
    && after.llmApiUrl === 'https://new.example/v1' && after.llmApiKey === 'NEWKEY' && after.llmApiModel === 'new-model',
    JSON.stringify({ ok: w && w.ok, url: after.llmApiUrl, key: after.llmApiKey, model: after.llmApiModel }))
  check('设置写：其余键保留（单一来源文件不被破坏）',
    after.liubianRoot === 'C:/x' && after.workspace === '工作组' && after.memoryScript === 'm.py', '')
  check('设置写：留有备份', baks.length >= 1, baks.join(','))
  const rd = T.settingsRead()
  check('设置读：Key 只回掩码', rd.llmKeySet === true && rd.llmApiKeyMasked.indexOf('NEWKEY') < 0 && rd.llmApiKeyMasked.includes('…'),
    'masked=' + rd.llmApiKeyMasked)
  // 掩码回写防护：把掩码当 key 保存不应覆盖真实 key
  const w2 = T.settingsWrite({ llmApiKey: rd.llmApiKeyMasked })
  const after2 = JSON.parse(fs.readFileSync(file, 'utf8'))
  check('设置写：掩码不覆盖真实 Key（空/掩码不落盘）', !!(w2 && w2.ok === true) && after2.llmApiKey === 'NEWKEY', 'key=' + after2.llmApiKey)
  /* v0.5.3 回归：测试连接必须取**原文 Key**（原先误用掩码读取 → 已配置却报「缺少 API Key」） */
  const raw = T.settingsRaw()
  check('测试连接取原文 Key（不再误用掩码）', raw.llmApiKey === 'NEWKEY', 'raw=' + (raw.llmApiKey ? '有' : '无'))
  /* 设置写入不受 disposed 影响（守卫只该管写池）——本进程未 apply，disposed 默认为 false，
   * 这里直接断言函数体内不再引用 disposed：源码级护栏（被重新加回即失败）。 */
  const implSrc = fs.readFileSync(path.join(ROOT, 'lib', 'impl.mjs'), 'utf8')
  const swBody = implSrc.slice(implSrc.indexOf('export function settingsWrite'), implSrc.indexOf('export async function settingsTest'))
  check('设置写入不再受 disposed 守卫（路由被旧代实例持有时也能保存）', swBody.indexOf('disposed') < 0,
    swBody.indexOf('disposed') < 0 ? '无 disposed 引用 ✓' : '仍引用 disposed ✗')
  /* 🟠-6 源码级护栏：disposed 拒绝落盘必须**告警**（事故：静默拒绝 → 便签 2 小时未落盘而日志无异常） */
  check('disposed 拒绝落盘会告警（不再静默）',
    implSrc.indexOf('warnDisposedOnce') > 0
    && /if \(disposed\) \{ warnDisposedOnce\('savePool'\)/.test(implSrc)
    && /if \(disposed\) \{ warnDisposedOnce\('saveRetired'\)/.test(implSrc)
    && /if \(disposed\) \{ warnDisposedOnce\('session\/event 采集'\)/.test(implSrc),
    'savePool/saveRetired/采集 三处均告警')
  /* 设置写失败必须回传精确原因（不再只给「详见宿主日志」） */
  check('设置写失败回传精确 error', /sendJson\(res, 500, \{ error: '写入失败：'/.test(implSrc), '路由含精确 error 回传')
}

/* 🟠-7 跨代接管：重激活时先释放上一代持有的路由；注册抛 duplicate 也不冒泡（冒泡会打挂整次激活） */
{
  const calls = []
  let oldReleased = false
  globalThis.__liubianNotesShared = globalThis.__liubianNotesShared
    || { locks: new Map(), aggregateInFlight: new Set(), lastInjectedTurn: new Map(), routeOff: null }
  globalThis.__liubianNotesShared.routeOff = () => { oldReleased = true }
  const fakeWs = { register: () => { calls.push('register'); return () => { calls.push('off') } } }
  const mkCtx = (ws) => ({
    /* effect 立即执行并立即清理：清掉重试定时器，测试不必等待 */
    effect: (fn) => { const c = fn(); if (typeof c === 'function') c(); return () => {} },
    logger: { info() {}, warn() {} },
    reflect: { get: () => ws },
  })
  let threw = null
  try { impl.mountPanelRoutes(mkCtx(fakeWs), cfg) } catch (e) { threw = e }
  check('跨代接管：先释放上一代持有的路由再注册', oldReleased === true && calls[0] === 'register', 'calls=' + calls.join(','))
  check('路由挂载不抛（异常不再打挂整次激活）', !threw, threw ? String(threw.message) : '无异常 ✓')
  const dupWs = { register: () => { throw new Error('webserver: duplicate exact route "/api/liubian-notes"') } }
  let threw2 = null
  try { impl.mountPanelRoutes(mkCtx(dupWs), cfg) } catch (e) { threw2 = e }
  check('duplicate 路由异常被吞（改为重试+告警）', !threw2, threw2 ? String(threw2.message) : '已吞 ✓')
}

/* M4 回归：封存过滤与双口径 */
{
  const p = { meta: { rounds: 0, humanRounds: 0, humanChars: 0, assistantChars: 0 } }
  T.bumpStats(p, { human: [], assistant: ['唤醒'] })
  T.bumpStats(p, { human: ['人问'], assistant: ['答'] })
  check('M4 回归：双口径', p.meta.rounds === 2 && p.meta.humanRounds === 1, JSON.stringify(p.meta))
  check('M4 回归：非人类轮不入窗', T.shouldSealTurn({ human: [] }) === false && T.shouldSealTurn({ human: ['x'] }) === true, '')
}

/* 🔴-9（v0.5.7）：工具面默认池＝调用方会话——绝不回落到「最后活跃池」
 * 反向对照：改前必须先复现串池。现场脚本 E:\DSH_data\中枢\notes-leak-repro.mjs 已复现两处：
 *   ① 不带 session 的 stick 落进别的会话池；② **即使传了 exec 也照样串**——包装只接一个形参。 */
{
  const victim = 'sess-fix-leak-victim'
  const caller = 'sess-fix-leak-caller'
  const vk = K(victim), ck = K(caller)
  writePool(vk, basePool(vk, { sessionId: victim }))
  /* ① 让 victim 成为「最后活跃」：显式 session 的写路径正是 pre-step 之外唯一刷新那枚全局指针的地方 */
  await T.noteToolAction(cfg, { action: 'stick', head: '受害者自己的', body: 'b', session: victim }, null)
  const vSeed = JSON.parse(readPlain(vk)).notes.length
  /* ② 调用方带 exec、不带 session → 必须落 caller 自己池，绝不碰 victim */
  const fakeExec = { agent: { session: { id: caller } } }
  await T.noteToolAction(cfg, { action: 'stick', head: '调用方自己的', body: 'b' }, null, fakeExec)
  const vAfter = JSON.parse(readPlain(vk)).notes.length
  check('🔴-9 不带 session 不写进别人池（无串池）', vAfter === vSeed, 'victim ' + vSeed + '→' + vAfter + '（期望不变）')
  let cPool = null
  try { cPool = JSON.parse(readPlain(ck)) } catch { /* 未建池 */ }
  check('🔴-9 落进调用方自己的池', !!cPool && cPool.notes.length === 1 && cPool.sessionId === caller,
    'caller 池=' + (cPool ? cPool.notes.length : '无'))
  /* ③ B 档：既无显式 session 又无调用方上下文 → 明确报错，不回落到 victim */
  const noCtx = await T.noteToolAction(cfg, { action: 'list' }, null)
  check('🔴-9 无会话上下文 → 明确报错（B 档）', /无法解析调用方会话/.test(noCtx), String(noCtx).slice(0, 34))
  /* ④ 显式 session 仍优先于调用方会话 */
  const explicitOut = await T.noteToolAction(cfg, { action: 'list', session: victim }, null, fakeExec)
  check('🔴-9 显式 session 优先', explicitOut.indexOf('池 ' + vk) === 0, String(explicitOut).split('\n')[0])
  /* ⑤ 源码级护栏：包装必须转发第 2 形参（旧包装只接 args → 整条链全废） */
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'impl.mjs'), 'utf8')
  check('🔴-9 工具包装转发 exec', /async execute\(args, exec\)/.test(src)
    && /noteToolAction\(cfg, args \|\| \{\}, ctx\.logger, exec\)/.test(src), 'execute 第 2 形参已转发')
  /* ⑥ 源码级护栏（玉簪 ③）：旧机制必须彻底消失，防复活——0 引用，含注释 */
  const leftover = ['lastActiveKey', 'lastActiveSessionId', 'touchActive', 'defaultKey'].filter((w) => src.indexOf(w) >= 0)
  check('🔴-9 last-active 链已彻底移除（0 引用，含注释）', leftover.length === 0, '残留=' + (leftover.join('/') || '无'))
}

/* v0.6.0-a：任何形式的唤醒都算一轮（撤回 M4 的「只收含人类内容的轮」） */
{
  check('v0.6.0 唤醒轮入窗（assistant-only）', T.shouldSealTurn({ turn: 1, human: [], assistant: ['答'] }) === true, '')
  check('v0.6.0 人类轮入窗', T.shouldSealTurn({ human: ['问'], assistant: [] }) === true, '')
  check('v0.6.0 空轮/坏值不入窗', T.shouldSealTurn({ human: [], assistant: [] }) === false && T.shouldSealTurn(null) === false, '')
  check('v0.6.0 全唤醒窗不空头（回退头取答首行）',
    T.buildAutoHead([{ turn: 1, human: [], assistant: ['我在处理被炉的消息'] }]).indexOf('（空窗口）') < 0, '')
  /* maybeAggregate：全唤醒窗也能凑满 R。用 noteLlmGen=false 走拼接回退，不碰网络。 */
  const s = 'sess-v060-wake-window'
  const k = K(s)
  const turns = Array.from({ length: 5 }, (_, i) => ({ turn: i + 1, human: [], assistant: ['唤醒应答 ' + (i + 1)], tools: [] }))
  T.savePool(basePool(k, { sessionId: s, sealed: turns }))
  const made = await T.maybeAggregate(T.loadPool(k, s), Object.assign({}, cfg, { noteLlmGen: false }), 5, null)
  check('v0.6.0 全唤醒窗凑满 R 即聚合（不再被丢弃）', made >= 1, 'made=' + made)
}

/* v0.6.0-b：unqueue —— queued 原本单向态，这是唯一缓存一致的修复路径 */
{
  const s = 'sess-v060-unqueue'
  const k = K(s)
  T.savePool(basePool(k, {
    sessionId: s,
    notes: [{ id: 'NT-1', source: 'auto', status: 'queued', head: 'h1', body: 'b1', born_turn: 1, heat: [] }],
  }))
  fs.mkdirSync(path.dirname(T.pendingPromotionsFile()), { recursive: true })
  fs.writeFileSync(T.pendingPromotionsFile(),
    JSON.stringify({ queued_at: 'x', session_key: k, id: 'NT-1', head: 'h1', workspace: '中枢', tags: ['便签升格'] }) + '\n', 'utf8')
  await T.noteToolAction(cfg, { action: 'unqueue', id: 'NT-1', session: s }, null)
  check('v0.6.0 unqueue：池内 queued→active', T.loadPool(k, s).notes[0].status === 'active',
    'status=' + T.loadPool(k, s).notes[0].status)
  check('v0.6.0 unqueue：pending 队列条目已摘除', T.pendingHasId(k, 'NT-1') === false, '')
  const again = await T.noteToolAction(cfg, { action: 'unqueue', id: 'NT-1', session: s }, null)
  check('v0.6.0 unqueue 幂等（再调只回跳过）', /跳过/.test(again) && T.loadPool(k, s).notes[0].status === 'active', String(again).slice(0, 22))
  T.loadPool(k, s).notes[0].status = 'submitted'
  const refused = await T.noteToolAction(cfg, { action: 'unqueue', id: 'NT-1', session: s }, null)
  check('v0.6.0 unqueue：已固化拒绝退回', /拒绝/.test(refused) && T.loadPool(k, s).notes[0].status === 'submitted', String(refused).slice(0, 22))
}

/* v0.6.1：便签 ID 必须连续——旧公式 seq = notes.length + 1 + taken.size 重复计数，
 * 导致 ID 只会是奇数（全库实证 NT-1/3/5/7/9）。 */
{
  const s = 'sess-v061-idseq'
  const k = K(s)
  T.savePool(basePool(k, { sessionId: s }))
  const cfgNoLlm = Object.assign({}, cfg, { noteLlmGen: false })
  const p = T.loadPool(k, s)
  await T.addNoteToPool(p, { head: 'AIC 视频高光训练进度与判据汇总', body: 'b', source: 'manual' }, cfgNoLlm, 1)
  await T.addNoteToPool(p, { head: '云端 LoRA 停训与复现对比结论', body: 'b', source: 'manual' }, cfgNoLlm, 2)
  await T.addNoteToPool(p, { head: '样本生成与混合臂出件估算', body: 'b', source: 'manual' }, cfgNoLlm, 3)
  const ids = T.loadPool(k, s).notes.map(n => n.id).join(',')
  check('v0.6.1 便签 ID 连续（不再只有奇数）', ids === 'NT-1,NT-2,NT-3', 'IDs=' + ids)
  /* 反向对照：已有号被占用时必须避让，不得撞号 */
  const p2 = T.loadPool(k, s)
  const taken = new Set(p2.notes.map(n => n.id))
  check('v0.6.1 反向对照：占用号被避让（本轮 IDs 无重复）', taken.size === p2.notes.length, 'n=' + p2.notes.length)
}

/* v0.6.2：回合标识必须是真实轮次，不能再是「人类消息条数」（它恒为 1 → 注入被永久抑制、
 * 热度全记成 1、born_turn 恒为 1）。这类"接线错了"用源码级护栏最省且最准。 */
{
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'impl.mjs'), 'utf8')
  check('v0.6.2 pre-step 用 turnToken（真实轮次）', /const turnToken = Math\.max\(/.test(src)
    && /scheduleAggregate\(ctx, cfg, sessionId, pool, turnToken\)/.test(src)
    && /pool\.lastTurn !== turnToken/.test(src), 'turnToken 已接线')
  check('v0.6.2 去重与热度也走 turnToken', /injectionAlreadyDone\(key, turnToken\)/.test(src)
    && /markInjectionDone\(key, turnToken\)/.test(src)
    && /injectionBlock\(pool, cfg, composeQueryText\(prompt, prev\), turnToken\)/.test(src), '三处已换')
  /* 反向对照：旧接线必须彻底消失（含 humanCount 变量本身——死变量是下一个地雷） */
  check('v0.6.2 反向对照：旧 humanCount 接线已清除',
    src.indexOf('humanCount') < 0, 'humanCount 残留=' + (src.indexOf('humanCount') >= 0 ? '有' : '无'))
  /* token 语义：同轮内稳定、跨轮递增——用真函数钉一次口径 */
  const p = T.loadPool('v062-token-probe', 's-v062')
  const tk1 = Math.max(Number(p.current && p.current.turn) || 0, (Number(p.meta && p.meta.rounds) || 0) + 1)
  p.meta.rounds = 7
  const tk2 = Math.max(Number(p.current && p.current.turn) || 0, (Number(p.meta && p.meta.rounds) || 0) + 1)
  check('v0.6.2 token 随完成轮次递增', Number.isFinite(tk1) && tk2 > tk1, 'tk1=' + tk1 + ' tk2=' + tk2)
}

/* 🔴-8 真行为回归（**放在最后**：它会真的 apply 并最终 dispose，之后本进程不再能落盘）：
 * `ctx.effect(fn)` 的 fn 是「立即执行」的注册面，f返回的函数才是清理器。
 * 旧 bug：`disposed = true` 写在 fn 体里 → 实例**挂载瞬间即自我标记已卸载** →
 * 此后所有 savePool/saveRetired 被自家守卫拒绝（日志照打「轮封存」、聚合照跑，便签却不落盘；
 * 线上 14:44→17:38 池文件停更数小时，且重启无效——新实例同样生来 disposed）。 */
{
  const session = 'sess-apply-live'
  const key = K(session)
  const cleanups = []
  let routeMounted = 0
  const ctxStub = {
    /* 真框架语义：effect 体立即执行，返回值是清理器 */
    effect: (fn) => { const c = fn(); if (typeof c === 'function') cleanups.push(c); return () => {} },
    on: () => () => {},
    logger: { info() {}, warn() {}, error() {} },
    reflect: { get: () => ({ register: () => { routeMounted += 1; return () => {} } }) },
    tools: { register: () => () => {} },
  }
  let applyThrew = null
  try { impl.apply(ctxStub, {}) } catch (e) { applyThrew = e }
  check('apply 可挂载（桩 ctx，框架 effect 语义）', !applyThrew && routeMounted >= 1,
    applyThrew ? String(applyThrew.message) : '路由挂载 ' + routeMounted + ' 次')
  const pool = T.loadPool(key, session)
  pool.notes.push({ id: 'NT-1', source: 'auto', gen: 'llm', status: 'active', head: 'h', body: 'b', born_turn: 1, heat: [] })
  const wrote = T.savePool(pool)
  check('★ apply 后实例未自我标记卸载（落盘必须真能写）', wrote === true && fs.existsSync(path.join(poolsDir, key + '.json')),
    'savePool=' + wrote + ' 文件=' + fs.existsSync(path.join(poolsDir, key + '.json')))
  /* 反向：真卸载后必须拒写（守卫本身仍然有效） */
  for (const c of cleanups) { try { c() } catch { /* 清理器可能重复调用 */ } }
  const afterDispose = T.savePool(T.loadPool(key, session))
  check('★ 真卸载后确实拒写（守卫仍有效）', afterDispose === false, 'savePool=' + afterDispose)
}

const bad = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.name + (r.detail ? '   [' + r.detail + ']' : ''))
console.log('')
console.log((bad.length ? 'FAIL' : 'ALL PASS') + `  ${results.length - bad.length}/${results.length}`)
process.exit(bad.length ? 1 : 0)
