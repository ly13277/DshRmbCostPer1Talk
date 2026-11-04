/**
 * dsh-turn-cost-pill —— Host 半边。
 *
 * 注册一个会话投影 `turnSpend`：把「自用户最后一次发消息起」这一整轮里
 * 每一次计费请求的 token 用量按模型、峰谷时段分桶累计，并在 `wire.view`
 * 里折算成人民币金额。Client 半边直接通过 `useProjection('turnSpend')` 读取，
 * 不需要自己折叠会话事件。
 *
 * 投影状态是纯 JSON（会进持久化 checkpoint），因此只存数字与短字符串。
 */

/** 计价币种。 */
const CURRENCY = 'CNY'

/**
 * DeepSeek 官方价目（单位：元 / 百万 tokens，空闲时段）。
 * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * 2026-09-10 起 Flash 系列为 0.02 / 1 / 4；Pro 为其 3 倍。
 * 高峰时段（工作日 09:00–12:00、14:00–18:00，不含法定节假日）= 空闲价 ×2。
 */
const PRICES = {
  flash: { cacheRead: 0.02, input: 1, output: 4 },
  pro: { cacheRead: 0.15, input: 4.5, output: 13.5 },
}

/** 高峰时段倍率。 */
const PEAK_FACTOR = 2

/** 中国法定节假日（全天按空闲价位计费），按北京时间日期登记；每年国务院公布后补录。 */
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
])

const BEIJING_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/**
 * 北京时间的日期/星期/时刻。
 * @param {number} ms - epoch 毫秒。
 * @returns {{date: string, weekday: string, minutes: number}} 本地判定所需字段。
 */
function beijingParts(ms) {
  const parts = BEIJING_CLOCK.formatToParts(new Date(ms))
  const out = { date: '', weekday: '', hour: 0, minute: 0 }
  for (const part of parts) {
    if (part.type === 'year') out.date = part.value
    else if (part.type === 'month') out.date += '-' + part.value
    else if (part.type === 'day') out.date += '-' + part.value
    else if (part.type === 'weekday') out.weekday = part.value
    else if (part.type === 'hour') out.hour = Number(part.value)
    else if (part.type === 'minute') out.minute = Number(part.value)
  }
  return { date: out.date, weekday: out.weekday, minutes: out.hour * 60 + out.minute }
}

/**
 * 该时刻是否属于 DeepSeek 高峰时段。
 * 规则：周一至周五（不含法定节假日）09:00–12:00、14:00–18:00 为高峰，其余（含周末、节假日全天）为空闲。
 * @param {number} ms - 请求发生时刻（epoch 毫秒）。
 * @returns {boolean} true 表示高峰。
 */
function isPeak(ms) {
  const { date, weekday, minutes } = beijingParts(ms)
  if (weekday === 'Sat' || weekday === 'Sun') return false
  if (HOLIDAYS.has(date)) return false
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
}

/**
 * 按模型名选价目。DeepSeek 官方模型精确匹配；其他提供方没有内置价目，
 * 回退到 Flash 价并在视图中标记为估算。
 * @param {string} model - "provider/model" 或裸模型名。
 * @returns {{cacheRead: number, input: number, output: number, known: boolean}} 价目。
 */
function priceFor(model) {
  const name = String(model ?? '').toLowerCase()
  if (name.includes('v4-pro') || name.includes('deepseek-pro')) {
    return { ...PRICES.pro, known: true }
  }
  if (name.includes('deepseek')) {
    return { ...PRICES.flash, known: true }
  }
  return { ...PRICES.flash, known: false }
}

/**
 * 取一个非负整数计数。
 * @param {unknown} value - 待判定值。
 * @returns {number} 合法时原值，否则 0。
 */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 一次请求的计费样本：优先取事件自带的 usage，其次取流记录里最后一个 usage 块。
 * @param {any} data - assistant/message 或 assistant/attempt 事件数据。
 * @returns {any | undefined} TokenUsage。
 */
function usageOf(data) {
  if (data === null || typeof data !== 'object') return undefined
  if (data.usage !== undefined) return data.usage
  const stream = Array.isArray(data.stream) ? data.stream : []
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record !== null && typeof record === 'object'
      && record.type === 'chunk' && record.chunk !== null && typeof record.chunk === 'object'
      && record.chunk.type === 'usage') {
      return record.chunk.usage
    }
  }
  return undefined
}

/**
 * 永久化后的助手消息自带提供方与模型。
 * @param {any} data - assistant/message 事件数据。
 * @returns {{provider: string, model: string} | null} 路由。
 */
function routeOfMessage(data) {
  const source = data?.message?.source
  if (source === null || typeof source !== 'object') return null
  if (typeof source.provider !== 'string' || typeof source.model !== 'string') return null
  return { provider: source.provider, model: source.model }
}

/**
 * 一步请求的替换槽键。
 * @param {unknown} turn - 回合号。
 * @param {unknown} step - 步号。
 * @returns {string | null} 键或 null。
 */
function stepKey(turn, step) {
  if (typeof turn !== 'number' || typeof step !== 'number') return null
  return turn + ':' + step
}

/**
 * 把一次计费样本并入当前回合。
 * 同一步的多次样本按「替换」语义处理（与 token-meter 的 tokenUsage 投影一致）：
 * 重试会先关闭替换槽，因此被重试的计费尝试会累加而不是被覆盖。
 * @param {{turn: number, rows: any[], slots: Record<string, number>}} turnState - 当前回合状态。
 * @param {any} event - 事件。
 * @param {{provider: string, model: string} | null} route - 当前请求路由。
 * @returns {{turn: number, rows: any[], slots: Record<string, number>}} 新回合状态。
 */
function foldSample(turnState, event, route) {
  const sample = usageOf(event.data)
  if (sample === undefined) return turnState
  const turn = event.data?.turn
  const step = event.data?.step
  if (typeof turn !== 'number') return turnState

  let state = turnState
  if (state.turn !== turn) state = { turn, rows: [], slots: {} }

  const model = event.type === 'assistant/message' ? (routeOfMessage(event.data) ?? route) : route
  const row = {
    i: count(sample.inputTokens),
    o: count(sample.outputTokens),
    r: count(sample.cacheReadTokens),
    w: count(sample.cacheWriteTokens),
    m: model === null ? 'unknown' : model.provider + '/' + model.model,
    p: isPeak(event.time) ? 1 : 0,
  }
  const key = stepKey(turn, step)
  const index = key === null ? undefined : state.slots[key]
  const rows = state.rows.slice()
  const slots = { ...state.slots }
  if (typeof index === 'number' && rows[index] !== undefined) {
    rows[index] = row
  } else {
    rows.push(row)
    if (key !== null) slots[key] = rows.length - 1
  }
  return { turn, rows, slots }
}

/**
 * 折叠一个会话事件。
 * @param {any} state - 投影状态。
 * @param {any} event - 会话事件。
 * @returns {any} 新状态；无关事件返回同一引用。
 */
function fold(state, event) {
  const type = event?.type
  if (type === 'turn/start') {
    const turn = event.data?.turn
    if (typeof turn !== 'number') return state
    if (state.cur !== null && state.cur.turn === turn) return state
    return { ...state, cur: { turn, rows: [], slots: {} } }
  }

  if (type === 'turn/end') {
    const turn = event.data?.turn
    if (state.cur === null || state.cur.turn !== turn) return state
    return { ...state, cur: null, prev: { turn: state.cur.turn, rows: state.cur.rows } }
  }

  if (type === 'request/header') {
    const config = event.data?.header?.config
    if (config === null || typeof config !== 'object') return state
    if (typeof config.provider !== 'string' || typeof config.model !== 'string') return state
    const route = { provider: config.provider, model: config.model }
    if (state.route !== null && state.route.provider === route.provider && state.route.model === route.model) {
      return state
    }
    return { ...state, route }
  }

  if (type === 'request/context') {
    const data = event.data
    if (data === null || typeof data !== 'object') return state
    if (typeof data.provider !== 'string' || typeof data.model !== 'string') return state
    const route = { provider: data.provider, model: data.model }
    if (state.route !== null && state.route.provider === route.provider && state.route.model === route.model) {
      return state
    }
    return { ...state, route }
  }

  if (type === 'llm/retry-started') {
    if (state.cur === null) return state
    const key = stepKey(event.data?.turn, event.data?.step)
    if (key === null || state.cur.slots[key] === undefined) return state
    const slots = { ...state.cur.slots }
    delete slots[key]
    return { ...state, cur: { ...state.cur, slots } }
  }

  if (type === 'assistant/message' || type === 'assistant/attempt') {
    if (state.cur === null) {
      const turn = event.data?.turn
      if (typeof turn !== 'number') return state
      return { ...state, cur: foldSample({ turn, rows: [], slots: {} }, event, state.route) }
    }
    const next = foldSample(state.cur, event, state.route)
    if (next === state.cur) return state
    return { ...state, cur: next }
  }

  return state
}

/**
 * 把一个回合的计费样本折算成展示值。
 * @param {{turn: number, rows: any[]} | null} turnState - 回合状态。
 * @returns {any | null} 展示值；没有计费样本时为 null。
 */
function summarize(turnState) {
  if (turnState === null || turnState.rows.length === 0) return null
  let cost = 0
  let estimated = false
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  const models = []
  for (const row of turnState.rows) {
    const price = priceFor(row.m)
    if (!price.known) estimated = true
    const factor = row.p === 1 ? PEAK_FACTOR : 1
    cost += ((row.i + row.w) * price.input * factor) / 1e6
    cost += (row.r * price.cacheRead * factor) / 1e6
    cost += (row.o * price.output * factor) / 1e6
    tokens.input += row.i
    tokens.cacheRead += row.r
    tokens.cacheWrite += row.w
    tokens.output += row.o
    if (!models.includes(row.m)) models.push(row.m)
  }
  return {
    turn: turnState.turn,
    cost: Math.round(cost * 1e6) / 1e6,
    currency: CURRENCY,
    estimated,
    tokens,
    models,
  }
}

/** 只做形状透传：状态由本插件自己产生，持久化恢复无需二次校验。 */
const identitySchema = {
  parse(value) {
    return value
  },
}

/** 会话投影定义。 */
const turnSpendProjection = {
  key: 'turnSpend',
  stateVersion: 1,
  stateSchema: identitySchema,
  init: () => ({ cur: null, prev: null, route: null }),
  apply: fold,
  wire: {
    viewSchema: identitySchema,
    view: (state) => ({
      current: summarize(state.cur),
      last: summarize(state.prev),
    }),
  },
}

/** 必需服务：没有投影注册表时插件不激活。 */
export const inject = ['sessionProjections']

/**
 * 激活插件。
 * @param {any} ctx - Host 插件上下文。
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.sessionProjections.register(turnSpendProjection),
    'turn-cost: session projection',
  )
}
