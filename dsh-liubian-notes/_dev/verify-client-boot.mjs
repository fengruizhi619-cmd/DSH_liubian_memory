/**
 * 客户端模块「工厂返回值」验证（模拟渲染器加载器语义）
 *
 * 背景：渲染器报 `Renderer boot failed (plugins: dsh-liubian-notes):
 *       The client Loader did not provide an error message.`
 * 根因假设：`window.__ModuleLoader__.load({id, factory})` 的加载器以 **工厂返回值** 作为模块导出；
 *          官方客户端模块与 kotatsu 均以 `return module.exports` 收尾，本插件缺这一行 → 返回 undefined。
 *
 * 本脚本用桩加载器复现该语义：调用 factory，断言返回值就是模块导出（含 inject / apply）。
 * 修复前该断言必失败（undefined），修复后应通过。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const FILE = process.argv[2] || 'E:/DSH_data/流变系统/dsh-liubian-notes/lib/client.js'
let captured = null

// 桩：window.__ModuleLoader__.load 捕获定义
globalThis.window = {
  __ModuleLoader__: { load: (def) => { captured = def } },
  setInterval: () => 0,
  clearInterval: () => {},
  addEventListener: () => {},
}
globalThis.document = { createElement: () => ({ setAttribute() {}, remove() {}, style: {}, textContent: '' }), head: { appendChild() {} } }

const src = fs.readFileSync(FILE, 'utf8')
// 以 ESM 方式求值该脚本（顶层调用 __ModuleLoader__.load）
await import(pathToFileURL(FILE).href + '?t=' + Date.now())

const out = []
const say = (name, ok, detail) => out.push({ name, ok: !!ok, detail })

say('顶层调用了 __ModuleLoader__.load', !!captured, captured ? 'id=' + captured.id : '未捕获')
say('注册 id 与包名一致', captured && captured.id === 'dsh-liubian-notes', captured && captured.id)

// 桩 require：react 最小面（createElement 记录 type/props，供双视图断言；组件体内才用 hooks）
const reactStub = {
  createElement: (type, props) => ({ type, props: props || {} }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useMemo: (f) => (typeof f === 'function' ? f() : undefined),
  useCallback: (f) => f,
  Fragment: 'Fragment',
}
const requireStub = (name) => {
  if (name === 'react') return reactStub
  throw new Error('桩 require 未提供: ' + name)
}

let returned
let threw = null
try { returned = captured.factory(requireStub) } catch (e) { threw = e }
say('factory 执行不抛错', !threw, threw ? String(threw.message) : 'ok')
say('★ factory 返回模块导出（根因判据）', !!returned && typeof returned === 'object', '返回类型=' + (returned === undefined ? 'undefined（加载器将 boot 失败）' : typeof returned))
say('导出含 inject', !!returned && Array.isArray(returned.inject) && returned.inject.includes('slots'), returned && JSON.stringify(returned.inject))
say('服务声明含 sessions（轨迹式声明）', !!returned && Array.isArray(returned.inject) && returned.inject.includes('sessions'), returned && JSON.stringify(returned.inject))
say('导出含 apply 函数', !!returned && typeof returned.apply === 'function', returned && typeof returned.apply)

// 运行期形态：apply 拿桩 ctx 应注册 conversation.view，且插槽带**轨迹式会话绑定**
const registered = []
let capturedDef = null
let capturedComp = null
const defs = {}            // 按槽名收集全部注册项（conversation.view / conversation.input.overlay）
const comps = {}
const ctxStub = {
  effect: (fn) => { fn(); return () => {} },
  // 轨迹式：inject(sessionId) 内用 ctx.sessions.binding(sessionId)?.session 判断会话是否可用
  sessions: { binding: (id) => (id === 'sess-live' ? { session: { id } } : undefined) },
  slots: {
    inject: (name, fn) => { const it = fn(); registered.push(name); return it },
    register: (def, comp) => { defs[def.name] = def; comps[def.name] = comp; capturedDef = def; capturedComp = comp; return { def, comp } },
  },
}
let applyThrew = null
try { returned.apply(ctxStub) } catch (e) { applyThrew = e }
say('apply 可运行（注册 slots）', !applyThrew && registered.includes('conversation.view'), applyThrew ? String(applyThrew.message) : 'slots=' + registered.join(','))
const viewDef = defs['conversation.view'] || null
say('注册项声明 id/order/label', !!viewDef && viewDef.id === 'notes' && viewDef.order === 20 && viewDef.label === '流变便签',
  viewDef ? ('id=' + viewDef.id + ' order=' + viewDef.order + ' label=' + viewDef.label) : 'undefined')
say('★ 插槽带会话绑定 inject(sessionId)', !!viewDef && typeof viewDef.inject === 'function',
  viewDef ? typeof viewDef.inject : 'undefined')
say('inject 回传会话 id + 存活标记', !!viewDef && typeof viewDef.inject === 'function'
  && viewDef.inject('sess-live').sessionId === 'sess-live' && viewDef.inject('sess-live').sessionLive === true,
  viewDef && typeof viewDef.inject === 'function' ? JSON.stringify(viewDef.inject('sess-live')) : '-')
say('取不到绑定时不抛错（降级）', !!viewDef && typeof viewDef.inject === 'function'
  && (function () { try { const r = viewDef.inject('sess-dead'); return r.sessionId === 'sess-dead' && r.sessionLive === false } catch (e) { return false } })(),
  viewDef && typeof viewDef.inject === 'function' ? JSON.stringify(viewDef.inject('sess-dead')) : '-')
say('设置页组件是函数', typeof comps['settings.plugins.tab'] === 'function', typeof comps['settings.plugins.tab'])

/* 插件页卡片：plugins.item（「插件」页列表里流变便签自己的卡片 + 点开后的设置表单） */
const itemDef = defs['plugins.item']
const itemComp = comps['plugins.item']
say('★ 注册 plugins.item（便签自己的卡片）', !!itemDef && itemDef.id === 'dsh-liubian-notes' && itemDef.label === '流变便签',
  itemDef ? ('id=' + itemDef.id + ' label=' + itemDef.label) : '（未注册）')
say('插件卡片组件是函数', typeof itemComp === 'function', typeof itemComp)
if (typeof itemComp === 'function') {
  const summaryEl = itemComp({ view: 'summary' })
  const pageEl = itemComp({ view: 'page' })
  say('summary 视图 = 一行简介（span）', !!summaryEl && summaryEl.type === 'span', 'type=' + summaryEl.type)
  say('page 视图 = 设置表单组件', !!pageEl && typeof pageEl.type === 'function' && pageEl.type === comps['settings.plugins.tab'],
    'type===' + (pageEl && typeof pageEl.type))
}

/* 设置页：settings.plugins.tab（流变便签 · 聚合 API 配置） */
const setPageDef = defs['settings.plugins.tab']
say('★ 注册设置页 settings.plugins.tab', !!setPageDef && setPageDef.id === 'liubian-notes' && setPageDef.label === '流变便签',
  setPageDef ? ('id=' + setPageDef.id + ' label=' + setPageDef.label) : '（未注册）')
say('设置页组件是函数', typeof comps['settings.plugins.tab'] === 'function', typeof comps['settings.plugins.tab'])

/* 输入条 overlay 已撤除（管理员 2026-10-01 定夺：保持原生输入框，不做花活）——防回归断言 */
say('★ 不再注册输入框遮挡 overlay（已撤除）',
  !defs['conversation.input.overlay'] && registered.indexOf('conversation.input.overlay') < 0,
  defs['conversation.input.overlay'] ? '仍注册（应删除）' : '未注册 ✓')

const bad = out.filter((r) => !r.ok)
for (const r of out) console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.name + '   [' + r.detail + ']')
console.log('')
console.log((bad.length ? 'FAIL' : 'ALL PASS') + `  ${out.length - bad.length}/${out.length}`)
process.exit(bad.length ? 1 : 0)
