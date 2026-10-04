/** v0.7.3 定向验证（判据 2/3：_meta 三态 + 三元组摘除；不依赖 8082）
 *  $env:DSH_HOME='<隔离目录>'; node notes-v073-check.mjs
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
const file = T.pendingPromotionsFile()
const readLines = () => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())

/* 判据 2a：新文件 → 首写即带 _meta，且 meta 行不带 id */
T.appendPending({ session_key: 'aaa11111', id: 'NT-1', queued_at: '2026-10-03T00:00:00Z', sent: true, bid: 1 })
const l1 = readLines()
let meta = null
try { meta = JSON.parse(l1[0]) } catch {}
check('2a 新文件首行 = _meta（schema/version 齐全）',
  meta && meta._meta === true && meta.schema === 'pending-promotions' && meta.version === 1, JSON.stringify(meta))
check('2a _meta 行不带 id（§7 #19）', meta && meta.id === undefined, '')

/* 判据 2b：存量文件无 meta → 宿主内补插，原行无损 */
fs.writeFileSync(file, [
  JSON.stringify({ session_key: '022e38e8', id: 'NT-16', queued_at: '2026-10-02T17:06:10.500Z', sent: true, bid: 47, head: '重建条' }),
  JSON.stringify({ session_key: '022e38e8', id: 'NT-16', queued_at: '2026-10-02T18:45:40.251Z', sent: true, bid: 56, head: '图像塔诊断' }),
  '',
].join('\n'))
T.appendPending({ session_key: 'bbb22222', id: 'NT-2', queued_at: '2026-10-03T01:00:00Z', sent: true, bid: 2 })
const l2 = readLines()
let meta2 = null
try { meta2 = JSON.parse(l2[0]) } catch {}
const kept47 = l2.some((l) => l.includes('"bid":47'))
const kept56 = l2.some((l) => l.includes('"bid":56'))
check('2b 存量补插：首行变 _meta', meta2 && meta2._meta === true, '')
check('2b 补插不丢原行（bid47/bid56 都在）', kept47 && kept56, `47=${kept47} 56=${kept56}`)

/* 判据 2c：读侧容忍 meta 行（pendingEntry / pendingHasId 正常） */
check('2c 读侧容忍 _meta：pendingEntry 命中 NT-16(56)',
  (() => { const e = T.pendingEntry('022e38e8', 'NT-16'); return e && e.bid === 56 })(), '')
check('2c pendingHasId 正常', T.pendingHasId('bbb22222', 'NT-2') === true, '')

/* 判据 3：三元组摘除——同 id 两条，只删命中 queued_at 的那条 */
const removed = T.removePendingEntry('022e38e8', 'NT-16', '2026-10-02T18:45:40.251Z')
const l3 = readLines()
const still47 = l3.some((l) => l.includes('"bid":47'))
const gone56 = !l3.some((l) => l.includes('"bid":56'))
check('③ 三元组摘除：只删命中行（removed=1）', removed === 1, 'removed=' + removed)
check('③ 反向对照（真事故数据）：bid=47 历史条目无损、bid=56 已摘', still47 && gone56, `47=${still47} 56=${gone56}`)
const e47 = T.pendingEntry('022e38e8', 'NT-16')
check('③ 摘后 pendingEntry 回退到幸存条（bid=47）', e47 && e47.bid === 47, '')

/* 老调用形态（不给 queued_at）仍在：无该 id 时安全 no-op */
const rm0 = T.removePendingEntry('nope0000', 'NT-404')
check('③ 旧形态兼容：无命中返回 0', rm0 === 0, 'removed=' + rm0)

const bad = out.filter((r) => !r.ok)
for (const r of out) console.log((r.ok ? '  OK ' : '  X  ') + r.n + (r.d ? '   [' + r.d + ']' : ''))
console.log('\n' + (bad.length ? 'FAIL' : 'ALL PASS') + `  ${out.length - bad.length}/${out.length}`)
process.exit(bad.length ? 1 : 0)
