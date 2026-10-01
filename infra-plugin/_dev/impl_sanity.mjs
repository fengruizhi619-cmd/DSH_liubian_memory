#!/usr/bin/env node
/**
 * infra impl 只读函数体检（监察要求：解析类改动必须配可运行检查，不能只 node --check）。
 * 经 profile junction 导入 impl.mjs——bare specifier 沿 profile node_modules 解析，与运行时同构。
 * 全部被测函数只读（tasklist / netstat / Get-Process），不启停任何进程。
 *
 * 用法：node impl_sanity.mjs   （全部通过 exit 0，任何一项失败 exit 1）
 */
const IMPL_URL = 'file:///C:/Users/Feng/.dsh/profiles/desktop/node_modules/dsh-liubian-infra/lib/impl.mjs'
const PORT = 8082

const m = await import(IMPL_URL)
let pass = 0, fail = 0
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? '｜' + detail : ''}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? '｜' + detail : ''}`) }
}

console.log(`被测模块: ${IMPL_URL}`)

// 1. 导出面
t('导出面：ensureInFlow / watchdogTick / serverPids / establishedOnPort 均为函数',
  typeof m.ensureInFlow === 'function' && typeof m.watchdogTick === 'function' &&
  typeof m.serverPids === 'function' && typeof m.establishedOnPort === 'function')

// 2. serverPids 正例：llama-server 此刻应存活（健康环境前置）
const pids = m.serverPids('llama-server.exe')
t('serverPids 正例：llama-server.exe ≥ 1 个存活 PID', Array.isArray(pids) && pids.length >= 1, `pids=[${pids}]`)

// 3. serverPids 负例：不存在的映像名 → 空数组（tasklist 的 INFO 行不能被误解析成 PID）
const none = m.serverPids('definitely-not-a-real-image-xyz.exe')
t('serverPids 负例：不存在映像 → []', Array.isArray(none) && none.length === 0, `got=${JSON.stringify(none)}`)

// 4. establishedOnPort 返回非负整数
const est = m.establishedOnPort(PORT)
t(`establishedOnPort(${PORT}) 返回非负整数`, Number.isInteger(est) && est >= 0, `got=${est}`)

// 5. listeningPid > 0，且与 serverPids 交叉一致（同一进程的两个读取器）
const lpid = m.listeningPid(PORT)
t(`listeningPid(${PORT}) > 0`, lpid > 0, `got=${lpid}`)
t('交叉一致：监听 PID ∈ serverPids 列表', pids.includes(lpid), `listen=${lpid} pids=[${pids}]`)

// 6. 第二读取器交叉验证（§8：别只信一条读取路径）——PowerShell 独立取监听 PID
const psOut = (await import('node:child_process')).execSync(
  `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${PORT} -State Listen | Select-Object -First 1).OwningProcess"`,
  { encoding: 'utf-8', windowsHide: true, timeout: 30000 })
const psPid = Number(String(psOut).trim())
t('双读取器：netstat 判 PID ≡ Get-NetTCPConnection 判 PID', psPid === lpid, `netstat=${lpid} pwsh=${psPid}`)

// 7. privateCommitMb 对活进程返回正数；对 0/死 PID 返回 0
const mb = m.privateCommitMb(lpid)
t(`privateCommitMb(${lpid}) > 0`, mb > 0, `got=${mb.toFixed(0)}MB`)
t('privateCommitMb(0) === 0（无效输入护栏）', m.privateCommitMb(0) === 0)

console.log(`\n汇总：通过 ${pass}｜失败 ${fail}`)
process.exit(fail ? 1 : 0)
