/**
 * dsh-liubian（流变·记忆）纯函数桩测 —— 家族标准 §8 第一层：**不依赖宿主可跑**
 *
 * 跑法（本机 node 不在 PATH，用 Electron 伪装 node）：
 *   $node = "C:\Users\Feng\AppData\Roaming\DSH Desktop\runtime-commands\private\node-bin\node.cmd"
 *   & $node _dev/stub_test.mjs
 *
 * 纪律：不碰生产库、不发真实网络请求（fetch 全程被桩替换）、不改任何文件。
 * 覆盖重点按「血案优先」：会话消息四要件（§3.3.1）、合成消息辨识（§3.3.2）、
 * 以及本轮新落的 embedTexts（index 排序 + 一次重试）。
 */
import { createHash } from 'node:crypto'

import { __test, PLUGIN_SOURCE, PLUGIN_VERSION } from '../lib/impl.mjs'

const {
  pluginMessage, messageText, isOurMessage, isPluginMessage, isHumanMessage,
  promptText, currentPrompt, isFreshUserPrompt, estimateTokens, clipText, embedTexts,
  sessionHashFor, buildWikiRequest,
} = __test

let pass = 0
let fail = 0
function t(label, fn) {
  try { fn(); pass += 1; console.log(`  ✓ ${label}`) } catch (e) { fail += 1; console.log(`  ✗ ${label}\n      ${e.message}`) }
}
async function ta(label, fn) {
  try { await fn(); pass += 1; console.log(`  ✓ ${label}`) } catch (e) { fail += 1; console.log(`  ✗ ${label}\n      ${e.message}`) }
}
function eq(a, b, msg = '') { if (a !== b) throw new Error(`期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)} ${msg}`) }
function ok(v, msg = '') { if (!v) throw new Error(`期望为真，实际 ${JSON.stringify(v)} ${msg}`) }

const human = (text) => ({ id: 'u1', role: 'user', content: [{ type: 'text', text }] })
const assistant = (text) => ({ id: 'a1', role: 'assistant', content: [{ type: 'text', text }] })

console.log(`== dsh-liubian 桩测（插件版本 ${PLUGIN_VERSION}｜PLUGIN_SOURCE=${PLUGIN_SOURCE}）==`)

/* ── 1. 会话消息四要件（检查表 §3.3.1：漏 id 会写坏整段历史） ─────────────── */
console.log('\n== pluginMessage 四要件 ==')
t('id 是非空字符串', () => {
  const m = pluginMessage('内容', 'recall')
  eq(typeof m.id, 'string')
  ok(m.id.length > 0, '（id 不能为空）')
})
t('role = user', () => eq(pluginMessage('x', 'recall').role, 'user'))
t('content 是数组且为 text 块', () => {
  const m = pluginMessage('内容', 'recall')
  ok(Array.isArray(m.content), 'content 必须是数组')
  eq(m.content[0].type, 'text')
  eq(m.content[0].text, '内容')
})
t('source.kind 是 producer-owned（v4 硬要求）', () => {
  const m = pluginMessage('x', 'recall')
  eq(m.source.kind, 'plugin:' + PLUGIN_SOURCE)
  ok(m.source.kind !== 'plugin', '裸 "plugin" 会被 v4 拒收')
})
t('source.form 原样保留', () => eq(pluginMessage('x', 'notice').source.form, 'notice'))
t('两次调用 id 不同（不撞 uuid）', () => ok(pluginMessage('x').id !== pluginMessage('x').id))

/* ── 2. 合成消息辨识（检查表 §3.3.2：曾把 6900 字技能目录当人话） ─────────── */
console.log('\n== isOurMessage / isPluginMessage / isHumanMessage ==')
t('自己的块（v4 形态）被认出', () => ok(isOurMessage(pluginMessage('x', 'recall'))))
t('自己的块（旧日志形态 {kind:plugin, plugin}）被认出', () => {
  ok(isOurMessage({ role: 'user', source: { kind: 'plugin', plugin: PLUGIN_SOURCE } }))
})
t('别的插件的块不算自己的，但算插件块', () => {
  const other = { role: 'user', content: [], source: { kind: 'plugin:@openviking/dsh-memory-plugin' } }
  eq(isOurMessage(other), false)
  eq(isPluginMessage(other), true)
  eq(isHumanMessage(other), false)
})
t('skill-catalog 不是人话', () => eq(isHumanMessage({ role: 'user', content: [], source: { kind: 'skill-catalog' } }), false))
t('tool 结果不是人话', () => eq(isHumanMessage({ role: 'user', content: [], source: { kind: 'tool' } }), false))
t('assistant 不是人话', () => eq(isHumanMessage(assistant('x')), false))
t('真人 user（无 source）是人话', () => eq(isHumanMessage(human('x')), true))
t('真人 user（kind=user）是人话', () => eq(isHumanMessage({ role: 'user', content: [], source: { kind: 'user' } }), true))

/* ── 3. messageText / promptText / currentPrompt ───────────────────────── */
console.log('\n== messageText / promptText / currentPrompt ==')
t('字符串 content 直接返回', () => eq(messageText({ content: 'hello' }), 'hello'))
t('非 text 块被忽略', () => {
  eq(messageText({ content: [{ type: 'image', url: 'x' }, { type: 'text', text: 'keep' }] }), 'keep')
})
t('非法输入返回空串', () => { eq(messageText(null), ''); eq(messageText({ content: 42 }), '') })
t('promptText 排掉自己的注入块', () => {
  eq(promptText([pluginMessage('我自己的召回块', 'recall'), human('真正的问题')]), '真正的问题')
})
t('currentPrompt：表尾是真人 → 取到', () => eq(currentPrompt([assistant('上轮'), human('本轮问题')]), '本轮问题'))
t('currentPrompt：表尾是 assistant → 空（新一轮还没开始）', () => eq(currentPrompt([human('上轮问题'), assistant('回答')]), ''))
t('currentPrompt：表尾是 tool 结果 → 空', () => eq(currentPrompt([human('q'), { role: 'user', content: [], source: { kind: 'tool' } }]), ''))
t('currentPrompt：空表 → 空', () => eq(currentPrompt([]), ''))
t('isFreshUserPrompt 与 currentPrompt 同源', () => {
  eq(isFreshUserPrompt([assistant('a')]), false)
  eq(isFreshUserPrompt([assistant('a'), human('q')]), true)
})

/* ── 4. estimateTokens / clipText ──────────────────────────────────────── */
console.log('\n== estimateTokens / clipText ==')
t('空文本 0 token', () => eq(estimateTokens(''), 0))
t('纯 ASCII 按 chars/4', () => eq(estimateTokens('abcd'), 1))
t('纯 CJK 按 1.5/字', () => eq(estimateTokens('中文'), 3))
t('混排（ab中文）', () => eq(estimateTokens('ab中文'), 4))
t('不超长原样返回（含 trim）', () => eq(clipText('  abc  ', 10), 'abc'))
t('超长截断并带尾巴', () => eq(clipText('a'.repeat(10), 4), 'aaaa\n…（已截断）'))

/* ── 5. embedTexts（本轮落刀：index 排序 + 一次重试） ───────────────────── */
console.log('\n== embedTexts（契约 v1.2 §2.2/§3 对齐） ==')
const realFetch = globalThis.fetch
const cfg = { diaryTagEmbedUrl: 'http://stub.invalid/v1/embeddings', diaryTagEmbedModel: 'stub-emb' }
const mkRes = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(payload),
})
async function withFetch(handler, fn) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null
    calls.push({ url, body })
    return handler(calls.length, body)
  }
  try { return await fn(calls) } finally { globalThis.fetch = realFetch }
}

await ta('乱序 index → 按 index 排序（不依赖服务端保序）', async () => {
  await withFetch(
    () => mkRes(200, { data: [{ index: 2, embedding: [2] }, { index: 0, embedding: [0] }, { index: 1, embedding: [1] }] }),
    async () => {
      const out = await embedTexts(cfg, ['a', 'b', 'c'])
      eq(JSON.stringify(out), JSON.stringify([[0], [1], [2]]))
    },
  )
})
await ta('条目缺 index → 保持原序（向后兼容）', async () => {
  await withFetch(
    () => mkRes(200, { data: [{ embedding: [10] }, { embedding: [20] }] }),
    async () => eq(JSON.stringify(await embedTexts(cfg, ['a', 'b'])), JSON.stringify([[10], [20]])),
  )
})
await ta('首次网络异常 → 重试一次并成功（调用数 2）', async () => {
  await withFetch(
    (n) => { if (n === 1) throw new Error('ECONNREFUSED'); return mkRes(200, { data: [{ index: 0, embedding: [7] }] }) },
    async (calls) => {
      eq(JSON.stringify(await embedTexts(cfg, ['x'])), JSON.stringify([[7]]))
      eq(calls.length, 2)
    },
  )
})
await ta('HTTP 400 → 不重试、直接降级（调用数 1）', async () => {
  await withFetch(
    () => mkRes(400, { error: 'exceed_context_size_error' }),
    async (calls) => { eq(await embedTexts(cfg, ['x']), null); eq(calls.length, 1) },
  )
})
await ta('HTTP 503（重启窗口）→ 重试后仍失败则降级（调用数 2）', async () => {
  await withFetch(
    () => mkRes(503, { error: 'loading model' }),
    async (calls) => { eq(await embedTexts(cfg, ['x']), null); eq(calls.length, 2) },
  )
})
await ta('两次都抛异常 → 返回 null（调用数 2，不无限重试）', async () => {
  await withFetch(
    () => { throw new Error('boom') },
    async (calls) => { eq(await embedTexts(cfg, ['x']), null); eq(calls.length, 2) },
  )
})
await ta('返回体无 data → 重试后降级', async () => {
  await withFetch(
    () => mkRes(200, { object: 'list' }),
    async (calls) => { eq(await embedTexts(cfg, ['x']), null); eq(calls.length, 2) },
  )
})
await ta('超长输入按契约截断到 600 字符', async () => {
  await withFetch(
    () => mkRes(200, { data: [{ index: 0, embedding: [1] }] }),
    async (calls) => {
      await embedTexts(cfg, ['x'.repeat(5000)])
      eq(calls[0].body.input[0].length, 600)
    },
  )
})

/* ── 6. 归因二分（规则 7）：会话哈希派生 + 请求组装 ───────────────────────── */
console.log('\n== sessionHashFor / buildWikiRequest（归因二分） ==')
t('会话哈希配方 = SHA256(sessionId)[:8]（独立计算对照，与基建同源）', () => {
  const sid = 'session-3f017183-0000-0000-0000-000000000000'
  eq(sessionHashFor(sid), createHash('sha256').update(sid).digest('hex').slice(0, 8))
  eq(/^[0-9a-f]{8}$/.test(sessionHashFor(sid)), true)
})
t('非字符串输入也稳定（不抛）', () => eq(sessionHashFor(12345), createHash('sha256').update('12345').digest('hex').slice(0, 8)))

const wcfg = { liubianRoot: 'E:/DSH_data', workspace: '工作组', diaryWorkspace: 'auto' }
const wagent = { session: { id: 'sess-abc', header: { cwd: 'E:\\DSH_data\\中枢' } } }
t('op 取 action，其余业务参数原样透传', () => {
  const r = buildWikiRequest(wcfg, { action: 'create', slug: 'x', title: 't' }, wagent)
  eq(r.op, 'create')
  eq(r.slug, 'x')
  eq(r.title, 't')
})
t('sessionHash 由调用会话派生', () => eq(buildWikiRequest(wcfg, { action: 'create' }, wagent).sessionHash, sessionHashFor('sess-abc')))
t('无会话上下文 → sessionHash 空串（helper 侧走兜底并标记）', () => {
  eq(buildWikiRequest(wcfg, { action: 'create' }, null).sessionHash, '')
  eq(buildWikiRequest(wcfg, { action: 'create' }, {}).sessionHash, '')
})
t('显式 contributor → sourceContributor（不改执行者）', () => {
  eq(buildWikiRequest(wcfg, { action: 'create', contributor: '玉簪' }, wagent).sourceContributor, '玉簪')
})
t('未传 contributor → 空串（不再默认工作区）', () => {
  eq(buildWikiRequest(wcfg, { action: 'create' }, wagent).sourceContributor, '')
  eq(buildWikiRequest(wcfg, { action: 'create', contributor: '   ' }, wagent).sourceContributor, '')
})
t('workspace 由会话 cwd 推导（在 liubianRoot 下才认）', () => eq(buildWikiRequest(wcfg, { action: 'create' }, wagent).workspace, '中枢'))
t('diaryWorkspace 固定值优先于推导', () => {
  eq(buildWikiRequest({ ...wcfg, diaryWorkspace: '工作组' }, { action: 'create' }, wagent).workspace, '工作组')
})
t('cwd 不在 liubianRoot 下 → 回落默认工作区', () => {
  const other = { session: { id: 's', header: { cwd: 'C:\\Windows\\System32' } } }
  eq(buildWikiRequest(wcfg, { action: 'create' }, other).workspace, '工作组')
})

console.log(`\n== 结果：${pass} 过 / ${fail} 败 ==`)
process.exitCode = fail === 0 ? 0 : 1
