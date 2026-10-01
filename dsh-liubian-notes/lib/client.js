// 流变·便签 面板（client）：
//  - 入口：conversation.view 槽位注册「流变便签」栏（与 chat / 对话上下文轨迹并排的栏）；
//  - 归属：**跟对话走**——插槽 inject(sessionId) 取当前会话，只显示本对话自己的池（无手动选池）；
//  - 内容：便签卡片网格——每张卡片显示 便签头/正文/热度分（l/m 滑动窗口）/状态/来源；
//  - 数据：本插件宿主路由 /api/liubian-notes?op=pool&session=<sessionId>（只读，4 秒轮询）。
window.__ModuleLoader__.load({
  id: 'dsh-liubian-notes',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var CSS = [
      // ── 根：与对话主区同底，毛玻璃通透 ──
      '.nts-panel{display:flex;flex-direction:column;min-width:0;height:100%;background:color-mix(in srgb, var(--dsw-alias-bg-base) 72%, transparent);-webkit-backdrop-filter:blur(18px) saturate(1.15);backdrop-filter:blur(18px) saturate(1.15);color:var(--dsw-alias-label-primary);font-size:14px;overflow:hidden;position:relative}',
      '.nts-header{box-sizing:border-box;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none;min-height:52px;padding:10px 28px 10px 20px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.nts-crumb{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:20px;white-space:nowrap}',
      // 「跟对话走」的归属标记（取代原手动选池下拉）
      '.nts-scope{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;border:.5px solid var(--dsw-alias-border-l2);border-radius:9px;padding:1px 8px}',
      '.nts-stats{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap}',
      // ── 卡片网格 ──
      '.nts-scroll{min-height:0;flex:auto;overflow-y:auto;scrollbar-gutter:stable;padding:18px 32px}',
      '.nts-grid{max-width:min(1180px,100%);width:100%;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px}',
      '.nts-card{display:flex;flex-direction:column;gap:8px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-soft);border-radius:14px;padding:14px 16px;min-width:0}',
      '.nts-card.is-queued{outline:1.5px solid var(--dsw-alias-state-business-primary)}',
      '.nts-cardTop{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.nts-id{color:var(--dsw-alias-state-business-primary);font-family:var(--ds-font-family-code,monospace);font-size:12px;line-height:18px;font-weight:700}',
      '.nts-chip{border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.nts-chip.is-queued{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);color:var(--dsw-alias-state-business-primary)}',
      '.nts-chip.is-submitted{background:color-mix(in srgb, #16a34a 14%, transparent);color:#16a34a}',
      '.nts-head{font-size:14px;font-weight:600;line-height:21px;word-break:break-word;overflow-wrap:anywhere}',
      '.nts-body{font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;max-height:170px;overflow-y:auto}',
      // ── 热度条 ──
      '.nts-heatRow{display:flex;align-items:center;gap:8px}',
      '.nts-heatBar{flex:1;height:6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}',
      '.nts-heatFill{height:100%;border-radius:999px;background:var(--dsw-alias-state-business-primary)}',
      '.nts-heatText{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap}',
      '.nts-foot{display:flex;gap:10px;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;flex-wrap:wrap}',
      // ── 空态 ──
      '.nts-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:0 24px;text-align:center}',
      '.nts-emptyTitle{color:var(--dsw-alias-label-primary);font-size:24px;font-weight:500;line-height:32px}',
      '.nts-emptyDesc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:22px;max-width:460px}',
    ].join('')

    function fmtTime(iso) {
      if (!iso) return ''
      var ms = Date.parse(iso)
      if (isNaN(ms)) return ''
      // 本地时区（原实现硬编码 +8h，非 +8 时区的机器会显示错时间）
      var d = new Date(ms)
      var p = function (x) { return (x < 10 ? '0' : '') + x }
      return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }

    function statusChip(n) {
      if (n.status === 'queued') return React.createElement('span', { className: 'nts-chip is-queued' }, '待固化')
      if (n.status === 'submitted') return React.createElement('span', { className: 'nts-chip is-submitted' }, '已固化' + (n.diary_ref ? ' · ' + n.diary_ref : ''))
      return null
    }

    function sourceChip(n) {
      if (n.source === 'manual') return React.createElement('span', { className: 'nts-chip' }, '手动挂起')
      var gen = n.gen === 'llm' ? 'LLM' : (n.gen === 'concat' ? '拼接' : '')
      return React.createElement('span', { className: 'nts-chip' }, '自动聚合' + (gen ? ' · ' + gen : ''))
    }

    /** 便签卡片：头/正文/热度分（l/m 滑动窗口，条形+数值）。 */
    function NoteCard(props) {
      var n = props.note
      var heat = typeof n.heatNow === 'number' ? n.heatNow : 0
      var pct = Math.round(Math.max(0, Math.min(1, heat)) * 100)
      return React.createElement('div', { className: 'nts-card' + (n.status === 'queued' ? ' is-queued' : '') },
        React.createElement('div', { className: 'nts-cardTop' },
          React.createElement('span', { className: 'nts-id' }, n.id),
          sourceChip(n),
          statusChip(n)),
        React.createElement('div', { className: 'nts-head' }, n.head),
        React.createElement('div', { className: 'nts-body' }, n.body),
        React.createElement('div', { className: 'nts-heatRow' },
          React.createElement('div', { className: 'nts-heatBar' },
            React.createElement('div', { className: 'nts-heatFill', style: { width: pct + '%' } })),
          React.createElement('span', { className: 'nts-heatText' },
            '热度 ' + heat.toFixed(2) + '（' + (n.heatCount || 0) + ' 次注入 / m 窗口）')),
        React.createElement('div', { className: 'nts-foot' },
          React.createElement('span', null, 'born #t' + n.born_turn),
          React.createElement('span', null, n.hasVector ? '有向量' : '无向量'),
          fmtTime(n.created_at) ? React.createElement('span', null, fmtTime(n.created_at)) : null))
    }

    function NotesApp(props) {
      /* 「跟对话走」：当前会话 id 由插槽的 inject(sessionId) 传入（与官方轨迹栏同一机制），
       * 面板只显示**本对话自己的池**——不再有手动选池。 */
      var sessionId = (props && props.sessionId) || ''
      var st = React.useState({ pool: null, loaded: false, cfg: null, error: null })
      var state = st[0]
      var setState = st[1]

      React.useEffect(function () {
        var alive = true
        var seq = 0            // 请求序号：防慢响应乱序覆盖新状态
        var inflight = false   // 同一时刻只允许一个在飞请求
        function load() {
          if (!sessionId) {
            setState(function (s) { return Object.assign({}, s, { loaded: true, error: '未取到当前会话 id（插槽未传 sessionId）' }) })
            return
          }
          if (inflight) return
          inflight = true
          var mine = ++seq
          fetch('/api/liubian-notes?op=pool&session=' + encodeURIComponent(sessionId))
            .then(function (r) {
              if (!r.ok) throw new Error('HTTP ' + r.status)   // 404/500 不得伪装成空态
              return r.json()
            })
            .then(function (j) {
              inflight = false
              if (!alive || mine !== seq) return   // 旧响应直接丢弃
              setState(function (s) {
                return Object.assign({}, s, {
                  pool: j.pool || null,
                  loaded: true,
                  error: null,
                  cfg: { heatRounds: j.heatRounds, poolSize: j.poolSize, injectTop: j.injectTop, aggregateRounds: j.aggregateRounds },
                })
              })
            })
            .catch(function (err) {
              inflight = false
              // 失败时保留上一次成功数据，并把错误显式暴露（不得伪装成"本对话还没有便签"）
              if (alive && mine === seq) setState(function (s) { return Object.assign({}, s, { loaded: true, error: String((err && err.message) || err) }) })
            })
        }
        load()
        var t = window.setInterval(load, 4000)
        return function () { alive = false; window.clearInterval(t) }
      }, [sessionId])   // 切换对话立即重取（不等 4 秒轮询）

      var pool = state.pool
      var notes = pool ? (pool.notes || []).slice() : []
      // 排序：待固化 > 活跃；同级按热度降序，再按 born 新→旧
      notes.sort(function (a, b) {
        var qa = a.status === 'queued' || a.status === 'submitted' ? 0 : 1
        var qb = b.status === 'queued' || b.status === 'submitted' ? 0 : 1
        if (qa !== qb) return qa - qb
        if (b.heatNow !== a.heatNow) return b.heatNow - a.heatNow
        return b.born_turn - a.born_turn
      })
      var m = state.cfg ? state.cfg.heatRounds : '?'
      var size = state.cfg ? state.cfg.poolSize : '?'

      var body
      if (!state.loaded) {
        body = React.createElement('div', { className: 'nts-empty' },
          React.createElement('div', { className: 'nts-emptyDesc' }, '加载中…'))
      } else if (state.error) {
        // 路由不可用/报错必须显式呈现——旧实现把它伪装成「还没有任何便签池」，排障时会走错方向
        body = React.createElement('div', { className: 'nts-empty' },
          React.createElement('div', { className: 'nts-emptyTitle' }, '便签面板暂不可用'),
          React.createElement('div', { className: 'nts-emptyDesc' }, '本对话的便签池请求失败：' + state.error))
      } else if (!pool) {
        body = React.createElement('div', { className: 'nts-empty' },
          React.createElement('div', { className: 'nts-emptyDesc' }, '读不到本对话的池数据。'))
      } else {
        var avg = pool.meta && pool.meta.rounds
          ? Math.round((pool.meta.humanChars + pool.meta.assistantChars) / pool.meta.rounds)
          : 0
        var cards = notes.length
          ? React.createElement('div', { className: 'nts-grid' },
              notes.map(function (n) { return React.createElement(NoteCard, { key: n.id, note: n }) }))
          : React.createElement('div', { className: 'nts-empty' },
              React.createElement('div', { className: 'nts-emptyDesc' },
                '本对话还没有便签。每 ' + (state.cfg ? state.cfg.aggregateRounds : 5) + ' 轮人类对话自动聚合一篇'
                + (pool.sealed ? '（已封存 ' + pool.sealed + ' 轮）' : '') + '；智能体也可用 stick 主动挂起。'))
        body = React.createElement('div', { className: 'nts-scroll' },
          React.createElement('div', { className: 'nts-grid-wrap' }, cards))
      }

      return React.createElement('div', { className: 'nts-panel' },
        React.createElement('div', { className: 'nts-header' },
          React.createElement('span', { className: 'nts-crumb' }, '流变·便签'),
          React.createElement('span', { className: 'nts-scope' }, '本对话'),
          React.createElement('span', { className: 'nts-stats' },
            pool && !pool.empty
              ? (pool.notes.length + '/' + size + ' 篇 · 待封存 ' + pool.sealed + ' 轮 · 人类轮 ' + ((pool.meta && pool.meta.humanRounds) || 0) + ' / 内容轮 ' + ((pool.meta && pool.meta.rounds) || 0)
                + (avg ? '（均 ' + avg + ' 字/轮）' : '') + ' · 热度窗口 m=' + m)
              : '本对话暂无池 · 卡片视图')),
        body)
    }

    exports.inject = ['slots']
    exports.apply = function (ctx) {
      ctx.effect(function () {
        var style = document.createElement('style')
        style.setAttribute('data-liubian-notes', '1')
        style.textContent = CSS
        document.head.appendChild(style)
        return function () { style.remove() }
      }, 'liubian-notes: styles')

      // 入口：对话视图栏（与 对话 / 对话上下文轨迹 并排的「流变便签」栏）
      // inject(sessionId) 由插槽框架传入当前会话 id → 面板据此显示**本对话自己的池**（跟对话走）。
      ctx.slots.inject('conversation.view', function () {
        return ctx.slots.register({
          name: 'conversation.view',
          id: 'notes',
          order: 20,
          label: '流变便签',
          inject: function (sessionId) { return { sessionId: sessionId } },
        }, NotesApp)
      })
    }

    /* ⚠ 必须返回模块导出：加载器以**工厂返回值**作为该客户端的模块（官方客户端模块与
     * kotatsu 均以 `return module.exports` 收尾）。缺这一行 → 加载器拿到 undefined →
     * 渲染器启动即报 `Renderer boot failed … The client Loader did not provide an error
     * message.`（无错误消息，因为根本没抛错，只是拿不到 apply/inject）。 */
    return module.exports
  },
})
