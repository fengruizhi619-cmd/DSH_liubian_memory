#!/usr/bin/env node
/**
 * 流变·基建 · profile `link:` junction 体检 / 修复
 * ─────────────────────────────────────────────────────────────
 * 用途：替代 dsh-super-injector 的 healProfileLinks（该插件退役后 junction 失去自愈者）。
 *       按 profile `package.json` 的 `link:` 声明，逐条核对 node_modules 下 junction 的
 *       「存在 + 指向正确 + 可解析（透过链接真能读到 package.json）」三态。
 *
 * 用法：
 *   node heal-links.mjs                      # 只体检，不改动
 *   node heal-links.mjs --fix                # 修复 MISSING / WRONG（重建 junction）
 *   node heal-links.mjs --profile desktop    # 指定 profile（默认 desktop）
 *
 * 安全语义（与注入器补丁 #7 同源）：
 *   指向**正确**目标但"暂时不可读"（瞬时锁 / 对端在写）→ **绝不 rm**，只报 SUSPECT。
 *   只有「不存在」或「指向错误」才在 --fix 下重建。
 *
 * 判据纪律（§8）：不看 Test-Path 一类表象——一律走 lstat / readlink / realpath /
 *   透过链接真读 package.json 的**解析级**验证。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const argv = process.argv.slice(2)
const FIX = argv.includes('--fix')
const pi = argv.indexOf('--profile')
const PROFILE = pi >= 0 ? argv[pi + 1] : 'desktop'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(DSH_HOME, 'profiles', PROFILE)
const nmDir = join(profileDir, 'node_modules')
const pkgFile = join(profileDir, 'package.json')

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

/** 透过链接真读 package.json —— 解析级成功的唯一判据 */
function resolvesThrough(link, expectedTarget) {
  try {
    const pj = readJson(join(link, 'package.json'))
    if (!pj) return { ok: false, why: 'package.json 不可读/非 JSON' }
    let real
    try { real = realpathSync(link) } catch { real = null }
    let want = null
    try { want = realpathSync(expectedTarget) } catch { want = null }
    if (real && want && real.toLowerCase() !== want.toLowerCase()) return { ok: false, why: `指向 ${real}（应为 ${want}）` }
    return { ok: true, name: pj.name }
  } catch (e) {
    return { ok: false, why: String(e && e.message || e).slice(0, 60) }
  }
}

const pkg = readJson(pkgFile)
if (!pkg) {
  console.error(`❌ 读不到 profile package.json: ${pkgFile}`)
  process.exit(2)
}

const deps = pkg.dependencies || {}
const links = Object.entries(deps).filter(([, v]) => typeof v === 'string' && v.startsWith('link:'))
const files = Object.entries(deps).filter(([, v]) => typeof v === 'string' && v.startsWith('file:'))

console.log(`profile = ${PROFILE}`)
console.log(`link: 声明 ${links.length} 条｜file: 声明 ${files.length} 条（file 只报告不修）\n`)

let ok = 0, missing = 0, wrong = 0, suspect = 0, fixed = 0, targetGone = 0
const rows = []

for (const [name, spec] of links) {
  const target = resolve(profileDir, spec.slice('link:'.length))
  const link = join(nmDir, ...name.split('/')) // 支持 @scope/name

  let state, detail = ''
  if (!existsSync(target)) {
    state = '目标目录不存在'
  } else {
    let st = null
    try { st = lstatSync(link) } catch { st = null }
    if (!st) { state = 'MISSING' }
    else {
      const r = resolvesThrough(link, target)
      if (r.ok) { state = 'OK' }
      else if (/不可读/.test(r.why)) { state = 'SUSPECT'; detail = r.why }
      else if (/指向/.test(r.why)) { state = 'WRONG'; detail = r.why }
      else { state = 'SUSPECT'; detail = r.why }
    }
  }

  if (FIX && (state === 'MISSING' || state === 'WRONG')) {
    try {
      if (existsSync(link)) rmSync(link, { recursive: true, force: true })
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(target, link, 'junction')
      const r2 = resolvesThrough(link, target)
      if (r2.ok) { state = 'FIXED' }
      else { state = 'FIX-FAILED'; detail = r2.why }
    } catch (e) {
      state = 'FIX-FAILED'; detail = String(e && e.message || e).slice(0, 60)
    }
  }
  rows.push([name, state, detail])
}

/* 汇总以**最终状态**为唯一真相（不再增量计数——曾因此出现"修好了仍报 MISSING 且 exit 1"的假阴性） */
for (const [, s] of rows) {
  if (s === 'OK') ok++
  else if (s === 'FIXED') fixed++
  else if (s === 'MISSING') missing++
  else if (s === 'WRONG') wrong++
  else if (s === 'SUSPECT') suspect++
  else if (s === '目标目录不存在') targetGone++
  else missing++ /* FIX-FAILED 计入待修 */
}

const w = Math.max(...rows.map(r => r[0].length), 4)
for (const [n, s, d] of rows) console.log(`  ${n.padEnd(w)}  ${s}${d ? '  — ' + d : ''}`)

console.log(`\n汇总：OK ${ok}｜FIXED ${fixed}｜MISSING ${missing}｜WRONG ${wrong}｜SUSPECT ${suspect}｜目标目录缺失 ${targetGone}`)
if (FIX === false && (missing || wrong)) console.log('（加 --fix 可重建 MISSING/WRONG；SUSPECT 一律不 rm，人工确认）')
if (!FIX && files.length) {
  console.log('\nfile: 声明（由包管理器安装，非 junction；只报告）:')
  for (const [name] of files) {
    const p = join(nmDir, ...name.split('/'))
    console.log(`  ${name.padEnd(w)}  ${existsSync(p) ? '在' : '缺失'}`)
  }
}
process.exit(missing || wrong || suspect || targetGone ? 1 : 0)
