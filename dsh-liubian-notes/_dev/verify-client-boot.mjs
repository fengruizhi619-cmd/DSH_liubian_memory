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

// 桩 require：只需 react 的最小面（组件体内才用 hooks，工厂阶段不调用）
const reactStub = {
  createElement: () => ({}),
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
say('导出含 apply 函数', !!returned && typeof returned.apply === 'function', returned && typeof returned.apply)

// 运行期形态：apply 拿桩 ctx 应能注册槽位样式与 conversation.view，且**插槽带会话绑定**
const registered = []
let capturedDef = null
let capturedComp = null
const ctxStub = {
  effect: (fn) => { fn(); return () => {} },
  slots: {
    inject: (name, fn) => { const it = fn(); registered.push(name); return it },
    register: (def, comp) => { capturedDef = def; capturedComp = comp; return { def, comp } },
  },
}
let applyThrew = null
try { returned.apply(ctxStub) } catch (e) { applyThrew = e }
say('apply 可运行（注册 slots）', !applyThrew && registered.includes('conversation.view'), applyThrew ? String(applyThrew.message) : 'slots=' + registered.join(','))
say('注册项声明 id/order/label', !!capturedDef && capturedDef.id === 'notes' && capturedDef.order === 20 && capturedDef.label === '流变便签',
  capturedDef ? ('id=' + capturedDef.id + ' order=' + capturedDef.order + ' label=' + capturedDef.label) : 'undefined')
say('★ 插槽带会话绑定 inject(sessionId)', !!capturedDef && typeof capturedDef.inject === 'function',
  capturedDef ? typeof capturedDef.inject : 'undefined')
say('inject 回传当前会话 id', !!capturedDef && typeof capturedDef.inject === 'function'
  && capturedDef.inject('sess-x').sessionId === 'sess-x',
  capturedDef && typeof capturedDef.inject === 'function' ? JSON.stringify(capturedDef.inject('sess-x')) : '-')
say('组件是函数（可挂载）', typeof capturedComp === 'function', typeof capturedComp)

const bad = out.filter((r) => !r.ok)
for (const r of out) console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.name + '   [' + r.detail + ']')
console.log('')
console.log((bad.length ? 'FAIL' : 'ALL PASS') + `  ${out.length - bad.length}/${out.length}`)
process.exit(bad.length ? 1 : 0)
