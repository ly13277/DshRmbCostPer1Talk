/**
 * dsh-turn-cost-pill —— Client 半边。
 *
 * 在输入框工具行「权限」按钮右侧显示上一次交互（自你上次发消息起）的模型花费。
 * 数据来自 Host 投影 `turnSpend`，这里只负责格式化与渲染。
 */
window.__ModuleLoader__.load({
  id: 'dsh-turn-cost-pill',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'turn-cost'

    const zh = {
      prefixLast: '上次',
      prefixRunning: '本轮',
      titleLast: '上次交互（从你上次发消息起）花费 ¥{cost}。输入 {input}｜缓存命中 {cache}｜输出 {output} tokens；模型 {model}。',
      titleRunning: '本轮交互进行中，已花费 ¥{cost}。输入 {input}｜缓存命中 {cache}｜输出 {output} tokens；模型 {model}。',
      estimated: '非 DeepSeek 官方模型，按 Flash 价估算',
    }

    const en = {
      prefixLast: 'Last',
      prefixRunning: 'Now',
      titleLast: 'Last exchange cost ¥{cost} since your last message. Input {input} · cache hit {cache} · output {output} tokens; model {model}.',
      titleRunning: 'This exchange is running; spent ¥{cost} so far. Input {input} · cache hit {cache} · output {output} tokens; model {model}.',
      estimated: 'Estimated at Flash pricing for a non-DeepSeek model',
    }

    const css = [
      '.tcp-pill{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 4px;border-radius:var(--dsw-radius-sm,6px);',
      'color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;',
      'font-variant-numeric:tabular-nums;flex:none;cursor:default;min-width:0;max-width:160px}',
      '.tcp-icon{display:inline-flex;flex:none;width:14px;height:14px;color:inherit;opacity:.85}',
      '.tcp-icon svg{width:14px;height:14px;display:block}',
      '.tcp-prefix{color:var(--dsw-alias-label-secondary);opacity:.75}',
      '.tcp-value{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.tcp-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary)}',
      '.tcp-est{opacity:.6;font-size:11px}',
      '@container (width<=460px){.tcp-prefix{display:none}}',
    ].join('')

    /**
     * 千分位整数。
     * @param {number} value - 计数。
     * @returns {string} 带逗号的文本。
     */
    function grouped(value) {
      const n = Math.max(0, Math.round(Number(value) || 0))
      return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /**
     * 金额文本：小额保留 4 位，1 元以上保留 2 位。
     * @param {number} value - 金额（元）。
     * @returns {string} 数字文本。
     */
    function formatCost(value) {
      const n = Number(value) || 0
      if (n <= 0) return '0'
      if (n < 0.0001) return '<0.0001'
      if (n < 1) return n.toFixed(4)
      return n.toFixed(2)
    }

    function CoinIcon() {
      return h('svg', {
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        'aria-hidden': true,
        focusable: 'false',
      },
      h('circle', { cx: 8, cy: 8, r: 6.1 }),
      h('path', {
        d: 'M5.5 5.1 8 8.2l2.5-3.1M8 8.2v3.3M6.2 8.9h3.6M6.2 10.3h3.6',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    /**
     * 「上次花费」胶囊。
     * @param {{useProjection: Function, t: Function}} props - 槽位属性。
     */
    function TurnCostPill({ useProjection, t }) {
      const spend = useProjection('turnSpend')
      const current = spend === null || spend === undefined ? null : (spend.current ?? null)
      const last = spend === null || spend === undefined ? null : (spend.last ?? null)
      const entry = current === null ? last : current
      if (entry === null) return null

      const running = current !== null
      const cost = formatCost(entry.cost)
      const tokens = entry.tokens ?? { input: 0, cacheRead: 0, output: 0 }
      const model = Array.isArray(entry.models) && entry.models.length > 0 ? entry.models.join(' / ') : '—'
      const title = t(running ? 'titleRunning' : 'titleLast', {
        cost,
        input: grouped(tokens.input),
        cache: grouped(tokens.cacheRead),
        output: grouped(tokens.output),
        model: entry.estimated ? model + '（' + t('estimated') + '）' : model,
      })

      return h(React.Fragment, null,
        h('style', { 'data-plugin': 'dsh-turn-cost-pill' }, css),
        h('span', {
          className: 'tcp-pill',
          title,
          'aria-label': title,
          'data-turn-cost': running ? 'running' : 'settled',
        },
          running ? h('span', { className: 'tcp-dot', 'aria-hidden': true }) : null,
          h('span', { className: 'tcp-icon', 'aria-hidden': true }, h(CoinIcon, null)),
          h('span', { className: 'tcp-prefix' }, t(running ? 'prefixRunning' : 'prefixLast')),
          h('span', { className: 'tcp-value' }, '¥' + cost),
          entry.estimated ? h('span', { className: 'tcp-est', 'aria-hidden': true }, '≈') : null,
        ))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'turn-cost: dictionaries',
        )
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'turn-cost',
          order: 0,
          locale: NS,
        }, TurnCostPill))
      },
    }
  },
})
