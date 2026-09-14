/**
 * dsh-liubian-embed —— 本地语义向量服务插件
 *
 * llama.cpp llama-server + Qwen3-Embedding-0.6B，端口 8082，
 * 供流变记忆（以及任何需要中文语义向量的插件）做 tag + 语义融合检索。
 *
 * 为什么单独一个插件：向量服务是通用能力，不属于记忆技能。
 * 拆开之后改向量服务不用动记忆插件，反之亦然 —— 只管这份职责：
 *   探活 / 拉起 / 等待就绪 / 关停，外加插件加载时把服务带起来。
 * 检索侧永远只是「HTTP 调不到就回退纯 tag」，不依赖本插件是否在跑。
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

export const PLUGIN_VERSION = '0.1.0'

const HOME = process.env.USERPROFILE || process.env.HOME || 'C:/Users/Feng'
export const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh')

export const DEFAULTS = {
  embedUrl: 'http://127.0.0.1:8082',
  /**
   * 启动方式（2026-09-12 修「时不时冒出来的 cmd 黑框」）：
   *
   * 原来只走 `embedCmd`（cmd.exe /c start_emb.cmd）。脚本里那句
   * `start "" /b llama-server.exe ...` 在**没有控制台可继承**时会**新建一个控制台**
   * 并把窗口显示出来 —— 那一跳是 cmd 内部行为，Node 的 `windowsHide` 管不住它。
   * 实测证据：窗口枚举里长期存在 `VISIBLE E:\llama.cpp\llama-server.exe`。
   *
   * 现在默认**直接起 exe**（不经 cmd、不经 start）：Node 的 `windowsHide: true`
   * 会带上 CREATE_NO_WINDOW，进程无控制台、不闪窗。
   * 想改回脚本方式：把 `launchViaCmd` 设成 true 即可（保留 embedCmd 备份路径）。
   */
  launchViaCmd: false,
  embedCmd: 'E:/llama.cpp/start_emb.cmd',
  serverExe: 'E:/llama.cpp/llama-server.exe',
  serverArgs: [
    '-m', 'E:/llama.cpp/models/qwen3-emb/Qwen3-Embedding-0.6B-Q8_0.gguf',
    '--host', '127.0.0.1', '--port', '8082',
    '-c', '8192', '-ngl', '99', '--embeddings',
  ],
  serverCwd: 'E:/llama.cpp',
  embedPort: 8082,
  /** 插件加载时探活，离线就带起来（不等待）。false 则只能手动 ensure。 */
  autoEnsureOnLoad: true,
  /** ensure 等待就绪的上限（模型首次加载可能更久）。 */
  readyTimeoutMs: 45000,
  probeTimeoutMs: 3000,
  /** 内存看门狗：llama-server 私有提交（PrivateMemorySize64）超过阈值就自动重启。
   *  背景（2026-09-14 实测）：服务跑 5.5h 后私有提交涨到 10.9GB（模型才 ~0.7GB + 8k
   *  KV ~2GB），约 9.1GB 被换出压进 Windows Memory Compression 池、仍占物理内存；
   *  一重启就回落到 2.3GB、压缩池 9.5→0.9GB、释放 9.2GB。看门狗按提交量监控，
   *  超限自动 stop → launch（fire-and-forget，不阻塞；下个周期自然恢复在线检查）。 */
  watchdogEnabled: true,
  watchdogIntervalSec: 300,   // 每多少秒查一次
  watchdogLimitMb: 4096,      // 私有提交超过多少 MB 触发重启
}

export const TOOL_NAME = '_dsh_external_dsh_liubian_embed'

/* ── 配置 ───────────────────────────────────────────────────────────────── */

export function configFile() {
  return join(DSH_HOME, 'liubian', 'embed.json')
}

function readJson(file) {
  try {
    // 剥 BOM：记事本 / Windows PowerShell 写出来的 JSON 都带 BOM，直接 parse 会抛错
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {}
  } catch {
    return {}
  }
}

export function resolveConfig(input = {}) {
  const merged = { ...DEFAULTS, ...readJson(configFile()) }
  const src = input && typeof input === 'object' ? input : {}
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined || v === null || v === '') continue
    merged[k] = v
  }
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = merged[k]
    if (typeof def === 'boolean' && typeof v === 'string') merged[k] = v.trim().toLowerCase() !== 'false'
    if (typeof def === 'number' && typeof v === 'string' && v.trim() !== '') {
      const n = Number(v)
      if (Number.isFinite(n)) merged[k] = n
    }
  }
  return merged
}

function saveConfig(patch) {
  const next = { ...readJson(configFile()), ...patch }
  const file = configFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
  return next
}

/* ── 服务操作 ───────────────────────────────────────────────────────────── */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 探活。任何异常都折算成「离线」，调用方不需要 try/catch。 */
export async function probe(cfg) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.probeTimeoutMs || 3000)
  try {
    const res = await fetch(new URL('/health', cfg.embedUrl), { signal: controller.signal })
    return { ok: res.ok, status: res.status, body: (await res.text()).slice(0, 200) }
  } catch (err) {
    return { ok: false, status: 0, body: (err && err.message) || String(err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 无窗口后台拉起，不等待。
 *
 * 两种方式：
 *   · 默认（launchViaCmd=false）：直接 spawn serverExe。
 *     `windowsHide: true` → CREATE_NO_WINDOW，进程没有控制台，**不会闪黑框**。
 *   · launchViaCmd=true：spawn cmd.exe /c embedCmd（旧路径，保留备用）。
 *     ⚠️ 这条路会闪黑框，因为脚本里的 `start /b` 在无控制台可继承时会新建控制台。
 */
export function launch(cfg) {
  try {
    if (cfg.launchViaCmd) {
      if (!existsSync(cfg.embedCmd)) return `[错误] 未找到启动脚本：${cfg.embedCmd}`
      const child = spawn('cmd.exe', ['/c', cfg.embedCmd], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      return '已启动（脚本方式）'
    }
    const exe = String(cfg.serverExe || '')
    if (!exe || !existsSync(exe)) return `[错误] 未找到 llama-server：${exe}`
    const args = Array.isArray(cfg.serverArgs) ? cfg.serverArgs.map(String) : []
    // detached 故意为 false：带 DETACHED_PROCESS 会被 Node 升级成 CREATE_NEW_CONSOLE，
    // 那样又会冒出窗口。stdio:'ignore' + windowsHide 已足够「无窗后台」。
    const child = spawn(exe, args, {
      cwd: existsSync(String(cfg.serverCwd || '')) ? cfg.serverCwd : undefined,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return '已启动（直起 exe，无窗）'
  } catch (err) {
    return '[错误] ' + ((err && err.message) || String(err))
  }
}

/** 拉起并等到就绪（最多 readyTimeoutMs）。 */
export async function ensureReady(cfg) {
  const before = await probe(cfg)
  if (before.ok) return { ok: true, already: true, body: before.body }
  const launched = launch(cfg)
  if (launched.startsWith('[错误]')) return { ok: false, error: launched }
  const started = Date.now()
  const deadline = started + (Number(cfg.readyTimeoutMs) || 45000)
  for (;;) {
    if (Date.now() > deadline) {
      return { ok: false, pending: true, seconds: Math.round((Date.now() - started) / 1000) }
    }
    await sleep(2000)
    const now = await probe(cfg)
    if (now.ok) return { ok: true, already: false, seconds: Math.round((Date.now() - started) / 1000), body: now.body }
  }
}

/** 找出监听该端口的 PID（只认 LISTENING）。 */
export function listeningPid(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
      encoding: 'utf-8', windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
    })
    for (const line of String(out).split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/)
      // Proto  Local Address  Foreign Address  State  PID
      if (cols.length >= 5 && cols[3] === 'LISTENING' && cols[1].endsWith(':' + port)) {
        const pid = Number(cols[4])
        if (Number.isFinite(pid) && pid > 0) return pid
      }
    }
  } catch {
    /* netstat 不可用就当找不到 */
  }
  return 0
}

/** 关停占用端口的进程（用来释放显存）。 */
export function stopService(cfg) {
  const pid = listeningPid(cfg.embedPort)
  if (!pid) return { ok: true, pid: 0 }
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 20000 })
    return { ok: true, pid }
  } catch (err) {
    return { ok: false, pid, error: (err && err.message) || String(err) }
  }
}

const POWER_SHELL = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

/** 读指定进程的私有提交内存（PrivateMemorySize64，单位 MB）。
 *  这正是 Windows 计入提交额度 / Memory Compression 的那个数 —— 看门狗用它与
 *  阈值比。读不到或进程已死返回 0（调用方当"跳过本轮"处理）。 */
export function privateCommitMb(pid) {
  if (!pid) return 0
  try {
    const out = execFileSync(POWER_SHELL, [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).PrivateMemorySize64`,
    ], { encoding: 'utf-8', windowsHide: true, timeout: 20000, maxBuffer: 1 << 20 })
    const v = Number(String(out || '').trim())
    return Number.isFinite(v) && v > 0 ? v / 1048576 : 0
  } catch {
    return 0
  }
}

/** 冷却用的「按需带起来」：插件加载 / 外部触发都没有阻塞风险。 */
let lastEnsureAt = 0
export function ensureInFlow(cfg, logger, { force = false } = {}) {
  if (!force && !cfg.autoEnsureOnLoad) return
  if (!force && Date.now() - lastEnsureAt < 60000) return
  lastEnsureAt = Date.now()
  void (async () => {
    const before = await probe(cfg)
    if (before.ok) return
    launch(cfg)
    logger?.info?.(`[dsh-embed] 向量服务离线，已在后台拉起（${cfg.launchViaCmd ? '脚本方式' : '直起 exe'}，无窗）`)
  })().catch(() => {})
}

/* ── 内存看门狗 ─────────────────────────────────────────────────────────── */

let lastWatchdogRestart = ''   // 最近一次自动重启的时间 + 前后内存，status 里展示

/** 单次检查：在线 → 读私有提交 → 超限就 stop + launch。失败只打 warn，绝不抛。 */
export async function watchdogTick(cfg, logger) {
  try {
    const up = await probe(cfg)
    if (!up.ok) return                       // 不在线：内存问题无从谈起，留给 ensureInFlow 带起
    const pid = listeningPid(cfg.embedPort)
    if (!pid) return
    const mb = privateCommitMb(pid)
    if (!mb) return
    const limit = Math.max(512, Number(cfg.watchdogLimitMb) || 4096)
    if (mb <= limit) return
    logger?.warn?.(
      `[dsh-embed] 看门狗：llama-server(PID ${pid}) 私有提交 ${mb.toFixed(0)}MB 超过 ${limit}MB，自动重启`,
    )
    const stopped = stopService(cfg)
    await sleep(1500)
    const launched = launch(cfg)
    lastWatchdogRestart =
      `${new Date().toLocaleString('zh-CN')}｜${mb.toFixed(0)}MB → 重启（stop=${stopped.ok ? 'ok' : 'fail'} launch=${launched}）`
    logger?.info?.(`[dsh-embed] 看门狗重启完成：${lastWatchdogRestart}`)
  } catch (err) {
    logger?.warn?.(`[dsh-embed] 看门狗异常：${(err && err.message) || err}`)
  }
}

/** 递归 setTimeout 的周期检查，随插件卸载清理。 */
export function mountWatchdog(ctx, cfg) {
  if (!cfg.watchdogEnabled) return
  let timer = null
  const loop = async () => {
    await watchdogTick(cfg, ctx.logger)
    timer = setTimeout(loop, (Number(cfg.watchdogIntervalSec) || 300) * 1000)
  }
  timer = setTimeout(loop, (Number(cfg.watchdogIntervalSec) || 300) * 1000)
  ctx.effect(() => () => {
    if (timer) clearTimeout(timer)
  }, 'dsh-embed: 内存看门狗')
}

/* ── 工具面 ─────────────────────────────────────────────────────────────── */

const OUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

function registerEmbedTool(ctx, cfg) {
  ctx.effect(() => ctx.tools.register(defineTool({
    // 名字保持不变（原来挂在 dsh-liubian 上），技能与肌肉记忆都不用改
    name: TOOL_NAME,
    description: '本地语义向量服务（llama.cpp + Qwen3-Embedding-0.6B，端口 8082）—— 独立插件 dsh-liubian-embed。'
      + '检索侧调不到它会自动回退纯 tag（不报错）。插件加载时已自动探活并带起服务，'
      + '所以通常不用手动调；本工具用于查看状态、强制拉起、或关停释放显存。'
      + 'action: status 探活｜ensure 拉起并等待就绪｜stop 关停（释放显存）｜restart 重启。',
    parameters: {
      action: { type: 'string', enum: ['status', 'ensure', 'stop', 'restart'], required: true, description: '操作' },
    },
    output: OUT,
    async execute(args) {
      const action = String(args.action || 'status').toLowerCase()
      const before = await probe(cfg)

      if (action === 'status') {
        const line = before.ok
          ? `[OK] 向量服务在线：${cfg.embedUrl}`
          : `[离线] 向量服务不可用：${cfg.embedUrl}（${before.body}）`
        const pid = listeningPid(cfg.embedPort)
        return [
          line,
          `[端口] ${cfg.embedPort}${pid ? `　PID ${pid}` : '　（无监听进程）'}`,
          `[启动方式] ${cfg.launchViaCmd ? `脚本 ${cfg.embedCmd}` : `直起 exe ${cfg.serverExe}（无窗）`}`,
          `[加载自动带起] ${cfg.autoEnsureOnLoad ? '开' : '关'}`,
          `[看门狗] ${cfg.watchdogEnabled ? `开（私有提交 >${cfg.watchdogLimitMb}MB 自动重启，每 ${cfg.watchdogIntervalSec}s 查一次）` : '关'}${lastWatchdogRestart ? `｜最近一次：${lastWatchdogRestart}` : ''}`,
          `[配置文件] ${configFile()}${existsSync(configFile()) ? '' : '（尚未创建，用默认值）'}`,
          before.ok ? before.body : '',
        ].filter(Boolean).join('\n')
      }

      if (action === 'stop') {
        const r = stopService(cfg)
        if (!r.ok) return `[错误] 关停失败（PID ${r.pid}）：${r.error}`
        return r.pid
          ? `[OK] 已关停向量服务（PID ${r.pid}），显存已释放。想再起来用 action=ensure。`
          : '[OK] 端口上没有监听进程，无需关停。'
      }

      if (action === 'restart') {
        const r = stopService(cfg)
        await sleep(1500)
        const up = await ensureReady(cfg)
        if (!up.ok) return `[错误] 重启失败：${up.error || '等待就绪超时'}`
        return `[OK] 向量服务已重启并就绪（${up.seconds}s）：${cfg.embedUrl}\n${up.body}`
      }

      // ensure
      const up = await ensureReady(cfg)
      if (up.ok) {
        return up.already
          ? `[OK] 向量服务已在线：${cfg.embedUrl}\n${up.body}`
          : `[OK] 向量服务已就绪（${up.seconds}s）：${cfg.embedUrl}\n${up.body}`
      }
      if (up.pending) {
        return `[待加载] 已拉起向量服务，${up.seconds} 秒内未就绪（模型首次加载可能更久）。稍后用 action=status 复查。`
      }
      return `[错误] ${up.error}`
    },
  })), TOOL_NAME)
}

/* ── 入口 ───────────────────────────────────────────────────────────────── */

let activeLogger = null

export function apply(ctx, input = {}) {
  const cfg = resolveConfig(input)
  activeLogger = ctx.logger

  registerEmbedTool(ctx, cfg)

  // 探活 → 离线就带起来（不等待、不阻塞宿主启动）
  ensureInFlow(cfg, ctx.logger, { force: true })

  // 内存看门狗：私有提交超限自动重启（防 llama-server 长期跑提交内存累积）
  mountWatchdog(ctx, cfg)

  ctx.logger?.info?.(
    `[dsh-liubian-embed] v${PLUGIN_VERSION} 向量服务插件已挂载：${cfg.embedUrl}（端口 ${cfg.embedPort}）`
    + `${cfg.watchdogEnabled ? `｜看门狗开（>${cfg.watchdogLimitMb}MB/每 ${cfg.watchdogIntervalSec}s）` : ''}`,
  )
}

/** 纯函数测试缝。 */
export const __test = {
  resolveConfig,
  listeningPid,
  stopService,
  probe,
  launch,
  ensureReady,
  configFile,
  privateCommitMb,
  watchdogTick,
}
