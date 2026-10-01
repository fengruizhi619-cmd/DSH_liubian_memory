/**
 * 封存积压一次性清淤：把各池 sealed 窗口里**已满 R 个人类轮**的积压，现在就走聚合映射成便签。
 *
 * 背景（管理员 2026-10-01）：聚合只在「该会话下一次人类回合」的 pre-step 里触发；
 * 不再活跃的会话，sealed 里的轮次会一直躺着。本脚本代替那次"下一天"把积压映射出来。
 *
 * 安全边界：
 *   - 跳过**当前活跃会话**的池（宿主内的注入实例仍在写它，跨进程并发写会互相覆盖）；
 *   - 🔴-3 修复后，判重拒收的窗口会回补 sealed（不丢料），所以重复运行是安全的；
 *   - 每个满 R 的窗口消耗一次聚合 LLM 调用（真实费用，量小）。
 *
 * 用法：node _dev/drain-sealed.mjs [跳过的池key,逗号分隔]
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SKIP = new Set((process.argv[2] || '2a50f215').split(',').map(s => s.trim()).filter(Boolean))
const url = pathToFileURL('E:/DSH_data/流变系统/dsh-liubian-notes/lib/impl.mjs').href + '?t=' + Date.now()
const T = (await import(url)).__test
const impl = await import(url)

const cfg = T.resolveConfig({})
const dir = T.notesDir()
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : []
const log = (s) => console.log(s)

log(`cfg: R=${cfg.aggregateRounds} 池=${cfg.poolSize} LLM=${cfg.noteLlmGen ? cfg.diaryApiModel : '关(拼接)'}｜跳过池: ${[...SKIP].join(',') || '无'}`)
log('─'.repeat(72))

let totalMade = 0
const report = []
for (const f of files) {
  const key = f.replace(/\.json$/, '')
  if (SKIP.has(key)) { log(`[跳过] ${key}（活跃会话，由在线实例自行聚合）`); continue }
  let pool
  try { pool = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, '')) } catch (e) { log(`[跳过] ${key}（读取失败：${e.message}）`); continue }
  const humanInSealed = (pool.sealed || []).filter(t => t && Array.isArray(t.human) && t.human.length > 0).length
  if (humanInSealed < cfg.aggregateRounds) {
    log(`[跳过] ${key}（sealed 人类轮 ${humanInSealed}/${cfg.aggregateRounds}，不足一窗）`)
    continue
  }
  const before = (pool.notes || []).length
  // 独立进程内跑 maybeAggregate（🟠-3：与宿主实例不共享锁——因此跳过活跃会话是硬前提）
  const made = await impl.maybeAggregate(pool, cfg, Number(pool.lastTurn) || humanInSealed, {
    info: (s) => log('    ' + s),
    warn: (s) => log('    ⚠ ' + s),
  })
  const after = (pool.notes || []).length
  totalMade += made
  report.push({ key, made, before, after, sealedLeft: (pool.sealed || []).length })
  log(`[完成] ${key}：新增 ${made} 篇（${before} → ${after}），sealed 剩 ${pool.sealed.length}`)
}

log('─'.repeat(72))
log(`合计新增便签：${totalMade} 篇（涉及 ${report.length} 个池）`)
