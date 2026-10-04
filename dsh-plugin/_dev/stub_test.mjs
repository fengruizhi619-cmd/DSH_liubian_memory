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
  wikiServiceRequest, buildWikiService, WIKI_SERVICE_METHODS,
  lessonsAddDecision, buildLessonsService, LESSONS_CAPACITY,
} = __test

const kit = await import('liubian-kit')

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

/* ── 7. 跨插件服务 liubianWiki（便签升格的写入通道） ────────────────────── */
console.log('\n== liubianWiki 服务面 ==')
t('方法 → op 映射（大小写不敏感、业务字段原样透传）', () => {
  const r = wikiServiceRequest('create', { slug: 's', familyPath: 's', title: 't' })
  eq(r.op, 'create')
  eq(r.slug, 's')
  eq(r.familyPath, 's')
  eq(wikiServiceRequest('CREATE', { slug: 's' }).op, 'create')
})
t('非法/退役方法一律拒（不静默兜底成 create）', () => {
  eq(wikiServiceRequest('drop', {}), null)
  eq(wikiServiceRequest('', {}), null)
  eq(wikiServiceRequest('write', {}), null, '已退役的 write 必须被拒')
  eq(wikiServiceRequest('search', {}), null, 'search 需要向量，不在服务面')
})
t('服务对象：版本 + 七个方法全为函数', () => {
  const svc = buildWikiService({ memoryTimeoutMs: 1000 })
  eq(svc.version, 1)
  eq(WIKI_SERVICE_METHODS.length, 7)
  for (const m of WIKI_SERVICE_METHODS) ok(typeof svc[m] === 'function', `${m} 应是函数`)
})
t('未知方法名不在服务面上（不是函数）', () => {
  const svc = buildWikiService({ memoryTimeoutMs: 1000 })
  eq(svc.drop, undefined)
})

/* ── 8. liubianLessons 服务面（教训支路，协议 §20）+ kit 迁入 ──────────────── */
console.log('\n== liubianLessons 服务面（上线闸 80/50，两步走） ==')
eq(LESSONS_CAPACITY.global, 80, 'global 上线闸')
eq(LESSONS_CAPACITY.workspace, 50, 'workspace 上线闸')

t('lessonsAddDecision：空文本 invalid', () => eq(lessonsAddDecision(['a'], '   ', 80).action, 'invalid'))
t('lessonsAddDecision：重复（空白折叠比对）', () => {
  const d = lessonsAddDecision(['保持冷静'], '保持  冷静 ', 80)
  eq(d.action, 'duplicate')
  eq(d.total, 1)
})
t('lessonsAddDecision：满闸', () => {
  const list = Array.from({ length: 3 }, (_, i) => '教训' + i)
  eq(lessonsAddDecision(list, '新的', 3).action, 'full')
})
t('lessonsAddDecision：正常 add', () => {
  const d = lessonsAddDecision(['a', 'b'], 'c', 80)
  eq(d.action, 'add')
  eq(d.total, 3)
})

const lessonsStore = (initial) => {
  // 按 scope 分桶的假存储（真 loadLessons(scope, ws) 是分文件读——夹具必须同样按 scope 区分，
  // 否则「workspace 查询拿到 global 清单」这类真缺陷会被夹具掩盖）
  const st = { global: initial.slice(), workspace: {}, saves: 0 }
  return {
    st,
    load: (scope, ws) => (scope === 'workspace' ? (st.workspace[ws] || []).slice() : st.global.slice()),
    save: (l, scope, ws) => {
      st.saves += 1
      if (scope === 'workspace') st.workspace[ws] = l.slice()
      else st.global = l.slice()
    },
  }
}
await ta('add：正常入清单（save 恰一次、total 递增、sessionHash 回传）', async () => {
  const { st, load, save } = lessonsStore(['既有教训'])
  const svc = buildLessonsService({}, { load, save })
  const r = await svc.add({ text: '新教训', scope: 'global', sessionHash: '37f58079' })
  ok(r.ok && r.added === true && r.duplicate === false, JSON.stringify(r))
  eq(r.total, 2)
  eq(r.sessionHash, '37f58079')
  eq(st.global.length, 2)
  eq(st.saves, 1)
})
await ta('add：重复 → ok + duplicate、不落盘（save 0 次）', async () => {
  const st = { list: ['保持冷静'], saves: 0 }
  const svc = buildLessonsService({}, { load: () => st.list.slice(), save: (l) => { st.list = l; st.saves += 1 } })
  const r = await svc.add({ text: '保持  冷静 ' })
  ok(r.ok && r.added === false && r.duplicate === true, JSON.stringify(r))
  eq(st.saves, 0)
})
await ta('add：满闸 → ok:false + full，报错指向工具面并带策展责任', async () => {
  const st = { list: Array.from({ length: 80 }, (_, i) => '教训' + i), saves: 0 }
  const svc = buildLessonsService({}, { load: () => st.list.slice(), save: (l) => { st.list = l; st.saves += 1 } })
  const r = await svc.add({ text: '超限的新条目', scope: 'global' })
  ok(r.ok === false && r.full === true, JSON.stringify(r).slice(0, 160))
  ok(/工具面/.test(r.error), r.error)
  ok(/银杏/.test(r.error), r.error)
  eq(st.saves, 0)
})
await ta('add：scope=workspace 缺 workspace → 明确报错', async () => {
  const { load, save } = lessonsStore([])
  const svc = buildLessonsService({}, { load, save })
  const r = await svc.add({ text: 'x', scope: 'workspace' })
  ok(r.ok === false && /workspace/.test(r.error), JSON.stringify(r))
})
await ta('list：分节返回（global / workspace 互不影响）', async () => {
  const { st, load, save } = lessonsStore(['g1', 'g2'])
  st.workspace['中枢'] = ['w1']
  const svc = buildLessonsService({}, { load, save })
  const g = await svc.list({ scope: 'global' })
  ok(g.ok && g.total === 2 && g.lessons.length === 2, JSON.stringify(g).slice(0, 120))
  const w = await svc.list({ scope: 'workspace', workspace: '中枢' })
  ok(w.ok && w.total === 1 && w.lessons[0] === 'w1', JSON.stringify(w).slice(0, 120))
})

console.log('\n== liubian-kit 迁入（BaseLiubianService 直调形态，kit 0.1.1 回归断言） ==')
t('kit 版本可解析（junction → 家族仓单源）', () => ok(/^\d+\.\d+\.\d+$/.test(kit.KIT_VERSION), String(kit.KIT_VERSION)))
t('kit 0.1.1 直调形态：方法表铺到实例（守夜人验收权回归断言）', () => {
  const inst = new kit.BaseLiubianService({ name: 'probe', version: 1, methods: { foo: async () => ({ ok: true }) } })
  eq(typeof inst.foo, 'function')
  eq(typeof inst.call, 'function')
})
t('kit 守卫：方法表带 version 不得覆盖声明版本', () => {
  const inst = new kit.BaseLiubianService({ name: 'probe', version: 7, methods: { version: 99 } })
  eq(inst.version, 7)
})
t('liubianLessons 可由 BaseLiubianService 承载（version 守卫 + 直调）', () => {
  const impl = buildLessonsService({ memoryTimeoutMs: 1000 }, { load: () => [], save: () => {} })
  const inst = new kit.BaseLiubianService({ name: 'liubianLessons', version: impl.version, methods: impl, pluginName: 'probe', kitVersion: kit.KIT_VERSION })
  eq(inst.version, 1)
  eq(typeof inst.add, 'function')
  eq(typeof inst.list, 'function')
})
t('liubianWiki 可由 BaseLiubianService 承载（直调 + version 守卫）', () => {
  const impl = buildWikiService({ memoryTimeoutMs: 1000 })
  const inst = new kit.BaseLiubianService({ name: 'liubianWiki', version: impl.version, methods: impl, pluginName: 'probe', kitVersion: kit.KIT_VERSION })
  eq(inst.version, 1)
  for (const m of WIKI_SERVICE_METHODS) eq(typeof inst[m], 'function', `${m} 应铺到实例`)
})

console.log(`\n== 结果：${pass} 过 / ${fail} 败 ==`)
process.exitCode = fail === 0 ? 0 : 1
