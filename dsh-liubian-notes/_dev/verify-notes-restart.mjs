#!/usr/bin/env node
/**
 * 便签重启后验证台（一次跑完，输出判读表）
 *
 * 背景：注入器 #5–#10 与便签 v0.3.x 中的一部分属「磁盘态」——需宿主重启才生效。
 * 本脚本把「我的验证清单」脚本化，避免重启后现场手搓、口径漂移。
 *
 * 用法：
 *   node _dev/verify-notes-restart.mjs                  # 读今天的宿主日志
 *   node _dev/verify-notes-restart.mjs <日志路径>        # 指定日志
 *
 * 判读原则（当天定的纪律）：
 *   - 行为事实（文件/计数）优先于措辞证据（日志文字）；
 *   - 「没出现」只在判据本身是条件性的时候按「未触发」读，不按「失败」读。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const argLog = process.argv[2]
const today = new Date().toISOString().slice(0, 10)
const logPath = argLog || path.join(os.homedir(), 'AppData', 'Roaming', 'DSH Desktop', 'logs', 'host', `dsh-${today}.log`)
const patchPath = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')

const rows = []
const say = (name, value, verdict) => rows.push({ 判据: name, 观测: value, 判定: verdict })

let log = ''
try { log = fs.readFileSync(logPath, 'utf8') } catch { log = '' }
const lines = log.split('\n')
const grep = (re) => lines.filter((l) => re.test(l))

say('日志文件可读', log ? `${logPath}（${(log.length / 1024).toFixed(0)} KB）` : `读不到：${logPath}`, log ? 'ok' : '检查路径')

// A｜便签挂载（版本戳 = 模块真换的行为证据）
const mounts = grep(/dsh-liubian-notes.*已挂载/)
const lastMount = mounts[mounts.length - 1] || ''
const ver = (lastMount.match(/v(\d+\.\d+\.\d+)/) || [])[1] || '(无)'
say('A 便签挂载版本', `${mounts.length} 条，最新 v${ver}｜${lastMount.slice(0, 19)}`, mounts.length ? (ver >= '0.3.2' ? 'PASS' : '旧版（未生效？）') : 'FAIL')

// B｜面板路由
const routes = grep(/面板路由已挂载 \/api\/liubian-notes/)
say('B 面板路由挂载', `${routes.length} 条｜${(routes[routes.length - 1] || '').slice(0, 19)}`, routes.length ? 'PASS' : 'FAIL')

// C｜M4 新封存口径（v0.3.2 起）
const sealIn = grep(/入窗/)
const sealSkip = grep(/跳过（无人类内容）/)
const dual = grep(/humanRounds=\d+/)
say('C1 新口径-跳过非人类轮', `${sealSkip.length} 条`, sealSkip.length ? 'PASS' : '未观测（条件性）')
say('C2 新口径-入窗', `${sealIn.length} 条`, sealIn.length ? 'PASS' : '未观测（条件性）')
say('C3 双口径字段', `${dual.length} 条`, dual.length ? 'PASS' : '未观测（条件性）')

// D｜patch 噪声（清理后应归零；水印 = 2026-10-01 14:03:53）
const noisy = grep(/patch: entry "(dsh-liubian-notes|6c1f1dd2|f2a70c2d|4456ba9f|5ddb9e87)" not found/)
const stamps = noisy.map((l) => l.slice(0, 19)).sort()
say('D 残渣噪声（5 条 id）', `${noisy.length} 条，最后 ${stamps[stamps.length - 1] || '(无)'}`, noisy.length === 0 ? 'PASS' : '检查是否清理后新增')

// E｜#10 行为事实：patch 里便签条目数（应为 0；重启后 uninject 不再写回）
let patchTxt = ''
try { patchTxt = fs.readFileSync(patchPath, 'utf8') } catch {}
const entryCount = (patchTxt.match(/^- id:\s*dsh-liubian-notes\s*$/gm) || []).length
say('E #10 行为判据（patch 便签条目数）', `${entryCount} 条`, entryCount === 0 ? 'PASS（B 判据成立；若刚 uninject 过则同时看回执 A）' : '存在（清一次后复验是否再生）')

// F｜注入器补丁生效判据（条件性：只在对应场景打印）
const jRepair = grep(/junction 已修复（早退前）/)
const coord = grep(/协调分支|coordinate-branch/)
say('F1 #5 junction 提前修复', `${jRepair.length} 条`, jRepair.length ? 'PASS（强证据）' : '未触发（条件性，非失败）')
say('F2 #9 协调分支', `${coord.length} 条`, coord.length ? 'PASS（真双启已发生并被协调）' : '未触发（正常：无双启）')

// G｜#10 回执文本（措辞证据，仅作旁证）
const noWrite = grep(/未写 disabled/)
say('G #10 回执文本（旁证）', `${noWrite.length} 条`, noWrite.length ? '见回执' : '未观测')

const pad = (s, n) => String(s).padEnd(n, ' ')
const pad2 = (s, n) => { const w = [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0); return String(s) + ' '.repeat(Math.max(0, n - w)) }
console.log('便签重启后验证台｜' + new Date().toISOString())
console.log('日志：' + logPath)
console.log('─'.repeat(78))
for (const r of rows) console.log(pad2(r.判据, 30) + '｜' + pad2(r.观测, 26) + '｜' + r.判定)
console.log('─'.repeat(78))
console.log('注：「未触发（条件性）」= 该判据只在特定场景打印，未出现不构成失败；行为判据（A/E）优先于措辞判据（G）。')
