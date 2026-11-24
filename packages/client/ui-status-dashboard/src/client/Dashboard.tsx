/**
 * Right-sidebar status page. Live Session and job facts come from injected
 * selector hooks; file counts are a bounded snapshot refreshed on demand.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import Chart from 'react-apexcharts'
import type { ApexOptions } from 'apexcharts'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  InjectFace, PropsLocale, PropsRuntime, TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { NS } from './locales.ts'
import css from './Dashboard.module.css'

/** Registration-side services and observable sources for the dashboard. */
export interface DashboardInjected {
  /** Complete-file bytes used by the fund panel and host metrics snapshots. */
  readFile: ClientRemote['workspaceFiles']['readBytes']
}

/** Full composed props of the status page. */
export type DashboardProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<typeof NS>
  & InjectFace<DashboardInjected>

const FUND_PANEL_PATH = 'scripts/fund_panel.json'
/** host_metrics.py 每分钟刷新的主机指标快照（Pi 上由 cron 生成）。 */
const HOST_METRICS_PATH = 'scripts/scheduled-reports/logs/host_metrics.json'
/** 量化闸门快照：scripts/export_quant_panel.py 由指数日线计算并落盘。 */
const QUANT_PANEL_PATH = 'scripts/quant_panel.json'
/** 消息面与股票池快照：news_collect.py 出摘要后调用 export_insight_panel.py 刷新。 */
const INSIGHT_PANEL_PATH = 'scripts/insight_panel.json'
const CHART_HEIGHT = 150

/** Theme tokens ApexCharts needs as concrete colors (it cannot resolve CSS variables). */
const CHART_TOKENS = {
  business: '--dsw-alias-state-business-primary',
  success: '--dsw-alias-state-success-primary',
  warning: '--dsw-alias-state-warning-primary',
  error: '--dsw-alias-state-error-primary',
  muted: '--dsw-alias-label-tertiary',
  border: '--dsw-alias-border-l2',
  surface: '--dsw-alias-bg-layer-1',
  text: '--dsw-alias-label-primary',
  textMuted: '--dsw-alias-label-tertiary',
} as const

type ChartPalette = { readonly [Key in keyof typeof CHART_TOKENS]: string }

const FALLBACK_PALETTE: ChartPalette = {
  business: '#4f6ef7',
  success: '#2f9e66',
  warning: '#c98a16',
  error: '#d9534f',
  muted: '#8a9099',
  border: '#e3e5e9',
  surface: '#ffffff',
  text: '#1f2329',
  textMuted: '#8a9099',
}

/** Resolve semantic tokens on the chart container and follow theme attribute changes. */
function useChartPalette(ref: RefObject<HTMLElement>): ChartPalette {
  const [palette, setPalette] = useState<ChartPalette>(FALLBACK_PALETTE)
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const read = (): void => {
      const styles = getComputedStyle(element)
      const next: Record<string, string> = { ...FALLBACK_PALETTE }
      for (const [key, token] of Object.entries(CHART_TOKENS)) {
        const value = styles.getPropertyValue(token).trim()
        if (value !== '') next[key] = value
      }
      setPalette(next as ChartPalette)
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    })
    return () => { observer.disconnect() }
  }, [ref])
  return palette
}

/** 手机窄屏（与 CSS 断点一致）：关闭图表的拖拽框选缩放。 */
function useCompactViewport(): boolean {
  const query = '(max-width: 759px)'
  const [compact, setCompact] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const listener = (): void => { setCompact(media.matches) }
    listener()
    media.addEventListener('change', listener)
    return () => { media.removeEventListener('change', listener) }
  }, [])
  return compact
}

/** 首次拿到数值时从 0 递增；后续刷新直接跳到新值，不重复播放。 */
function useCountUp(target: number | undefined, duration = 600): number | undefined {
  const [shown, setShown] = useState(target)
  const played = useRef(false)
  useEffect(() => {
    if (target === undefined) return
    if (played.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      played.current = true
      setShown(target)
      return
    }
    played.current = true
    let frame = 0
    const start = performance.now()
    const tick = (now: number): void => {
      // rAF 的时间戳可能略早于注册时刻，钳制后避免首帧出现负值。
      const progress = Math.max(0, Math.min(1, (now - start) / duration))
      setShown(target * (1 - (1 - progress) ** 3))
      if (progress < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(frame) }
  }, [target, duration])
  return shown
}

interface FundTrade {
  readonly date: string
  readonly action: 'buy' | 'sell'
  readonly amount: number
}

interface FundNavPoint {
  readonly date: string
  readonly nav: number
}

interface FundRecord {
  readonly code: string
  readonly name: string
  readonly holding: boolean
  readonly shares: number
  readonly cost: number
  readonly nav: number
  readonly navDate: string
  readonly trades: readonly FundTrade[]
  readonly history: readonly FundNavPoint[]
}

interface FundSnapshot {
  readonly asOf: string
  readonly source: string
  readonly note: string
  readonly funds: readonly FundRecord[]
}

type FundState =
  | { readonly status: 'loading' | 'error' | 'missing' | 'invalid' }
  | { readonly status: 'ready'; readonly snapshot: FundSnapshot }

interface HostMemory {
  readonly usedBytes: number
  readonly totalBytes: number
  readonly percent: number
}

interface HostMetrics {
  readonly asOf: string
  readonly host: string
  readonly cpu: number
  readonly memory: HostMemory
  readonly temperature: number | null
}

type HostState =
  | { readonly status: 'loading' | 'error' | 'missing' | 'invalid' }
  | { readonly status: 'ready'; readonly metrics: HostMetrics }

interface GatePoint {
  readonly date: string
  readonly close: number
  readonly ma: number
}

interface GateProjection {
  readonly days: number
  readonly needPct: number
}

interface GateValuation {
  readonly closePercentile: number | null
  readonly closeMin: number
  readonly closeMax: number
  readonly devPercentile: number | null
  readonly devMin: number
  readonly devMax: number
  readonly tier: number
  readonly reasons: readonly string[]
  readonly windowDays: number
  readonly windowFrom: string
  readonly windowTo: string
}

/** 单道牛熊闸门：指数收盘 vs 长期均线，关闭时策略强制空仓。 */
interface GateRecord {
  readonly kind: string
  readonly title: string
  readonly idxName: string
  readonly strat: string
  readonly date: string
  readonly maN: number
  readonly close: number
  readonly ma: number
  readonly devPct: number
  readonly open: boolean
  readonly needPct: number
  readonly slope: number
  readonly series: readonly GatePoint[]
  readonly projection: readonly GateProjection[]
  readonly valuation: GateValuation
}

interface SimPosition {
  readonly code: string
  readonly name: string
  readonly shares: number
  readonly avgCost: number
  readonly costValue: number
  readonly weightPct: number
}

interface SimSignal {
  readonly code: string
  readonly name: string
  readonly side: 'buy' | 'sell'
  readonly value: number
  readonly note: string
}

interface SimTrade {
  readonly date: string
  readonly code: string
  readonly name: string
  readonly side: 'buy' | 'sell'
  readonly shares: number
  readonly price: number
}

interface SimPoint {
  readonly date: string
  readonly equity: number
  readonly nav: number
}

/** 单套模拟盘：账户快照 + 净值曲线 + 持仓 / 次日信号 / 最近成交。 */
interface SimRecord {
  readonly kind: string
  readonly title: string
  readonly strat: string
  readonly simStart: string
  readonly asOf: string
  readonly startCash: number
  readonly equity: number
  readonly cash: number
  readonly returnPct: number
  readonly maxDrawdownPct: number
  readonly cashPct: number
  readonly positions: readonly SimPosition[]
  readonly signals: readonly SimSignal[]
  readonly trades: readonly SimTrade[]
  readonly series: readonly SimPoint[]
}

interface QuantSnapshot {
  readonly asOf: string
  readonly source: string
  readonly simSource: string
  readonly gates: readonly GateRecord[]
  readonly sims: readonly SimRecord[]
}

type QuantState =
  | { readonly status: 'loading' | 'error' | 'missing' | 'invalid' }
  | { readonly status: 'ready'; readonly snapshot: QuantSnapshot }

/** 一条新闻（面板只保留标题级信息）。 */
interface NewsItem {
  readonly time: string
  readonly source: string
  readonly title: string
  readonly score: number
  readonly tier: string
  readonly tags: readonly string[]
  readonly sentiment: string
}

/** 某只持仓在消息面里的命中统计与头条。 */
interface NewsHolding {
  readonly code: string
  readonly name: string
  readonly count: number
  readonly items: readonly NewsItem[]
}

interface NewsTheme {
  readonly name: string
  readonly count: number
}

interface NewsHealth {
  readonly source: string
  readonly ok: boolean
  readonly count: number
}

interface NewsRecord {
  readonly asOf: string
  readonly hours: number
  readonly total: number
  readonly sTier: number
  readonly aTier: number
  readonly holdingsHit: number
  readonly macro: number
  readonly policy: number
  readonly holdings: readonly NewsHolding[]
  readonly themes: readonly NewsTheme[]
  readonly health: readonly NewsHealth[]
  readonly digest: string
}

type PoolKind = 'initial' | 'insight' | 'surge' | 'doc' | 'mail' | 'other'

interface PoolHolding {
  readonly code: string
  readonly name: string
  readonly etf: string
  readonly icon: string
}

interface PoolKindCount {
  readonly kind: PoolKind
  readonly count: number
}

interface PoolRecent {
  readonly date: string
  readonly code: string
  readonly name: string
  readonly kind: PoolKind
}

interface PoolRecord {
  readonly asOf: string
  readonly holdings: readonly PoolHolding[]
  readonly watchCount: number
  readonly byKind: readonly PoolKindCount[]
  readonly recent: readonly PoolRecent[]
}

interface InsightSnapshot {
  readonly asOf: string
  readonly news: NewsRecord | undefined
  readonly pool: PoolRecord | undefined
  readonly newsSource: string
  readonly poolSource: string
}

type InsightState =
  | { readonly status: 'loading' | 'error' | 'missing' | 'invalid' }
  | { readonly status: 'ready'; readonly snapshot: InsightSnapshot }

const POOL_KIND_KEY = {
  initial: 'pool.kind.initial',
  insight: 'pool.kind.insight',
  surge: 'pool.kind.surge',
  doc: 'pool.kind.doc',
  mail: 'pool.kind.mail',
  other: 'pool.kind.other',
} as const

const POOL_KINDS: readonly PoolKind[] = ['insight', 'surge', 'doc', 'mail', 'initial', 'other']

type FundRangeKey = '1m' | '3m' | '6m' | '1y' | 'all'

/** 时间维度：天数为 0 表示全部历史。 */
const FUND_RANGES: readonly { readonly key: FundRangeKey; readonly days: number }[] = [
  { key: '1m', days: 30 },
  { key: '3m', days: 90 },
  { key: '6m', days: 180 },
  { key: '1y', days: 365 },
  { key: 'all', days: 0 },
]

/** 估算加仓滑块的取值范围与步长（元）。 */
const ADD_ON_MAX = 50_000
const ADD_ON_STEP = 500

const FUND_RANGE_LABEL = {
  '1m': 'fund.range1m',
  '3m': 'fund.range3m',
  '6m': 'fund.range6m',
  '1y': 'fund.range1y',
  'all': 'fund.rangeAll',
} as const

const DAY_MS = 86_400_000

interface FundPoint {
  readonly x: number
  readonly y: number
}

/** 收益率曲线的拆段点：y 为 null 表示断线，避免跨区间连成直线。 */
interface ReturnPoint {
  readonly x: number
  readonly y: number | null
}

interface FundMarker {
  /** 净值日期时间戳，正好对齐 datetime 轴。 */
  readonly x: number
  /** 交易当日净值。 */
  readonly y: number
  readonly action: 'buy' | 'sell'
}

interface FundChartGeometry {
  readonly navSeries: readonly FundPoint[]
  readonly returnUp: readonly ReturnPoint[]
  readonly returnDown: readonly ReturnPoint[]
  readonly markers: readonly FundMarker[]
  readonly startDate: string
  readonly endDate: string
  readonly rangeReturn: number
  readonly navMin: number
  readonly navMax: number
  readonly returnMin: number
  readonly returnMax: number
  readonly costVisible: boolean
  /** 在持基金的成本净值；非在持为 undefined，两张图共用。 */
  readonly costNav: number | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate the exported fund panel at the workspace boundary. */
function parseFundSnapshot(text: string): FundSnapshot {
  const root: unknown = JSON.parse(text)
  if (!isRecord(root) || !Array.isArray(root.funds)) {
    throw new Error('Invalid fund-panel root')
  }
  const funds = root.funds.map((raw) => {
    if (!isRecord(raw) || typeof raw.code !== 'string' || typeof raw.name !== 'string'
      || typeof raw.holding !== 'boolean' || typeof raw.shares !== 'number'
      || typeof raw.cost !== 'number' || typeof raw.nav !== 'number'
      || typeof raw.nav_date !== 'string'
      || !Array.isArray(raw.trades) || !Array.isArray(raw.history)) {
      throw new Error('Invalid fund row')
    }
    const trades = raw.trades.map((rawTrade) => {
      if (!isRecord(rawTrade) || typeof rawTrade.date !== 'string'
        || (rawTrade.action !== 'buy' && rawTrade.action !== 'sell')
        || typeof rawTrade.amount !== 'number') {
        throw new Error('Invalid fund trade')
      }
      const action: 'buy' | 'sell' = rawTrade.action === 'buy' ? 'buy' : 'sell'
      return { date: rawTrade.date, action, amount: rawTrade.amount }
    })
    const history = raw.history.map((rawPoint) => {
      if (!isRecord(rawPoint) || typeof rawPoint.date !== 'string'
        || typeof rawPoint.nav !== 'number' || rawPoint.nav <= 0) {
        throw new Error('Invalid fund nav point')
      }
      return { date: rawPoint.date, nav: rawPoint.nav }
    })
    return {
      code: raw.code,
      name: raw.name,
      holding: raw.holding,
      shares: raw.shares,
      cost: raw.cost,
      nav: raw.nav,
      navDate: raw.nav_date,
      trades,
      history,
    }
  })
  return {
    asOf: typeof root.as_of === 'string' ? root.as_of : '',
    source: typeof root.source === 'string' ? root.source : '',
    note: typeof root.note === 'string' ? root.note : '',
    funds,
  }
}

async function loadFundState(
  sessionId: SessionId,
  readFile: ClientRemote['workspaceFiles']['readBytes'],
  signal: AbortSignal,
): Promise<FundState> {
  const result = await readFile(sessionId, FUND_PANEL_PATH, {}, signal)
  if (!result.ok) {
    if (result.error.code === 'workspace-file/not-found') return { status: 'missing' }
    throw new Error(result.error.message)
  }
  try {
    return { status: 'ready', snapshot: parseFundSnapshot(new TextDecoder().decode(result.value.data)) }
  } catch {
    return { status: 'invalid' }
  }
}

/** Validate the host snapshot written by scripts/host_metrics.py. */
function parseHostMetrics(text: string): HostMetrics {
  const root: unknown = JSON.parse(text)
  if (!isRecord(root) || typeof root.as_of !== 'string' || typeof root.host !== 'string'
    || typeof root.cpu_percent !== 'number' || !isRecord(root.memory)) {
    throw new Error('Invalid host metrics')
  }
  const memory = root.memory
  if (typeof memory.used_bytes !== 'number' || typeof memory.total_bytes !== 'number'
    || typeof memory.percent !== 'number') {
    throw new Error('Invalid host memory')
  }
  return {
    asOf: root.as_of,
    host: root.host,
    cpu: root.cpu_percent,
    memory: {
      usedBytes: memory.used_bytes,
      totalBytes: memory.total_bytes,
      percent: memory.percent,
    },
    temperature: typeof root.temperature_c === 'number' ? root.temperature_c : null,
  }
}

async function loadHostState(
  sessionId: SessionId,
  readFile: ClientRemote['workspaceFiles']['readBytes'],
  signal: AbortSignal,
): Promise<HostState> {
  const result = await readFile(sessionId, HOST_METRICS_PATH, {}, signal)
  if (!result.ok) {
    if (result.error.code === 'workspace-file/not-found') return { status: 'missing' }
    throw new Error(result.error.message)
  }
  try {
    return { status: 'ready', metrics: parseHostMetrics(new TextDecoder().decode(result.value.data)) }
  } catch {
    return { status: 'invalid' }
  }
}

/** Validate the quant gate snapshot exported by scripts/export_quant_panel.py. */
function parseQuantSnapshot(text: string): QuantSnapshot {
  const root: unknown = JSON.parse(text)
  if (!isRecord(root) || !Array.isArray(root.gates)) throw new Error('Invalid quant-panel root')
  const gates = root.gates.map((raw) => {
    if (!isRecord(raw) || typeof raw.kind !== 'string' || typeof raw.title !== 'string'
      || typeof raw.idx_name !== 'string' || typeof raw.strat !== 'string'
      || typeof raw.date !== 'string' || typeof raw.ma_n !== 'number'
      || typeof raw.close !== 'number' || typeof raw.ma !== 'number'
      || typeof raw.dev_pct !== 'number' || typeof raw.open !== 'boolean'
      || typeof raw.need_pct !== 'number' || typeof raw.ma_slope_20d !== 'number'
      || !Array.isArray(raw.series) || !Array.isArray(raw.projection)) {
      throw new Error('Invalid quant gate')
    }
    const series = raw.series.map((rawPoint) => {
      if (!isRecord(rawPoint) || typeof rawPoint.date !== 'string'
        || typeof rawPoint.close !== 'number' || typeof rawPoint.ma !== 'number') {
        throw new Error('Invalid gate point')
      }
      return { date: rawPoint.date, close: rawPoint.close, ma: rawPoint.ma }
    })
    const projection = raw.projection.map((rawItem) => {
      if (!isRecord(rawItem) || typeof rawItem.days !== 'number'
        || typeof rawItem.need_pct !== 'number') {
        throw new Error('Invalid gate projection')
      }
      return { days: rawItem.days, needPct: rawItem.need_pct }
    })
    const v = isRecord(raw.valuation) ? raw.valuation : {}
    const valuation: GateValuation = {
      closePercentile: typeof v.close_percentile === 'number' ? v.close_percentile : null,
      closeMin: typeof v.close_min === 'number' ? v.close_min : 0,
      closeMax: typeof v.close_max === 'number' ? v.close_max : 1,
      devPercentile: typeof v.dev_percentile === 'number' ? v.dev_percentile : null,
      devMin: typeof v.dev_min === 'number' ? v.dev_min : -10,
      devMax: typeof v.dev_max === 'number' ? v.dev_max : 10,
      tier: typeof v.tier === 'number' ? v.tier : 0,
      reasons: Array.isArray(v.reasons) ? v.reasons.filter((r): r is string => typeof r === 'string') : [],
      windowDays: typeof v.window_days === 'number' ? v.window_days : 0,
      windowFrom: typeof v.window_from === 'string' ? v.window_from : '',
      windowTo: typeof v.window_to === 'string' ? v.window_to : '',
    }
    return {
      kind: raw.kind,
      title: raw.title,
      idxName: raw.idx_name,
      strat: raw.strat,
      date: raw.date,
      maN: raw.ma_n,
      close: raw.close,
      ma: raw.ma,
      devPct: raw.dev_pct,
      open: raw.open,
      needPct: raw.need_pct,
      slope: raw.ma_slope_20d,
      series,
      projection,
      valuation,
    }
  })
  const sims = Array.isArray(root.sims) ? root.sims.map(parseSimRecord) : []
  return {
    asOf: typeof root.as_of === 'string' ? root.as_of : '',
    source: typeof root.source === 'string' ? root.source : '',
    simSource: typeof root.sim_source === 'string' ? root.sim_source : '',
    gates,
    sims,
  }
}

/** Validate one simulated account exported alongside the gates. */
function parseSimRecord(raw: unknown): SimRecord {
  if (!isRecord(raw) || typeof raw.kind !== 'string' || typeof raw.title !== 'string'
    || typeof raw.strat !== 'string' || typeof raw.sim_start !== 'string'
    || typeof raw.as_of !== 'string' || typeof raw.start_cash !== 'number'
    || typeof raw.equity !== 'number' || typeof raw.cash !== 'number'
    || typeof raw.return_pct !== 'number' || typeof raw.max_drawdown_pct !== 'number'
    || typeof raw.cash_pct !== 'number' || !Array.isArray(raw.positions)
    || !Array.isArray(raw.signals) || !Array.isArray(raw.trades) || !Array.isArray(raw.series)) {
    throw new Error('Invalid sim record')
  }
  const positions = raw.positions.map((rawPos) => {
    if (!isRecord(rawPos) || typeof rawPos.code !== 'string' || typeof rawPos.name !== 'string'
      || typeof rawPos.shares !== 'number' || typeof rawPos.avg_cost !== 'number'
      || typeof rawPos.cost_value !== 'number' || typeof rawPos.weight_pct !== 'number') {
      throw new Error('Invalid sim position')
    }
    return {
      code: rawPos.code,
      name: rawPos.name,
      shares: rawPos.shares,
      avgCost: rawPos.avg_cost,
      costValue: rawPos.cost_value,
      weightPct: rawPos.weight_pct,
    }
  })
  const signals = raw.signals.map((rawSignal) => {
    if (!isRecord(rawSignal) || typeof rawSignal.code !== 'string'
      || typeof rawSignal.name !== 'string'
      || (rawSignal.side !== 'buy' && rawSignal.side !== 'sell')
      || typeof rawSignal.value !== 'number' || typeof rawSignal.note !== 'string') {
      throw new Error('Invalid sim signal')
    }
    const side: 'buy' | 'sell' = rawSignal.side === 'buy' ? 'buy' : 'sell'
    return {
      code: rawSignal.code, name: rawSignal.name, side, value: rawSignal.value, note: rawSignal.note,
    }
  })
  const trades = raw.trades.map((rawTrade) => {
    if (!isRecord(rawTrade) || typeof rawTrade.date !== 'string'
      || typeof rawTrade.code !== 'string' || typeof rawTrade.name !== 'string'
      || (rawTrade.side !== 'buy' && rawTrade.side !== 'sell')
      || typeof rawTrade.shares !== 'number' || typeof rawTrade.price !== 'number') {
      throw new Error('Invalid sim trade')
    }
    const side: 'buy' | 'sell' = rawTrade.side === 'buy' ? 'buy' : 'sell'
    return {
      date: rawTrade.date, code: rawTrade.code, name: rawTrade.name,
      side, shares: rawTrade.shares, price: rawTrade.price,
    }
  })
  const series = raw.series.map((rawPoint) => {
    if (!isRecord(rawPoint) || typeof rawPoint.date !== 'string'
      || typeof rawPoint.equity !== 'number' || typeof rawPoint.nav !== 'number') {
      throw new Error('Invalid sim point')
    }
    return { date: rawPoint.date, equity: rawPoint.equity, nav: rawPoint.nav }
  })
  return {
    kind: raw.kind,
    title: raw.title,
    strat: raw.strat,
    simStart: raw.sim_start,
    asOf: raw.as_of,
    startCash: raw.start_cash,
    equity: raw.equity,
    cash: raw.cash,
    returnPct: raw.return_pct,
    maxDrawdownPct: raw.max_drawdown_pct,
    cashPct: raw.cash_pct,
    positions,
    signals,
    trades,
    series,
  }
}

async function loadQuantState(
  sessionId: SessionId,
  readFile: ClientRemote['workspaceFiles']['readBytes'],
  signal: AbortSignal,
): Promise<QuantState> {
  const result = await readFile(sessionId, QUANT_PANEL_PATH, {}, signal)
  if (!result.ok) {
    if (result.error.code === 'workspace-file/not-found') return { status: 'missing' }
    throw new Error(result.error.message)
  }
  try {
    return { status: 'ready', snapshot: parseQuantSnapshot(new TextDecoder().decode(result.value.data)) }
  } catch {
    return { status: 'invalid' }
  }
}

function parseNewsItem(raw: unknown): NewsItem {
  if (!isRecord(raw) || typeof raw.time !== 'string' || typeof raw.source !== 'string'
    || typeof raw.title !== 'string') {
    throw new Error('Invalid news item')
  }
  return {
    time: raw.time,
    source: raw.source,
    title: raw.title,
    score: typeof raw.score === 'number' ? raw.score : 0,
    tier: typeof raw.tier === 'string' ? raw.tier : '',
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    sentiment: typeof raw.sentiment === 'string' ? raw.sentiment : '',
  }
}

function parsePoolKind(value: unknown): PoolKind {
  if (value === 'initial' || value === 'insight' || value === 'surge'
    || value === 'doc' || value === 'mail') {
    return value
  }
  return 'other'
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback
}

/** Validate the news + pool snapshot exported by scripts/export_insight_panel.py. */
function parseInsightSnapshot(text: string): InsightSnapshot {
  const root: unknown = JSON.parse(text)
  if (!isRecord(root)) throw new Error('Invalid insight-panel root')
  let news: NewsRecord | undefined
  if (isRecord(root.news)) {
    const raw = root.news
    news = {
      asOf: typeof raw.as_of === 'string' ? raw.as_of : '',
      hours: numberOr(raw.hours, 24),
      total: numberOr(raw.total, 0),
      sTier: numberOr(raw.s_tier, 0),
      aTier: numberOr(raw.a_tier, 0),
      holdingsHit: numberOr(raw.holdings_hit, 0),
      macro: numberOr(raw.macro, 0),
      policy: numberOr(raw.policy, 0),
      holdings: Array.isArray(raw.holdings) ? raw.holdings.map((item) => {
        if (!isRecord(item) || typeof item.code !== 'string' || typeof item.name !== 'string'
          || typeof item.count !== 'number') {
          throw new Error('Invalid news holding')
        }
        return {
          code: item.code,
          name: item.name,
          count: item.count,
          items: Array.isArray(item.items) ? item.items.map(parseNewsItem) : [],
        }
      }) : [],
      themes: Array.isArray(raw.themes) ? raw.themes.map((item) => {
        if (!isRecord(item) || typeof item.name !== 'string' || typeof item.count !== 'number') {
          throw new Error('Invalid news theme')
        }
        return { name: item.name, count: item.count }
      }) : [],
      health: Array.isArray(raw.health) ? raw.health.map((item) => {
        if (!isRecord(item) || typeof item.source !== 'string'
          || typeof item.ok !== 'boolean' || typeof item.count !== 'number') {
          throw new Error('Invalid news health')
        }
        return { source: item.source, ok: item.ok, count: item.count }
      }) : [],
      digest: typeof raw.digest === 'string' ? raw.digest : '',
    }
  }
  let pool: PoolRecord | undefined
  if (isRecord(root.pool)) {
    const raw = root.pool
    pool = {
      asOf: typeof raw.as_of === 'string' ? raw.as_of : '',
      holdings: Array.isArray(raw.holdings) ? raw.holdings.map((item) => {
        if (!isRecord(item) || typeof item.code !== 'string' || typeof item.name !== 'string') {
          throw new Error('Invalid pool holding')
        }
        return {
          code: item.code,
          name: item.name,
          etf: typeof item.etf === 'string' ? item.etf : '',
          icon: typeof item.icon === 'string' ? item.icon : '',
        }
      }) : [],
      watchCount: numberOr(raw.watch_count, 0),
      byKind: Array.isArray(raw.by_kind) ? raw.by_kind.map((item) => {
        if (!isRecord(item) || typeof item.count !== 'number') throw new Error('Invalid pool kind')
        return { kind: parsePoolKind(item.kind), count: item.count }
      }) : [],
      recent: Array.isArray(raw.recent) ? raw.recent.map((item) => {
        if (!isRecord(item) || typeof item.date !== 'string' || typeof item.code !== 'string'
          || typeof item.name !== 'string') {
          throw new Error('Invalid pool recent')
        }
        return { date: item.date, code: item.code, name: item.name, kind: parsePoolKind(item.kind) }
      }) : [],
    }
  }
  return {
    asOf: typeof root.as_of === 'string' ? root.as_of : '',
    news,
    pool,
    newsSource: typeof root.news_source === 'string' ? root.news_source : '',
    poolSource: typeof root.pool_source === 'string' ? root.pool_source : '',
  }
}

async function loadInsightState(
  sessionId: SessionId,
  readFile: ClientRemote['workspaceFiles']['readBytes'],
  signal: AbortSignal,
): Promise<InsightState> {
  const result = await readFile(sessionId, INSIGHT_PANEL_PATH, {}, signal)
  if (!result.ok) {
    if (result.error.code === 'workspace-file/not-found') return { status: 'missing' }
    throw new Error(result.error.message)
  }
  try {
    return { status: 'ready', snapshot: parseInsightSnapshot(new TextDecoder().decode(result.value.data)) }
  } catch {
    return { status: 'invalid' }
  }
}

/** 按当前净值估算加仓后的持仓成本；只做推演，不写回交易记录。 */
function simulateAddOn(fund: FundRecord, amount: number): number | undefined {
  if (!fund.holding || fund.shares <= 0 || fund.cost <= 0 || fund.nav <= 0 || amount <= 0) return undefined
  return (fund.shares * fund.cost + amount) / (fund.shares + amount / fund.nav)
}

/** Project a fund's NAV history into a trend series plus a cost-relative return curve. */
function buildFundChart(fund: FundRecord, range: FundRangeKey, costOverride?: number): FundChartGeometry | undefined {
  const history = sliceFundHistory(fund.history, range)
  const first = history[0]
  const last = history[history.length - 1]
  if (first === undefined || last === undefined || history.length < 2) return undefined
  const startTs = toTimestamp(first.date)
  const endTs = toTimestamp(last.date)
  const navSeries = history.map(point => ({ x: toTimestamp(point.date), y: point.nav }))
  const rangeReturn = last.nav / first.nav - 1
  // 在持时以成本净值作为收益率基准，成本线即 0%；估算加仓时用推算成本替换。
  const costNav = costOverride ?? (fund.holding && fund.cost > 0 ? fund.cost : undefined)
  const baseNav = costNav ?? first.nav
  const returnPoints = history.map(point => ({
    x: toTimestamp(point.date),
    y: (point.nav / baseNav - 1) * 100,
  }))
  const { up, down } = splitReturnBySign(returnPoints)
  const markers: FundMarker[] = []
  const seen = new Set<string>()
  for (const trade of fund.trades) {
    const tradeTs = toTimestamp(trade.date)
    if (tradeTs < startTs || tradeTs > endTs) continue
    // 交易日期未必落在净值日期上，取当日或之后最近的一条净值。
    const point = history.find(item => toTimestamp(item.date) >= tradeTs) ?? last
    const key = `${point.date}-${trade.action}`
    if (seen.has(key)) continue
    seen.add(key)
    markers.push({
      x: toTimestamp(point.date),
      y: point.nav,
      action: trade.action,
    })
  }
  const navValues = [...navSeries.map(point => point.y), ...markers.map(marker => marker.y)]
  if (costNav !== undefined) navValues.push(costNav)
  const navLow = Math.min(...navValues)
  const navHigh = Math.max(...navValues)
  const navSpan = navHigh - navLow || navHigh * 0.01 || 0.01
  const returnValues = [...returnPoints.map(point => point.y), 0]
  const returnLow = Math.min(...returnValues)
  const returnHigh = Math.max(...returnValues)
  const returnSpan = returnHigh - returnLow || 0.01
  return {
    navSeries,
    returnUp: up,
    returnDown: down,
    markers,
    startDate: first.date,
    endDate: last.date,
    rangeReturn,
    navMin: navLow - navSpan * 0.08,
    navMax: navHigh + navSpan * 0.08,
    returnMin: Math.min(returnLow - returnSpan * 0.1, -0.5),
    returnMax: Math.max(returnHigh + returnSpan * 0.1, 0.5),
    costVisible: costNav !== undefined,
    costNav,
  }
}

/** 时间轴刻度文案：短区间显示月/日，长区间显示中文月份。 */
function formatAxisLabel(value: string, timestamp: number | undefined, spanDays: number): string {
  const time = timestamp ?? Number(value)
  if (Number.isNaN(time) || time <= 0) return value
  const date = new Date(time)
  const month = date.getMonth() + 1
  return spanDays <= 60 ? `${month}/${date.getDate()}` : `${month}月`
}

/** 悬停提示统一显示完整日期，与只到月份的坐标轴刻度区分开。 */
function formatTooltipDate(value: string | number): string {
  const time = Number(value)
  if (Number.isNaN(time) || time <= 0) return String(value)
  const date = new Date(time)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 净值走势图可叠加的均线窗口；配色避开买入红、卖出绿。 */
const MA_WINDOWS = [10, 60, 120] as const
type MaWindow = typeof MA_WINDOWS[number]
const MA_COLORS: Readonly<Record<MaWindow, string>> = {
  10: '#e8a33d',
  60: '#d158b8',
  120: '#8f6de0',
}

/** 用完整净值历史计算移动平均，再裁剪到当前区间起点之后。 */
function buildMovingAverages(history: readonly FundNavPoint[], startTs: number): Record<MaWindow, FundPoint[]> {
  const result: Record<MaWindow, FundPoint[]> = { 10: [], 60: [], 120: [] }
  for (const window of MA_WINDOWS) {
    let sum = 0
    for (let index = 0; index < history.length; index += 1) {
      const point = history[index]
      if (point === undefined) continue
      sum += point.nav
      const expired = index >= window ? history[index - window] : undefined
      if (expired !== undefined) sum -= expired.nav
      if (index < window - 1) continue
      const timestamp = toTimestamp(point.date)
      if (timestamp < startTs) continue
      result[window].push({ x: timestamp, y: sum / window })
    }
  }
  return result
}

function toTimestamp(date: string): number {
  const value = Date.parse(`${date}T00:00:00`)
  return Number.isNaN(value) ? 0 : value
}

/** 按时间维度截取净值历史，区间过短时至少保留两个点。 */
function sliceFundHistory(history: readonly FundNavPoint[], range: FundRangeKey): readonly FundNavPoint[] {
  const days = FUND_RANGES.find(item => item.key === range)?.days ?? 0
  const last = history[history.length - 1]
  if (days <= 0 || last === undefined) return history
  const cutoff = toTimestamp(last.date) - days * DAY_MS
  const start = history.findIndex(point => toTimestamp(point.date) >= cutoff)
  const index = start < 0 ? history.length - 2 : Math.min(start, history.length - 2)
  return history.slice(Math.max(index, 0))
}

/** 收益率曲线按零轴拆成涨跌两条序列，用于红涨绿跌着色。 */
function splitReturnBySign(points: readonly FundPoint[]): { up: ReturnPoint[]; down: ReturnPoint[] } {
  const up: ReturnPoint[] = []
  const down: ReturnPoint[] = []
  points.forEach((point, index) => {
    const positive = point.y >= 0
    if (positive) up.push(point)
    else down.push(point)
    const next = points[index + 1]
    if (next === undefined || (next.y >= 0) === positive) return
    // 在零轴插入交点，保证红绿两段在视觉上连续。
    const span = point.y - next.y
    const fraction = span === 0 ? 0 : point.y / span
    const crossing: ReturnPoint = { x: point.x + (next.x - point.x) * fraction, y: 0 }
    up.push(crossing)
    down.push(crossing)
    // 离开当前符号的一侧立刻断线，否则会沿零轴拖出一条直线。
    if (positive) up.push({ x: crossing.x, y: null })
    else down.push({ x: crossing.x, y: null })
  })
  return { up, down }
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`
}

function signedMoney(value: number, t: TranslateNS<typeof NS>): string {
  return `${value >= 0 ? '+' : '-'}${t('fund.money', { value: formatNumber(Math.abs(value)) })}`
}

/**
 * 单只基金两张图：上图为净值走势与买卖点，下图为相对成本的收益率（红涨绿跌）。
 * 两张图共用顶部的时间维度切换。
 */
function FundChart({ fund, t }: { fund: FundRecord; t: TranslateNS<typeof NS> }): ReactNode {
  const container = useRef<HTMLDivElement>(null)
  const palette = useChartPalette(container)
  const [range, setRange] = useState<FundRangeKey>('all')
  const compact = useCompactViewport()
  const [maOn, setMaOn] = useState<readonly MaWindow[]>([10, 60])
  // 估算加仓金额（元）：仅保存在本地状态，不改动持仓与流水。
  const [addOn, setAddOn] = useState(0)
  // 切换基金时清掉上一只的推演金额，避免估算结果被带过去。
  useEffect(() => { setAddOn(0) }, [fund.code])
  const simCost = useMemo(() => simulateAddOn(fund, addOn), [fund, addOn])
  const chart = useMemo(() => buildFundChart(fund, range, simCost), [fund, range, simCost])
  const costLabel = simCost === undefined ? t('fund.costLine') : t('fund.costLineEst')
  const maData = useMemo(
    () => chart === undefined ? undefined : buildMovingAverages(fund.history, toTimestamp(chart.startDate)),
    [fund.history, chart],
  )
  const spanDays = chart === undefined
    ? 0
    : (toTimestamp(chart.endDate) - toTimestamp(chart.startDate)) / 86_400_000
  const trendOptions = useMemo<ApexOptions>(() => {
    if (chart === undefined) return {}
    return {
      chart: {
        type: 'line',
        height: CHART_HEIGHT,
        toolbar: { show: false },
        zoom: { enabled: !compact, type: 'x', allowMouseWheelZoom: true },
        animations: { enabled: false },
        parentHeightOffset: 0,
        fontFamily: 'inherit',
        redrawOnParentResize: true,
      },
      colors: [palette.business, MA_COLORS[10], MA_COLORS[60], MA_COLORS[120]],
      stroke: { curve: 'straight', width: [1, 1, 1, 1] },
      markers: { size: 0, hover: { size: 3 } },
      dataLabels: { enabled: false },
      legend: { show: false },
      grid: { show: false, padding: { left: 2, right: 2, top: 6, bottom: 0 } },
      xaxis: {
        type: 'datetime',
        tickAmount: 4,
        axisBorder: { show: true, color: palette.border },
        axisTicks: { show: false },
        labels: {
          datetimeUTC: false,
          style: { colors: palette.textMuted, fontSize: '8px' },
          formatter: (value: string, timestamp?: number) => formatAxisLabel(value, timestamp, spanDays),
        },
      },
      yaxis: {
        min: chart.navMin,
        max: chart.navMax,
        tickAmount: 3,
        axisBorder: { show: false },
        axisTicks: { show: false },
        labels: {
          style: { colors: palette.textMuted, fontSize: '8px' },
          formatter: (value: number) => value.toFixed(3),
        },
      },
      tooltip: {
        // 悬停标题给完整日期，坐标轴刻度仍按月显示。
        x: { format: 'yyyy-MM-dd', formatter: (value: string | number) => formatTooltipDate(value) },
        y: { formatter: value => (value ?? 0).toFixed(4) },
      },
      annotations: {
        // 净值图上的成本线：与收益率图的 0% 基准是同一条成本净值。
        yaxis: chart.costNav === undefined ? [] : [{
          y: chart.costNav,
          borderColor: palette.textMuted,
          strokeDashArray: 4,
          label: {
            text: costLabel,
            position: 'right',
            textAnchor: 'end',
            offsetX: -4,
            borderWidth: 0,
            style: { background: 'transparent', color: palette.textMuted, fontSize: '8px' },
          },
        }],
        points: chart.markers.map(marker => ({
          x: marker.x,
          y: marker.y,
          marker: {
            size: 1.7,
            shape: 'circle',
            fillColor: marker.action === 'buy' ? palette.error : palette.success,
            strokeColor: palette.surface,
            strokeWidth: 0.5,
          },
        })),
      },
    }
  }, [chart, palette, costLabel, compact, spanDays])
  const returnOptions = useMemo<ApexOptions>(() => {
    if (chart === undefined) return {}
    const baseline = {
      y: 0,
      borderColor: chart.costVisible ? palette.textMuted : palette.border,
      strokeDashArray: chart.costVisible ? 4 : 0,
    }
    return {
      chart: {
        type: 'line',
        height: CHART_HEIGHT,
        toolbar: { show: false },
        zoom: { enabled: !compact, type: 'x', allowMouseWheelZoom: true },
        animations: { enabled: false },
        parentHeightOffset: 0,
        fontFamily: 'inherit',
        redrawOnParentResize: true,
      },
      // 中国习惯：正收益红色，负收益绿色。
      colors: [palette.error, palette.success],
      stroke: { curve: 'straight', width: 1 },
      markers: { size: 0, hover: { size: 3 } },
      dataLabels: { enabled: false },
      legend: { show: false },
      grid: { show: false, padding: { left: 2, right: 2, top: 6, bottom: 0 } },
      xaxis: {
        type: 'datetime',
        tickAmount: 4,
        axisBorder: { show: true, color: palette.border },
        axisTicks: { show: false },
        labels: {
          datetimeUTC: false,
          style: { colors: palette.textMuted, fontSize: '8px' },
          formatter: (value: string, timestamp?: number) => formatAxisLabel(value, timestamp, spanDays),
        },
      },
      yaxis: {
        min: chart.returnMin,
        max: chart.returnMax,
        tickAmount: 3,
        axisBorder: { show: false },
        axisTicks: { show: false },
        labels: {
          style: { colors: palette.textMuted, fontSize: '8px' },
          formatter: (value: number) => `${value.toFixed(0)}%`,
        },
      },
      tooltip: {
        // 悬停标题给完整日期，坐标轴刻度仍按月显示。
        x: { format: 'yyyy-MM-dd', formatter: (value: string | number) => formatTooltipDate(value) },
        y: { formatter: value => `${(value ?? 0) >= 0 ? '+' : ''}${(value ?? 0).toFixed(2)}%` },
      },
      annotations: {
        yaxis: [chart.costVisible ? {
          ...baseline,
          label: {
            text: costLabel,
            // 放在绘图区右端、去掉底框，避免压在坐标轴刻度上。
            position: 'right',
            textAnchor: 'end',
            offsetX: -4,
            borderWidth: 0,
            style: { background: 'transparent', color: palette.textMuted, fontSize: '8px' },
          },
        } : baseline],
      },
    }
  }, [chart, palette, costLabel, compact, spanDays])
  if (chart === undefined) return <p className={css.emptyBlock}>{t('fund.empty')}</p>
  // 中国习惯：正收益红色，负收益绿色。
  const tone = chart.rangeReturn >= 0 ? css.toneError : css.toneSuccess
  const rangeLabel = t('fund.range', { value: formatPercent(chart.rangeReturn) })
  return (
    <div className={css.fundFocus} ref={container}>
      <div className={css.fundFocusHead}>
        <h3>
          {fund.name}
          <span className={css.fundCode}>{fund.code}</span>
        </h3>
        <span className={tone}>{rangeLabel}</span>
      </div>
      <div className={css.fundRange} role="group" aria-label={t('fund.rangeLabel')}>
        <span className={css.fundRangeGlider} aria-hidden="true"
          style={{ transform: `translateX(${Math.max(0, FUND_RANGES.findIndex(item => item.key === range)) * 100}%)` }} />
        {FUND_RANGES.map(item => (
          <button key={item.key} type="button" aria-pressed={range === item.key}
            className={`${css.fundRangeChip} ${range === item.key ? css.fundRangeChipActive : ''}`}
            onClick={() => { setRange(item.key) }}>
            {t(FUND_RANGE_LABEL[item.key])}
          </button>
        ))}
      </div>
      {fund.holding && fund.shares > 0 && fund.cost > 0 && (
        <div className={css.fundSim}>
          <span className={css.fundSimLabel}>{t('fund.simLabel')}</span>
          <input className={css.fundSimRange} type="range"
            min={0} max={ADD_ON_MAX} step={ADD_ON_STEP} value={addOn}
            aria-label={t('fund.simLabel')}
            onChange={(event) => { setAddOn(Number(event.target.value)) }} />
          <span className={css.fundSimAmount}>{t('fund.money', { value: formatNumber(addOn) })}</span>
          <span className={css.fundSimCost}>
            {t('fund.cost')} {fund.cost.toFixed(4)}
            {simCost === undefined ? '' : ` → ${simCost.toFixed(4)}`}
          </span>
          <button type="button" className={css.fundSimReset} disabled={addOn === 0}
            onClick={() => { setAddOn(0) }}>
            {t('fund.simReset')}
          </button>
          <span className={css.fundSimHint}>{t('fund.simHint')}</span>
        </div>
      )}
      {/* key 随区间变化：重挂载触发一次淡入，配合 Apex 的入场动画。 */}
      <div className={css.fundCharts} key={range}>
        <div className={css.fundChartBlock}>
          <div className={css.fundChartHead}>
            <span className={css.fundChartTitle}>{t('fund.trendTitle')}</span>
            <div className={css.fundMaChips} role="group" aria-label={t('fund.maLabel')}>
              {MA_WINDOWS.map((window) => {
                const on = maOn.includes(window)
                return (
                  <button key={window} type="button" aria-pressed={on}
                    className={`${css.fundMaChip} ${on ? css.fundMaChipActive : ''}`}
                    onClick={() => {
                      setMaOn(current => current.includes(window)
                        ? current.filter(item => item !== window)
                        : [...current, window])
                    }}>
                    <span className={css.fundMaDot} style={{ background: MA_COLORS[window] }} aria-hidden="true" />
                    {`MA${window}`}
                  </button>
                )
              })}
            </div>
          </div>
          <div className={css.fundApex} role="img" aria-label={`${fund.name} ${t('fund.trendTitle')}`}>
            <Chart options={trendOptions}
              series={[
                { name: t('fund.nav'), data: [...chart.navSeries] },
                ...MA_WINDOWS.map(window => ({
                  name: `MA${window}`,
                  // 关闭时保留空序列，确保颜色槽位固定。
                  data: maOn.includes(window) ? [...(maData?.[window] ?? [])] : [],
                })),
              ]}
              type="line" height="100%" width="100%" />
          </div>
        </div>
        <div className={css.fundChartBlock}>
          <span className={css.fundChartTitle}>{t('fund.returnTitle')}</span>
          <div className={css.fundApex} role="img" aria-label={`${fund.name} ${t('fund.returnTitle')}`}>
            <Chart options={returnOptions}
              series={[
                { name: t('fund.positive'), data: [...chart.returnUp] },
                { name: t('fund.negative'), data: [...chart.returnDown] },
              ]}
              type="line" height="100%" width="100%" />
          </div>
        </div>
      </div>
      <div className={css.fundLegend}>
        <span className={css.toneError}>
          <span className={`${css.swatch} ${css.toneError}`} aria-hidden="true" />
          {t('fund.buy')}
        </span>
        <span className={css.toneSuccess}>
          <span className={`${css.swatch} ${css.toneSuccess}`} aria-hidden="true" />
          {t('fund.sell')}
        </span>
        {chart.costVisible && (
          <span className={css.toneMuted}>
            <span className={`${css.swatch} ${css.toneMuted}`} aria-hidden="true" />
            {costLabel}
          </span>
        )}
      </div>
    </div>
  )
}

/** 闸门卡：指数收盘 vs 长期均线，附一段近一年走势与开闸推演。 */
function GateCard({ gate, t }: { gate: GateRecord; t: TranslateNS<typeof NS> }): ReactNode {
  const container = useRef<HTMLDivElement>(null)
  const palette = useChartPalette(container)
  const compact = useCompactViewport()
  const first = gate.series[0]
  const last = gate.series[gate.series.length - 1]
  const spanDays = first === undefined || last === undefined
    ? 0
    : (toTimestamp(last.date) - toTimestamp(first.date)) / DAY_MS
  const options = useMemo<ApexOptions>(() => {
    const values = gate.series.flatMap(point => [point.close, point.ma])
    const low = values.length > 0 ? Math.min(...values) : 0
    const high = values.length > 0 ? Math.max(...values) : 1
    const span = high - low || high * 0.01 || 1
    return {
      chart: {
        type: 'line',
        height: 120,
        toolbar: { show: false },
        zoom: { enabled: false },
        animations: { enabled: false },
        parentHeightOffset: 0,
        fontFamily: 'inherit',
        redrawOnParentResize: true,
      },
      colors: [palette.business, palette.muted],
      stroke: { curve: 'straight', width: [1.2, 1], dashArray: [0, 4] },
      markers: { size: 0, hover: { size: 3 } },
      dataLabels: { enabled: false },
      legend: { show: false },
      grid: { show: false, padding: { left: 2, right: 2, top: 6, bottom: 0 } },
      xaxis: {
        type: 'datetime',
        tickAmount: 4,
        axisBorder: { show: true, color: palette.border },
        axisTicks: { show: false },
        labels: {
          datetimeUTC: false,
          style: { colors: palette.textMuted, fontSize: '8px' },
          formatter: (value: string, timestamp?: number) => formatAxisLabel(value, timestamp, spanDays),
        },
      },
      yaxis: {
        min: low - span * 0.08,
        max: high + span * 0.08,
        tickAmount: 3,
        axisBorder: { show: false },
        axisTicks: { show: false },
        labels: {
          style: { colors: palette.textMuted, fontSize: '8px' },
          formatter: (value: number) => value.toFixed(0),
        },
      },
      tooltip: {
        x: { format: 'yyyy-MM-dd', formatter: (value: string | number) => formatTooltipDate(value) },
        y: { formatter: value => (value ?? 0).toFixed(2) },
      },
    }
  }, [gate, palette, spanDays])
  const devTone = gate.devPct >= 0 ? css.toneError : css.toneSuccess
  const projection = gate.projection
    .map(item => t('quant.projItem', { days: item.days, value: signedNumber(item.needPct) }))
    .join(' · ')
  return (
    <div className={css.quantGate} ref={container} data-quant-gate={gate.kind}>
      <div className={css.quantGateHead}>
        <div>
          <h3>{gate.title}</h3>
          <p className={css.quantMeta}>
            {t('quant.gateMeta', { strat: gate.strat, index: gate.idxName, n: gate.maN })}
          </p>
        </div>
        <span className={`${css.quantBadge} ${gate.open ? css.quantBadgeOpen : css.quantBadgeClosed}`}>
          {t(gate.open ? 'quant.open' : 'quant.closed')}
        </span>
      </div>
      <div className={css.quantStats}>
        <div className={css.quantStat}>
          <span>{t('quant.close')}</span>
          <strong>{gate.close.toFixed(2)}</strong>
        </div>
        <div className={css.quantStat}>
          <span>{t('quant.maLine', { n: gate.maN })}</span>
          <strong>{gate.ma.toFixed(2)}</strong>
        </div>
        <div className={css.quantStat}>
          <span>{t('quant.dev')}</span>
          <strong className={devTone}>{signedPercent(gate.devPct)}</strong>
        </div>
      </div>
      <p className={css.quantHint}>
        {gate.open ? t('quant.openHint') : t('quant.needHint', { value: signedNumber(gate.needPct) })}
      </p>
      <div className={css.quantApex} role="img" aria-label={`${gate.title} ${t('quant.trendTitle')}`}>
        <Chart options={options}
          series={[
            { name: gate.idxName, data: gate.series.map(point => ({ x: toTimestamp(point.date), y: point.close })) },
            { name: t('quant.maLineShort', { n: gate.maN }), data: gate.series.map(point => ({ x: toTimestamp(point.date), y: point.ma })) },
          ]}
          type="line" height={compact ? '100%' : 120} width="100%" />
      </div>
      {(() => {
        const v = gate.valuation
        const tierKey = v.tier >= 2
          ? 'quant.valuation.tier.undervalued'
          : v.tier === 1
            ? 'quant.valuation.tier.bargain'
            : v.tier === 0
              ? 'quant.valuation.tier.normal'
              : v.tier === -1
                ? 'quant.valuation.tier.rich'
                : 'quant.valuation.tier.overvalued'
        const tierClass = v.tier >= 2
          ? css.tierUndervalued
          : v.tier === 1
            ? css.tierBargain
            : v.tier === 0
              ? css.tierNormal
              : v.tier === -1
                ? css.tierRich
                : css.tierOvervalued
        return (
          <div className={css.quantValuation}>
            <div className={css.quantValuationHead}>
              <h4 className={css.quantValuationTitle}>{t('quant.valuation.title')}</h4>
              <span className={`${css.quantValuationTier} ${tierClass}`}>{t(tierKey)}</span>
            </div>
            <div className={css.quantValItem}>
              <span>{t('quant.valuation.closePct')}</span>
              <strong>{v.closePercentile !== null ? `${v.closePercentile.toFixed(1)}%` : '—'}</strong>
              <div className={css.quantValBar}><span style={{ width: `${v.closePercentile ?? 0}%` }} /></div>
            </div>
            <div className={css.quantValItem}>
              <span>{t('quant.valuation.devPct')}</span>
              <strong>{v.devPercentile !== null ? `${v.devPercentile.toFixed(1)}%` : '—'}</strong>
              <div className={css.quantValBar}><span style={{ width: `${v.devPercentile ?? 0}%` }} /></div>
            </div>
            <div className={css.quantValWindow}>
              {t('quant.valuation.window', { days: v.windowDays, from: v.windowFrom, to: v.windowTo })}
            </div>
            {v.reasons.length > 0 && (
              <div className={css.quantValReasons}>
                {t('quant.valuation.reasonIntro', { reasons: v.reasons.join('，') })}
              </div>
            )}
          </div>
        )
      })()}
      <div className={css.quantFoot}>
        <span>{t('quant.slope', { n: gate.maN, value: signedNumber(gate.slope) })}</span>
        {!gate.open && <span>{t('quant.projection', { values: projection })}</span>}
      </div>
    </div>
  )
}

/** 两套模拟盘的归一化净值对比（各自以起点本金为 1.000）。 */
function SimCompare({ sims, t }: { sims: readonly SimRecord[]; t: TranslateNS<typeof NS> }): ReactNode {
  const container = useRef<HTMLDivElement>(null)
  const palette = useChartPalette(container)
  const compact = useCompactViewport()
  const colorAt = (index: number): string => (index % 2 === 0 ? palette.business : palette.warning)
  const options = useMemo<ApexOptions>(() => {
    const stamps = sims.flatMap(sim => sim.series.map(point => toTimestamp(point.date)))
    const navs = sims.flatMap(sim => sim.series.map(point => point.nav))
    const spanDays = stamps.length > 0
      ? (Math.max(...stamps) - Math.min(...stamps)) / DAY_MS
      : 0
    const low = navs.length > 0 ? Math.min(...navs) : 0.99
    const high = navs.length > 0 ? Math.max(...navs) : 1.01
    const span = high - low || high * 0.005 || 0.01
    return {
      chart: {
        type: 'line',
        height: 160,
        toolbar: { show: false },
        zoom: { enabled: false },
        animations: { enabled: false },
        parentHeightOffset: 0,
        fontFamily: 'inherit',
        redrawOnParentResize: true,
      },
      colors: sims.map((_, index) => (index % 2 === 0 ? palette.business : palette.warning)),
      stroke: { curve: 'straight', width: 1.4 },
      markers: { size: 0, hover: { size: 3 } },
      dataLabels: { enabled: false },
      legend: { show: false },
      grid: { show: false, padding: { left: 2, right: 2, top: 6, bottom: 0 } },
      xaxis: {
        type: 'datetime',
        tickAmount: 3,
        axisBorder: { show: true, color: palette.border },
        axisTicks: { show: false },
        labels: {
          datetimeUTC: false,
          style: { colors: palette.textMuted, fontSize: '8px' },
          formatter: (value: string, timestamp?: number) => formatAxisLabel(value, timestamp, spanDays),
        },
      },
      yaxis: {
        min: low - span * 0.15,
        max: high + span * 0.15,
        tickAmount: 3,
        axisBorder: { show: false },
        axisTicks: { show: false },
        labels: {
          style: { colors: palette.textMuted, fontSize: '8px' },
          formatter: (value: number) => value.toFixed(3),
        },
      },
      tooltip: {
        x: { format: 'yyyy-MM-dd', formatter: (value: string | number) => formatTooltipDate(value) },
        y: { formatter: value => (value ?? 0).toFixed(3) },
      },
    }
  }, [sims, palette])
  return (
    <div className={css.simChart}>
      <div className={css.simChartHead}>
        <p className={css.simChartTitle}>{t('sim.chartTitle')}</p>
        <div className={css.simLegend}>
          {sims.map((sim, index) => (
            <span key={sim.kind}>
              <span className={css.simDot} style={{ background: colorAt(index) }} aria-hidden="true" />
              {sim.title}
            </span>
          ))}
        </div>
      </div>
      <div className={css.simApex} role="img" aria-label={t('sim.chartTitle')}>
        <Chart options={options}
          series={sims.map(sim => ({
            name: sim.title,
            data: sim.series.map(point => ({ x: toTimestamp(point.date), y: point.nav })),
          }))}
          type="line" height={compact ? '100%' : 160} width="100%" />
      </div>
    </div>
  )
}

/** 单套模拟盘：账户读数 + 持仓 / 次日信号 / 最近成交。 */
function SimCard({ sim, t }: { sim: SimRecord; t: TranslateNS<typeof NS> }): ReactNode {
  const tone = sim.returnPct >= 0 ? css.toneError : css.toneSuccess
  return (
    <div className={css.simBlock} data-sim-kind={sim.kind}>
      <div className={css.simHead}>
        <div className={css.simHeadText}>
          <h3>{sim.title}</h3>
          <p className={css.quantMeta}>{t('sim.meta', { strat: sim.strat, date: sim.simStart })}</p>
        </div>
        <span className={`${css.quantBadge} ${tone}`}>{signedPercent(sim.returnPct)}</span>
      </div>
      <div className={css.simStats}>
        <div className={css.simStat}>
          <span>{t('sim.equity')}</span>
          <strong>{t('fund.money', { value: formatNumber(sim.equity) })}</strong>
        </div>
        <div className={css.simStat}>
          <span>{t('sim.drawdown')}</span>
          <strong>{sim.maxDrawdownPct.toFixed(2)}%</strong>
        </div>
        <div className={css.simStat}>
          <span>{t('sim.cash')}</span>
          <strong>{sim.cashPct.toFixed(1)}%</strong>
        </div>
      </div>

      <div className={css.simSection}>
        <h4>{t('sim.positions')}</h4>
        {sim.positions.length === 0
          ? <p className={css.simEmpty}>{t('sim.noPositions')}</p>
          : (
            <ul className={css.simList}>
              {sim.positions.map(position => (
                <li key={position.code} className={css.simRow}>
                  <span className={css.simNameCol}>
                    <span className={css.simName}>
                      {position.name} <span className={css.simCode}>{position.code}</span>
                    </span>
                    <span className={css.simMeta}>
                      {t('sim.positionRow', {
                        shares: formatNumber(position.shares),
                        cost: position.avgCost.toFixed(3),
                      })}
                    </span>
                  </span>
                  <span className={css.simVal}>
                    {t('sim.weight', { value: position.weightPct.toFixed(1) })}
                  </span>
                </li>
              ))}
            </ul>
          )}
      </div>

      <div className={css.simSection}>
        <h4>{t('sim.signals')}</h4>
        {sim.signals.length === 0
          ? <p className={css.simEmpty}>{t('sim.noSignals')}</p>
          : (
            <ul className={css.simList}>
              {sim.signals.map(signal => (
                <li key={`${signal.side}-${signal.code}`} className={css.simRow}>
                  <span className={`${css.simChip} ${signal.side === 'buy' ? css.simChipBuy : css.simChipSell}`}>
                    {t(signal.side === 'buy' ? 'fund.buyShort' : 'fund.sellShort')}
                  </span>
                  <span className={css.simNameCol}>
                    <span className={css.simName}>
                      {signal.name} <span className={css.simCode}>{signal.code}</span>
                    </span>
                    {signal.note !== '' && <span className={css.simMeta}>{signal.note}</span>}
                  </span>
                  <span className={css.simVal}>
                    {signal.side === 'buy'
                      ? t('fund.money', { value: formatNumber(signal.value) })
                      : t('sim.clearAll')}
                  </span>
                </li>
              ))}
            </ul>
          )}
      </div>

      <div className={css.simSection}>
        <h4>{t('sim.trades')}</h4>
        {sim.trades.length === 0
          ? <p className={css.simEmpty}>{t('sim.emptyTrades')}</p>
          : (
            <ul className={css.simList}>
              {sim.trades.map(trade => (
                <li key={`${trade.date}-${trade.code}-${trade.side}`} className={css.simRow}>
                  <span className={`${css.simChip} ${trade.side === 'buy' ? css.simChipBuy : css.simChipSell}`}>
                    {t(trade.side === 'buy' ? 'fund.buyShort' : 'fund.sellShort')}
                  </span>
                  <span className={css.simNameCol}>
                    <span className={css.simName}>{trade.name}</span>
                    <span className={css.simMeta}>
                      {trade.date} · {t('sim.tradeRow', {
                        shares: formatNumber(trade.shares),
                        price: trade.price.toFixed(3),
                      })}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
      </div>
    </div>
  )
}

/** 消息面卡片：24h 分层、持仓命中头条、主题热度与采集健康。 */
function NewsCard({ news, t, source }: {
  news: NewsRecord
  t: TranslateNS<typeof NS>
  source: string
}): ReactNode {
  const hits = news.holdings.filter(row => row.count > 0)
  const healthy = news.health.filter(row => row.ok).length
  return (
    <>
      <div className={css.infoStats}>
        <div className={css.infoStat}>
          <span>{t('news.tierTitle')}</span>
          <strong>{t('news.tierValue', { s: news.sTier, a: news.aTier })}</strong>
        </div>
        <div className={css.infoStat}>
          <span>{t('news.holdingsHit')}</span>
          <strong>{t('news.unit', { count: news.holdingsHit })}</strong>
        </div>
        <div className={css.infoStat}>
          <span>{t('news.macro')}</span>
          <strong>{t('news.unit', { count: news.macro })}</strong>
        </div>
        <div className={css.infoStat}>
          <span>{t('news.policy')}</span>
          <strong>{t('news.unit', { count: news.policy })}</strong>
        </div>
      </div>

      <div className={css.newsSection}>
        <h4>{t('news.holdingsTitle')}</h4>
        {hits.length === 0
          ? <p className={css.simEmpty}>{t('news.noHoldings')}</p>
          : hits.map(row => (
            <div key={row.code} className={css.newsHolding}>
              <div className={css.newsHoldingHead}>
                <span className={css.newsName}>
                  {row.name} <span className={css.newsCode}>{row.code}</span>
                </span>
                <span className={css.count}>{t('news.unit', { count: row.count })}</span>
              </div>
              {row.items.slice(0, 2).map(item => (
                <p key={`${item.time}-${item.title}`} className={css.newsHeadline} title={item.title}>
                  <span className={css.newsMeta}>
                    {item.time} · {item.source}
                    {item.tier !== '' ? ` · ${item.score}·${item.tier}` : ''}
                  </span>
                  {item.title}
                </p>
              ))}
            </div>
          ))}
      </div>

      {news.themes.length > 0 && (
        <div className={css.newsThemes}>
          {news.themes.slice(0, 6).map(theme => (
            <span key={theme.name} className={css.newsTheme}>
              {theme.name} <strong>{theme.count}</strong>
            </span>
          ))}
        </div>
      )}

      <p className={css.footnote}>
        {t('news.health', { ok: healthy, total: news.health.length })} · {t('news.note')}
      </p>
      {source !== '' && <p className={css.footnote}>{t('news.source', { source })}</p>}
    </>
  )
}

/** 股票池卡片：持仓、监测来源分布与近期新增。 */
function PoolCard({ pool, t, source }: {
  pool: PoolRecord
  t: TranslateNS<typeof NS>
  source: string
}): ReactNode {
  const kinds = POOL_KINDS
    .map(kind => pool.byKind.find(row => row.kind === kind))
    .filter((row): row is PoolKindCount => row !== undefined && row.count > 0)
  return (
    <>
      <div className={css.poolSection}>
        <h4>{t('pool.holdingsChips')}</h4>
        <div className={css.poolChips}>
          {pool.holdings.map(item => (
            <span key={item.code} className={css.poolChip}>
              <span className={css.poolIcon} aria-hidden="true">{item.icon}</span>
              {item.name}
              <span className={css.newsCode}>{item.code}</span>
            </span>
          ))}
        </div>
      </div>

      <div className={css.poolSection}>
        <h4>{t('pool.watchTitle')}</h4>
        <div className={css.poolChips}>
          {kinds.map(row => (
            <span key={row.kind} className={`${css.poolChip} ${css.poolChipMuted}`}>
              {t(POOL_KIND_KEY[row.kind])}
              <strong>{row.count}</strong>
            </span>
          ))}
        </div>
      </div>

      <div className={css.newsSection}>
        <h4>{t('pool.recentTitle')}</h4>
        {pool.recent.length === 0
          ? <p className={css.simEmpty}>{t('pool.noRecent')}</p>
          : (
            <ul className={css.poolList}>
              {pool.recent.slice(0, 5).map(item => (
                <li key={`${item.date}-${item.code}`} className={css.poolRow}>
                  <span className={css.poolName} title={item.name}>
                    {item.name} <span className={css.newsCode}>{item.code}</span>
                  </span>
                  <span className={css.poolMeta}>
                    {item.date} · {t(POOL_KIND_KEY[item.kind])}
                  </span>
                </li>
              ))}
            </ul>
          )}
      </div>

      <p className={css.footnote}>{t('pool.note')}</p>
      {source !== '' && <p className={css.footnote}>{t('pool.source', { source })}</p>}
    </>
  )
}

/** 百分比带符号：闸门读数已是百分数，不做比例换算。 */
function signedPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function signedNumber(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`
}

/** 主机指标小卡：数值 + 使用率进度条。 */
function HostStat({ label, value, detail, percent, tone }: {
  label: string
  value: string
  detail?: string | undefined
  percent: number
  tone: string
}): ReactNode {
  const width = Math.max(0, Math.min(100, percent))
  return (
    <div className={css.hostStat}>
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
      <div className={css.hostBar} role="presentation">
        <div className={`${css.hostBarFill} ${tone}`} style={{ width: `${width}%` }} />
      </div>
      {detail !== undefined && <span className={css.hostDetail}>{detail}</span>}
    </div>
  )
}

/** Workspace, Session, scheduled-task, and background-job status page. */
export function Dashboard({ sessionId, readFile, t }: DashboardProps): ReactNode {
  const [reload, setReload] = useState(0)
  const [fundState, setFundState] = useState<FundState>({ status: 'loading' })
  const [hostState, setHostState] = useState<HostState>({ status: 'loading' })
  const [quantState, setQuantState] = useState<QuantState>({ status: 'loading' })
  const [insightState, setInsightState] = useState<InsightState>({ status: 'loading' })
  const [selectedFund, setSelectedFund] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setFundState({ status: 'loading' })
    void loadFundState(sessionId, readFile, controller.signal).then((next) => {
      if (active) setFundState(next)
    }).catch(() => {
      if (active && !controller.signal.aborted) setFundState({ status: 'error' })
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [sessionId, readFile, reload])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setHostState({ status: 'loading' })
    void loadHostState(sessionId, readFile, controller.signal).then((next) => {
      if (active) setHostState(next)
    }).catch(() => {
      if (active && !controller.signal.aborted) setHostState({ status: 'error' })
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [sessionId, readFile, reload])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setQuantState({ status: 'loading' })
    void loadQuantState(sessionId, readFile, controller.signal).then((next) => {
      if (active) setQuantState(next)
    }).catch(() => {
      if (active && !controller.signal.aborted) setQuantState({ status: 'error' })
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [sessionId, readFile, reload])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setInsightState({ status: 'loading' })
    void loadInsightState(sessionId, readFile, controller.signal).then((next) => {
      if (active) setInsightState(next)
    }).catch(() => {
      if (active && !controller.signal.aborted) setInsightState({ status: 'error' })
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [sessionId, readFile, reload])

  const host = hostState.status === 'ready' ? hostState.metrics : undefined
  const hostTone = (percent: number): string => (
    percent >= 85 ? (css.toneError ?? '') : percent >= 70 ? (css.toneWarning ?? '') : (css.toneBusiness ?? '')
  )
  const temperature = host?.temperature ?? undefined
  const fundSnapshot = fundState.status === 'ready' ? fundState.snapshot : undefined
  const quantSnapshot = quantState.status === 'ready' ? quantState.snapshot : undefined
  const insightSnapshot = insightState.status === 'ready' ? insightState.snapshot : undefined
  const sims = quantSnapshot?.sims ?? []
  const simAsOf = sims.reduce((latest, sim) => (sim.asOf > latest ? sim.asOf : latest), '')
  const simHasSeries = sims.some(sim => sim.series.length > 1)
  const funds = fundSnapshot?.funds.filter(fund => fund.holding && fund.shares > 0) ?? []
  const fundSummary = useMemo(() => {
    if (fundSnapshot === undefined) return undefined
    const held = fundSnapshot.funds.filter(fund => fund.holding && fund.shares > 0)
    const value = held.reduce((sum, fund) => sum + fund.shares * fund.nav, 0)
    const cost = held.reduce((sum, fund) => sum + fund.shares * fund.cost, 0)
    return { held, value, cost, pnl: value - cost, rate: cost > 0 ? (value - cost) / cost : undefined }
  }, [fundSnapshot])
  const activeFund = funds.find(fund => fund.code === selectedFund)
    ?? funds.find(fund => fund.holding)
    ?? funds[0]
  // 汇总数字首次出现时滚动到目标值。
  const heldValue = useCountUp(fundSummary?.value)
  const heldCost = useCountUp(fundSummary?.cost)
  const heldPnl = useCountUp(fundSummary?.pnl)
  const heldRate = useCountUp(fundSummary?.rate)

  return (
    <div className={css.page} data-status-dashboard>
      <header className={css.header}>
        <div>
          <h1>{t('header.title')}</h1>
          <p>{t('header.subtitle')}</p>
        </div>
        <button type="button" className={css.refresh} aria-label={t('header.refresh')} title={t('header.refresh')}
          onClick={() => { setReload(value => value + 1) }}>
          <IconRefreshOutlineRegular />
        </button>
      </header>

      <section className={`${css.card} ${css.hostCard}`} data-host-metrics>
        <div className={css.sectionHeader}>
          <div>
            <h2>{t('host.title')}</h2>
            <p>{t('host.subtitle', { time: host?.asOf ?? '—' })}</p>
          </div>
          {host !== undefined && <span className={css.count}>{host.host}</span>}
        </div>
        {hostState.status === 'loading' && <p className={css.emptyBlock}>{t('host.loading')}</p>}
        {(hostState.status === 'missing' || hostState.status === 'error' || hostState.status === 'invalid') && (
          <div className={css.emptyBlock}>
            <p>{t(hostState.status === 'missing' ? 'host.missing'
              : hostState.status === 'invalid' ? 'host.invalid' : 'host.error')}</p>
            <button type="button" className={css.retry} onClick={() => { setReload(value => value + 1) }}>
              {t('host.retry')}
            </button>
          </div>
        )}
        {host !== undefined && (
          <div className={css.hostGrid}>
            <HostStat label={t('host.cpu')} value={`${host.cpu.toFixed(0)}%`}
              percent={host.cpu} tone={hostTone(host.cpu)} />
            <HostStat label={t('host.memory')} value={`${host.memory.percent.toFixed(0)}%`}
              detail={t('host.memoryUsage', {
                used: (host.memory.usedBytes / 1024 ** 3).toFixed(1),
                total: (host.memory.totalBytes / 1024 ** 3).toFixed(1),
              })}
              percent={host.memory.percent} tone={hostTone(host.memory.percent)} />
            <HostStat label={t('host.temperature')}
              value={temperature === undefined ? '—' : `${temperature.toFixed(1)}°C`}
              percent={temperature === undefined ? 0 : ((temperature - 30) / 60) * 100}
              tone={temperature === undefined ? (css.toneMuted ?? '')
                : temperature >= 80 ? (css.toneError ?? '')
                  : temperature >= 70 ? (css.toneWarning ?? '') : (css.toneBusiness ?? '')} />
          </div>
        )}
      </section>

      <div className={css.split}>
        <section className={`${css.card} ${css.fundCard}`} data-fund-panel>
          <div className={css.sectionHeader}>
            <div>
              <h2>{t('fund.title')}</h2>
              <p>{t('fund.subtitle', {
                date: fundSnapshot !== undefined && fundSnapshot.asOf !== '' ? fundSnapshot.asOf : '—',
              })}</p>
            </div>
            {fundSummary !== undefined && (
              <span className={css.count}>{t('fund.held', { count: fundSummary.held.length })}</span>
            )}
          </div>
          {fundState.status === 'loading' && <p className={css.emptyBlock}>{t('fund.loading')}</p>}
          {(fundState.status === 'missing' || fundState.status === 'error' || fundState.status === 'invalid') && (
            <div className={css.emptyBlock}>
              <p>{t(fundState.status === 'missing' ? 'fund.missing'
                : fundState.status === 'invalid' ? 'fund.invalid' : 'fund.error')}</p>
              <button type="button" className={css.retry} onClick={() => { setReload(value => value + 1) }}>
                {t('fund.retry')}
              </button>
            </div>
          )}
          {fundState.status === 'ready' && activeFund === undefined && (
            <p className={css.emptyBlock}>{t('fund.empty')}</p>
          )}
          {fundSummary !== undefined && activeFund !== undefined && (
            <>
              <div className={css.fundSummary}>
                <div className={css.fundStat}>
                  <span>{t('fund.totalValue')}</span>
                  <strong>{heldValue === undefined ? '—' : t('fund.money', { value: formatNumber(heldValue) })}</strong>
                </div>
                <div className={css.fundStat}>
                  <span>{t('fund.totalCost')}</span>
                  <strong>{heldCost === undefined ? '—' : t('fund.money', { value: formatNumber(heldCost) })}</strong>
                </div>
                <div className={css.fundStat}>
                  <span>{t('fund.pnl')}</span>
                  <strong className={fundSummary.pnl >= 0 ? css.toneError : css.toneSuccess}>
                    {heldPnl === undefined ? '—' : signedMoney(heldPnl, t)}
                  </strong>
                </div>
                <div className={css.fundStat}>
                  <span>{t('fund.return')}</span>
                  <strong className={fundSummary.pnl >= 0 ? css.toneError : css.toneSuccess}>
                    {heldRate === undefined ? '—' : formatPercent(heldRate)}
                  </strong>
                </div>
              </div>
              <div className={css.fundChips}>
                {funds.map(fund => (
                  <button key={fund.code} type="button" aria-pressed={fund.code === activeFund.code}
                    className={`${css.fundChip} ${fund.code === activeFund.code ? css.fundChipActive : ''}`}
                    onClick={() => { setSelectedFund(fund.code) }}>
                    <span className={`${css.fundChipDot} ${fund.holding ? css.toneBusiness : css.toneMuted}`}
                      aria-hidden="true" />
                    {fund.name}
                  </button>
                ))}
              </div>
              <FundChart fund={activeFund} t={t} />
              <ul className={css.fundList}>
                {fundSummary.held.map(fund => (
                  <li key={fund.code} className={css.fundRow}>
                    <div className={css.fundRowMain}>
                      <div className={css.fundNameRow}>
                        <span className={css.dailyName} title={fund.name}>{fund.name}</span>
                        <span className={css.fundCode}>{fund.code}</span>
                      </div>
                      <span className={css.fundMeta}>
                        {t('fund.shares', { value: formatNumber(fund.shares) })} · {t('fund.cost')}{' '}
                        {fund.cost.toFixed(4)} → {fund.nav.toFixed(4)}
                      </span>
                    </div>
                    <div className={css.fundRowValue}>
                      <strong>{t('fund.money', { value: formatNumber(fund.shares * fund.nav) })}</strong>
                      <span className={fund.nav >= fund.cost ? css.toneError : css.toneSuccess}>
                        {formatPercent(fund.cost > 0 ? fund.nav / fund.cost - 1 : 0)}
                      </span>
                    </div>
                  </li>
                ))}

              </ul>
              <p className={css.footnote}>{t('fund.note')}</p>
              {fundSnapshot !== undefined && fundSnapshot.source !== '' && (
                <p className={css.footnote}>{t('fund.source', { source: fundSnapshot.source })}</p>
              )}
            </>
          )}
        </section>
      </div>

      <section className={`${css.card} ${css.insightCard}`} data-news-panel>
        <div className={css.sectionHeader}>
          <div>
            <h2>{t('news.title')}</h2>
            <p>{t('news.subtitle', {
              hours: insightSnapshot?.news?.hours ?? 24,
              date: insightSnapshot?.news !== undefined && insightSnapshot.news.asOf !== ''
                ? insightSnapshot.news.asOf : '—',
            })}</p>
          </div>
          {insightSnapshot?.news !== undefined && (
            <span className={css.count}>{t('news.count', { count: insightSnapshot.news.total })}</span>
          )}
        </div>
        {insightState.status === 'loading' && <p className={css.emptyBlock}>{t('news.loading')}</p>}
        {(insightState.status === 'missing' || insightState.status === 'error'
          || insightState.status === 'invalid') && (
          <div className={css.emptyBlock}>
            <p>{t(insightState.status === 'missing' ? 'news.missing'
              : insightState.status === 'invalid' ? 'news.invalid' : 'news.error')}</p>
            <button type="button" className={css.retry} onClick={() => { setReload(value => value + 1) }}>
              {t('news.retry')}
            </button>
          </div>
        )}
        {insightSnapshot !== undefined && insightSnapshot.news === undefined && (
          <p className={css.emptyBlock}>{t('news.empty')}</p>
        )}
        {insightSnapshot?.news !== undefined && (
          <NewsCard news={insightSnapshot.news} t={t} source={insightSnapshot.newsSource} />
        )}
      </section>

      <section className={`${css.card} ${css.insightCard}`} data-pool-panel>
        <div className={css.sectionHeader}>
          <div>
            <h2>{t('pool.title')}</h2>
            <p>{t('pool.subtitle', {
              date: insightSnapshot?.pool !== undefined && insightSnapshot.pool.asOf !== ''
                ? insightSnapshot.pool.asOf : '—',
            })}</p>
          </div>
          {insightSnapshot?.pool !== undefined && (
            <span className={css.count}>{t('pool.count', {
              holdings: insightSnapshot.pool.holdings.length,
              watch: insightSnapshot.pool.watchCount,
            })}</span>
          )}
        </div>
        {insightState.status === 'loading' && <p className={css.emptyBlock}>{t('pool.loading')}</p>}
        {(insightState.status === 'missing' || insightState.status === 'error'
          || insightState.status === 'invalid') && (
          <div className={css.emptyBlock}>
            <p>{t(insightState.status === 'missing' ? 'pool.missing'
              : insightState.status === 'invalid' ? 'pool.invalid' : 'pool.error')}</p>
            <button type="button" className={css.retry} onClick={() => { setReload(value => value + 1) }}>
              {t('pool.retry')}
            </button>
          </div>
        )}
        {insightSnapshot !== undefined && insightSnapshot.pool === undefined && (
          <p className={css.emptyBlock}>{t('pool.empty')}</p>
        )}
        {insightSnapshot?.pool !== undefined && (
          <PoolCard pool={insightSnapshot.pool} t={t} source={insightSnapshot.poolSource} />
        )}
      </section>

      <section className={`${css.card} ${css.quantCard}`} data-quant-panel>
        <div className={css.sectionHeader}>
          <div>
            <h2>{t('quant.title')}</h2>
            <p>{t('quant.subtitle', {
              date: quantSnapshot !== undefined && quantSnapshot.asOf !== '' ? quantSnapshot.asOf : '—',
            })}</p>
          </div>
          {quantSnapshot !== undefined && (
            <span className={css.count}>
              {t('quant.openCount', { count: quantSnapshot.gates.filter(gate => gate.open).length })}
            </span>
          )}
        </div>
        {quantState.status === 'loading' && <p className={css.emptyBlock}>{t('quant.loading')}</p>}
        {(quantState.status === 'missing' || quantState.status === 'error' || quantState.status === 'invalid') && (
          <div className={css.emptyBlock}>
            <p>{t(quantState.status === 'missing' ? 'quant.missing'
              : quantState.status === 'invalid' ? 'quant.invalid' : 'quant.error')}</p>
            <button type="button" className={css.retry} onClick={() => { setReload(value => value + 1) }}>
              {t('quant.retry')}
            </button>
          </div>
        )}
        {quantSnapshot !== undefined && (
          <>
            <div className={css.quantGrid}>
              {quantSnapshot.gates.map(gate => <GateCard key={gate.kind} gate={gate} t={t} />)}
            </div>
            <p className={css.footnote}>{t('quant.note')}</p>
            {quantSnapshot.source !== '' && (
              <p className={css.footnote}>{t('quant.source', { source: quantSnapshot.source })}</p>
            )}
          </>
        )}
      </section>

      <section className={`${css.card} ${css.simCard}`} data-sim-panel>
        <div className={css.sectionHeader}>
          <div>
            <h2>{t('sim.title')}</h2>
            <p>{t('sim.subtitle', { date: simAsOf !== '' ? simAsOf : (quantSnapshot?.asOf ?? '') || '—' })}</p>
          </div>
          {sims.length > 0 && <span className={css.count}>{t('sim.count', { count: sims.length })}</span>}
        </div>
        {quantState.status === 'loading' && <p className={css.emptyBlock}>{t('sim.loading')}</p>}
        {(quantState.status === 'missing' || quantState.status === 'error' || quantState.status === 'invalid') && (
          <div className={css.emptyBlock}>
            <p>{t(quantState.status === 'missing' ? 'sim.missing'
              : quantState.status === 'invalid' ? 'sim.invalid' : 'sim.error')}</p>
            <button type="button" className={css.retry} onClick={() => { setReload(value => value + 1) }}>
              {t('sim.retry')}
            </button>
          </div>
        )}
        {quantSnapshot !== undefined && sims.length === 0 && (
          <p className={css.emptyBlock}>{t('sim.empty')}</p>
        )}
        {quantSnapshot !== undefined && sims.length > 0 && (
          <>
            {simHasSeries && <SimCompare sims={sims} t={t} />}
            <div className={css.simGrid}>
              {sims.map(sim => <SimCard key={sim.kind} sim={sim} t={t} />)}
            </div>
            <p className={css.footnote}>{t('sim.note')}</p>
            {quantSnapshot.simSource !== '' && (
              <p className={css.footnote}>{t('sim.source', { source: quantSnapshot.simSource })}</p>
            )}
          </>
        )}
      </section>
    </div>
  )
}
