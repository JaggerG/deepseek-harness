/**
 * Right-sidebar status page. Live Session and job facts come from injected
 * selector hooks; file counts are a bounded snapshot refreshed on demand.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import Chart from 'react-apexcharts'
import type { ApexOptions } from 'apexcharts'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { JobsSnapshot, JobView } from '@deepseek-ai/dsh-api-job-controller/client'
import { selectSessionDirectory } from '@deepseek-ai/dsh-api-session-controller/client/directories'
import { IconRefreshOutlineRegular, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  InjectFace, PropsLocale, PropsRuntime, TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { NS } from './locales.ts'
import css from './Dashboard.module.css'

/** Registration-side services and observable sources for the dashboard. */
export interface DashboardInjected {
  hooks: {
    /** Client jobs snapshot, bound by the renderer as useJobs. */
    jobs: {
      getSnapshot(): JobsSnapshot
      subscribe(listener: () => void): () => void
    }
  }
  /** Keep the current Session's job roster current while this page is mounted. */
  watchRows(sessionId: SessionId): () => void
  /** Bounded workspace directory listing; paths are absolute or workspace-relative. */
  listDirectory: ClientRemote['workspaceFiles']['list']
  /** Complete-file bytes used by the daily-audit JSON snapshot. */
  readFile: ClientRemote['workspaceFiles']['readBytes']
}

/** Full composed props of the status page. */
export type DashboardProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<typeof NS>
  & InjectFace<DashboardInjected>

const NO_JOBS: readonly JobView[] = []
const DAILY_AUDIT_PATH = 'scripts/scheduled-reports/logs/daily_audit/state.json'
const FUND_PANEL_PATH = 'scripts/fund_panel.json'
const CHART_WIDTH = 320
const CHART_HEIGHT = 150
const MAX_DEPTH = 4
const MAX_DIRECTORIES = 60
const MAX_FILES = 2_000
const SKIPPED_DIRECTORIES = new Set([
  '.git', '.next', '.turbo', '.cache', 'node_modules', 'dist', 'lib', 'build', 'coverage',
])

const FILE_CATEGORIES = ['notes', 'documents', 'images', 'data', 'code', 'other'] as const
type FileCategory = typeof FILE_CATEGORIES[number]
type Tone = 'toneBusiness' | 'toneSuccess' | 'toneWarning' | 'toneError' | 'toneMuted'

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
    return () => observer.disconnect()
  }, [ref])
  return palette
}

function toneColor(tone: Tone, palette: ChartPalette): string {
  switch (tone) {
    case 'toneBusiness': return palette.business
    case 'toneSuccess': return palette.success
    case 'toneWarning': return palette.warning
    case 'toneError': return palette.error
    default: return palette.muted
  }
}

interface ChartSegment {
  readonly key: string
  readonly label: string
  readonly value: number
  readonly tone: Tone
}

interface FileStats {
  readonly files: number
  readonly directories: number
  readonly categories: Readonly<Record<FileCategory, number>>
  readonly truncated: boolean
}

type FileState =
  | { readonly status: 'loading' | 'error' }
  | { readonly status: 'ready'; readonly stats: FileStats }

interface DailyTaskDefinition {
  readonly name: string
  readonly group: string
  readonly schedule: string
}

interface DailyTaskResult {
  readonly status: string
  readonly detail: string
}

interface DailyTaskView extends DailyTaskDefinition {
  readonly result: DailyTaskResult | undefined
}

interface DailyAuditSnapshot {
  readonly tasks: readonly DailyTaskDefinition[]
  readonly results: Readonly<Record<string, Readonly<Record<string, DailyTaskResult>>>>
}

type DailyState =
  | { readonly status: 'loading' | 'error' | 'missing' | 'invalid' }
  | {
    readonly status: 'ready'
    readonly tasks: readonly DailyTaskView[]
    readonly date: string | undefined
    readonly historical: boolean
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

interface FundMarker {
  readonly x: number
  readonly y: number
  readonly index: number
  readonly value: number
  readonly action: 'buy' | 'sell'
  readonly date: string
  readonly amount: number
}

interface FundChartGeometry {
  readonly path: string
  readonly costY: number | undefined
  readonly zeroY: number
  readonly markers: readonly FundMarker[]
  readonly labels: readonly FundMarker[]
  readonly startDate: string
  readonly endDate: string
  readonly rangeReturn: number
  readonly minValue: number
  readonly maxValue: number
  readonly costValue: number | undefined
  readonly points: readonly number[]
  readonly candles: readonly (readonly [number, number, number, number])[]
}

function emptyCategories(): Record<FileCategory, number> {
  return { notes: 0, documents: 0, images: 0, data: 0, code: 0, other: 0 }
}

function categoryOf(name: string): FileCategory {
  const dot = name.lastIndexOf('.')
  const extension = dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
  if (['md', 'mdx', 'markdown', 'txt'].includes(extension)) return 'notes'
  if (['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'csv'].includes(extension)) return 'documents'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(extension)) return 'images'
  if (['json', 'jsonl', 'yaml', 'yml', 'toml', 'xml'].includes(extension)) return 'data'
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'css', 'html', 'java', 'go', 'rs'].includes(extension)) return 'code'
  return 'other'
}

/** Walk a bounded workspace snapshot without following dependency or build trees. */
async function scanWorkspace(
  sessionId: SessionId,
  cwd: string,
  listDirectory: ClientRemote['workspaceFiles']['list'],
  signal: AbortSignal,
): Promise<FileStats> {
  const categories = emptyCategories()
  const queue: { path: string; depth: number }[] = [{ path: cwd, depth: 0 }]
  let files = 0
  let directories = 0
  let truncated = false
  while (queue.length > 0 && directories < MAX_DIRECTORIES && files < MAX_FILES) {
    const current = queue.shift()
    if (current === undefined) break
    const result = await listDirectory(sessionId, current.path, signal)
    if (!result.ok) throw new Error(result.error.message)
    directories += 1
    truncated ||= result.value.truncated
    for (const entry of result.value.entries) {
      const path = result.value.path === '' ? entry.name : `${result.value.path}/${entry.name}`
      if (entry.type === 'directory') {
        if (current.depth < MAX_DEPTH && !SKIPPED_DIRECTORIES.has(entry.name)) {
          queue.push({ path, depth: current.depth + 1 })
        }
        continue
      }
      if (entry.type !== 'file') continue
      categories[categoryOf(entry.name)] += 1
      files += 1
      if (files >= MAX_FILES) {
        truncated = true
        break
      }
    }
  }
  truncated ||= queue.length > 0
  return { files, directories, categories, truncated }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate the audit file at the workspace boundary before using its rows. */
function parseDailyAudit(text: string): DailyAuditSnapshot {
  const root: unknown = JSON.parse(text)
  if (!isRecord(root) || !Array.isArray(root.tasks) || !isRecord(root.results)) {
    throw new Error('Invalid daily-audit root')
  }
  const tasks = root.tasks.map(raw => {
    if (!isRecord(raw) || typeof raw.name !== 'string'
      || typeof raw.group !== 'string' || typeof raw.schedule !== 'string') {
      throw new Error('Invalid daily-task definition')
    }
    return { name: raw.name, group: raw.group, schedule: raw.schedule }
  })
  const results: Record<string, Record<string, DailyTaskResult>> = {}
  for (const [date, rawDay] of Object.entries(root.results)) {
    if (!isRecord(rawDay)) throw new Error('Invalid daily-audit date')
    const day: Record<string, DailyTaskResult> = {}
    for (const [name, rawResult] of Object.entries(rawDay)) {
      if (!isRecord(rawResult) || typeof rawResult.status !== 'string'
        || (rawResult.detail !== undefined && typeof rawResult.detail !== 'string')) {
        throw new Error('Invalid daily-task result')
      }
      day[name] = { status: rawResult.status, detail: rawResult.detail ?? '' }
    }
    results[date] = day
  }
  return { tasks, results }
}

function presentDailyAudit(snapshot: DailyAuditSnapshot): DailyState {
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const dates = Object.keys(snapshot.results).sort()
  const date = dates.includes(today) ? today : dates[dates.length - 1]
  const dayResults = date === undefined ? undefined : snapshot.results[date]
  return {
    status: 'ready',
    date,
    historical: date !== undefined && date !== today,
    tasks: snapshot.tasks.map(task => ({ ...task, result: dayResults?.[task.name] })),
  }
}

async function loadDailyState(
  sessionId: SessionId,
  readFile: ClientRemote['workspaceFiles']['readBytes'],
  signal: AbortSignal,
): Promise<DailyState> {
  const result = await readFile(sessionId, DAILY_AUDIT_PATH, {}, signal)
  if (!result.ok) {
    if (result.error.code === 'workspace-file/not-found') return { status: 'missing' }
    throw new Error(result.error.message)
  }
  try {
    return presentDailyAudit(parseDailyAudit(new TextDecoder().decode(result.value.data)))
  } catch {
    return { status: 'invalid' }
  }
}

/** Validate the exported fund panel at the workspace boundary. */
function parseFundSnapshot(text: string): FundSnapshot {
  const root: unknown = JSON.parse(text)
  if (!isRecord(root) || !Array.isArray(root.funds)) {
    throw new Error('Invalid fund-panel root')
  }
  const funds = root.funds.map(raw => {
    if (!isRecord(raw) || typeof raw.code !== 'string' || typeof raw.name !== 'string'
      || typeof raw.holding !== 'boolean' || typeof raw.shares !== 'number'
      || typeof raw.cost !== 'number' || typeof raw.nav !== 'number'
      || typeof raw.nav_date !== 'string'
      || !Array.isArray(raw.trades) || !Array.isArray(raw.history)) {
      throw new Error('Invalid fund row')
    }
    const trades = raw.trades.map(rawTrade => {
      if (!isRecord(rawTrade) || typeof rawTrade.date !== 'string'
        || (rawTrade.action !== 'buy' && rawTrade.action !== 'sell')
        || typeof rawTrade.amount !== 'number') {
        throw new Error('Invalid fund trade')
      }
      const action: 'buy' | 'sell' = rawTrade.action === 'buy' ? 'buy' : 'sell'
      return { date: rawTrade.date, action, amount: rawTrade.amount }
    })
    const history = raw.history.map(rawPoint => {
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

/** Project a fund's NAV history into a normalized return curve plus trade markers. */
function buildFundChart(fund: FundRecord): FundChartGeometry | undefined {
  const first = fund.history[0]
  const last = fund.history[fund.history.length - 1]
  if (first === undefined || last === undefined || fund.history.length < 2) return undefined
  const returns = fund.history.map(point => point.nav / first.nav - 1)
  const costReturn = fund.holding && fund.cost > 0 ? fund.cost / first.nav - 1 : undefined
  const values = [...returns, 0]
  if (costReturn !== undefined) values.push(costReturn)
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const span = maximum - minimum || 0.01
  const top = maximum + span * 0.08
  const bottom = minimum - span * 0.08
  const plotLeft = 4
  const plotRight = CHART_WIDTH - 4
  const plotTop = 12
  const plotBottom = CHART_HEIGHT - 18
  const x = (index: number): number =>
    plotLeft + index / (fund.history.length - 1) * (plotRight - plotLeft)
  const y = (value: number): number =>
    plotTop + (top - value) / (top - bottom) * (plotBottom - plotTop)
  const path = fund.history.map((_, index) => {
    const value = returns[index] ?? 0
    return `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)} ${y(value).toFixed(1)}`
  }).join(' ')
  const markers: FundMarker[] = []
  const seen = new Set<string>()
  for (const trade of fund.trades) {
    const index = fund.history.findIndex(point => point.date >= trade.date)
    if (index < 0 || seen.has(`${trade.date}-${trade.action}`)) continue
    seen.add(`${trade.date}-${trade.action}`)
    const value = returns[index] ?? 0
    markers.push({
      x: x(index),
      y: y(value),
      index,
      value: value * 100,
      action: trade.action,
      date: trade.date,
      amount: trade.amount,
    })
  }
  // 时间轴密集时只标关键笔：首笔买入、最后一笔，再按金额从大到小补位，且保持最小间距。
  const labels: FundMarker[] = []
  const firstBuy = markers.find(marker => marker.action === 'buy')
  const ranked = [...markers].sort((left, right) =>
    right.amount - left.amount || left.date.localeCompare(right.date))
  const labeled = new Set<string>()
  for (const candidate of [firstBuy, markers[markers.length - 1], ...ranked]) {
    if (candidate === undefined || labels.length >= 5) continue
    const key = `${candidate.date}-${candidate.action}`
    if (labeled.has(key) || labels.some(label => Math.abs(label.x - candidate.x) < 34)) continue
    labeled.add(key)
    labels.push(candidate)
  }
  return {
    path,
    costY: costReturn === undefined ? undefined : y(costReturn),
    zeroY: y(0),
    markers,
    labels,
    startDate: first.date,
    endDate: last.date,
    rangeReturn: returns[returns.length - 1] ?? 0,
    minValue: bottom * 100,
    maxValue: top * 100,
    costValue: costReturn === undefined ? undefined : costReturn * 100,
    points: returns.map(value => value * 100),
    // 日净值只有单值，按「前一日为开盘、当日为收盘」合成 K 线（无影线）。
    candles: returns.map((value, index) => {
      const open = index === 0 ? value : returns[index - 1] ?? value
      return [open * 100, Math.max(open, value) * 100, Math.min(open, value) * 100, value * 100]
    }),
  }
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

function dailyDotState(result: DailyTaskResult | undefined): StateDotState {
  switch (result?.status) {
    case 'ok':
    case 'backfilled': return 'done'
    case 'running': return 'ongoing'
    case 'missing':
    case 'failed':
    case 'no_artifact':
    case 'missed': return 'error'
    case 'pending': return 'warning'
    case 'idle':
    case 'skip':
    case 'skip_day':
    case undefined: return 'idle'
    default: return 'warning'
  }
}

function dailyStatusLabel(result: DailyTaskResult | undefined, t: TranslateNS<typeof NS>): string {
  switch (result?.status) {
    case 'ok': return t('daily.status.ok')
    case 'backfilled': return t('daily.status.backfilled')
    case 'running': return t('daily.status.running')
    case 'missing': return t('daily.status.missing')
    case 'failed': return t('daily.status.failed')
    case 'no_artifact': return t('daily.status.noArtifact')
    case 'missed': return t('daily.status.missed')
    case 'pending': return t('daily.status.pending')
    case 'idle': return t('daily.status.idle')
    case 'skip': return t('daily.status.skip')
    case 'skip_day': return t('daily.status.skipDay')
    case undefined: return t('daily.status.unavailable')
    default: return result?.status ?? t('daily.status.unavailable')
  }
}

function statusLabel(status: JobView['status'], t: TranslateNS<typeof NS>): string {
  switch (status) {
    case 'running': return t('status.running')
    case 'stopping': return t('status.stopping')
    case 'completed': return t('status.completed')
    case 'killed': return t('status.killed')
    case 'failed': return t('status.failed')
  }
}

function jobDotState(job: JobView): StateDotState {
  switch (job.status) {
    case 'running': return 'ongoing'
    case 'stopping': return 'warning'
    case 'completed': return job.exitCode === undefined || job.exitCode === 0 ? 'done' : 'warning'
    case 'killed': return 'warning'
    case 'failed': return 'error'
  }
}

function orderedJobs(jobs: readonly JobView[]): JobView[] {
  return [...jobs].sort((left, right) => {
    const leftLive = left.status === 'running' || left.status === 'stopping'
    const rightLive = right.status === 'running' || right.status === 'stopping'
    if (leftLive !== rightLive) return leftLive ? -1 : 1
    return right.startedAt - left.startedAt
  })
}

/** One accessible SVG donut with a semantic-token legend. */
function DonutChart({ title, segments, totalLabel, emptyLabel }: {
  title: string
  segments: readonly ChartSegment[]
  totalLabel: string
  emptyLabel: string
}): ReactNode {
  const container = useRef<HTMLDivElement>(null)
  const palette = useChartPalette(container)
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)
  const empty = total === 0
  const options = useMemo<ApexOptions>(() => ({
    chart: {
      type: 'donut',
      height: 112,
      width: 112,
      animations: { enabled: false },
      parentHeightOffset: 0,
      fontFamily: 'inherit',
    },
    series: empty ? [1] : segments.map(segment => segment.value),
    labels: empty ? [emptyLabel] : segments.map(segment => segment.label),
    colors: empty ? [palette.border] : segments.map(segment => toneColor(segment.tone, palette)),
    stroke: { width: 2, colors: [palette.surface] },
    dataLabels: { enabled: false },
    legend: { show: false },
    tooltip: { enabled: !empty, y: { formatter: value => String(value) } },
    plotOptions: {
      pie: {
        expandOnClick: false,
        donut: {
          size: '76%',
          labels: {
            show: true,
            name: { show: false },
            value: { show: false },
            total: {
              show: true,
              label: empty ? emptyLabel : totalLabel,
              color: palette.text,
              fontSize: '20px',
              formatter: () => String(empty ? 0 : total),
            },
          },
        },
      },
    },
  }), [segments, empty, emptyLabel, total, totalLabel, palette])
  return (
    <div className={css.chart}>
      <div className={css.donutApex} ref={container} role="img" aria-label={title}>
        <Chart options={options} series={options.series} type="donut" height={112} width={112} />
      </div>
      <div className={css.chartCopy}>
        <h3>{title}</h3>
        {total === 0 ? <p className={css.empty}>{emptyLabel}</p> : (
          <ul className={css.legend}>
            {segments.map(segment => (
              <li key={segment.key}>
                <span className={`${css.swatch} ${css[segment.tone]}`} aria-hidden="true" />
                <span>{segment.label}</span>
                <strong>{segment.value}</strong>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** Return curve with cost line and buy/sell markers for the selected fund. */
function FundChart({ fund, t }: { fund: FundRecord; t: TranslateNS<typeof NS> }): ReactNode {
  const container = useRef<HTMLDivElement>(null)
  const palette = useChartPalette(container)
  const chart = useMemo(() => buildFundChart(fund), [fund])
  const categories = useMemo(() => fund.history.map(point => point.date), [fund.history])
  const options = useMemo<ApexOptions>(() => {
    if (chart === undefined) return {}
    const lineColor = chart.rangeReturn >= 0 ? palette.success : palette.error
    return {
      chart: {
        type: 'candlestick',
        height: CHART_HEIGHT,
        toolbar: { show: false },
        zoom: { enabled: false },
        animations: { enabled: false },
        parentHeightOffset: 0,
        fontFamily: 'inherit',
        redrawOnParentResize: true,
      },
      colors: [lineColor],
      plotOptions: {
        candlestick: {
          colors: { upward: palette.success, downward: palette.error },
          wick: { useFillColor: true },
        },
      },
      stroke: { width: 1 },
      markers: { size: 0, hover: { size: 3 } },
      dataLabels: { enabled: false },
      legend: { show: false },
      grid: { show: false, padding: { left: 2, right: 2, top: 6, bottom: 0 } },
      xaxis: {
        categories,
        tickAmount: 2,
        axisBorder: { show: false },
        axisTicks: { show: false },
        labels: {
          style: { colors: palette.textMuted, fontSize: '8px' },
          formatter: value => String(value).slice(5),
        },
      },
      yaxis: {
        min: chart.minValue,
        max: chart.maxValue,
        tickAmount: 3,
        axisBorder: { show: false },
        axisTicks: { show: false },
        labels: {
          style: { colors: palette.textMuted, fontSize: '8px' },
          formatter: value => `${(value ?? 0).toFixed(0)}%`,
        },
      },
      tooltip: {
        x: { show: true },
        y: {
          formatter: value => Array.isArray(value)
            ? value.map(item => `${(item ?? 0) >= 0 ? '+' : ''}${(item ?? 0).toFixed(2)}%`).join(' / ')
            : `${(value ?? 0) >= 0 ? '+' : ''}${(value ?? 0).toFixed(2)}%`,
        },
      },
      annotations: {
        yaxis: [
          { y: 0, borderColor: palette.border, strokeDashArray: 0 },
          ...(chart.costValue === undefined ? [] : [{
            y: chart.costValue,
            borderColor: palette.textMuted,
            strokeDashArray: 3,
          }]),
        ],
        points: chart.markers.map(marker => ({
          x: marker.index,
          y: marker.value,
          marker: {
            size: 3,
            shape: 'circle',
            fillColor: marker.action === 'buy' ? palette.success : palette.error,
            strokeColor: palette.surface,
            strokeWidth: 1,
          },
          ...(chart.labels.includes(marker) ? {
            label: {
              text: `${marker.date.slice(5)} ${t(marker.action === 'buy' ? 'fund.buyShort' : 'fund.sellShort')}`,
              offsetY: marker.action === 'buy' ? -5 : 9,
              borderWidth: 0,
              style: {
                background: palette.surface,
                color: marker.action === 'buy' ? palette.success : palette.error,
                fontSize: '7px',
              },
            },
          } : {}),
        })),
      },
    }
  }, [chart, categories, palette, t])
  if (chart === undefined) return <p className={css.emptyBlock}>{t('fund.empty')}</p>
  const tone = chart.rangeReturn >= 0 ? css.toneSuccess : css.toneError
  const rangeLabel = t('fund.range', { value: formatPercent(chart.rangeReturn) })
  return (
    <div className={css.fundFocus}>
      <div className={css.fundFocusHead}>
        <h3>
          {fund.name}
          <span className={css.fundCode}>{fund.code}</span>
        </h3>
        <span className={tone}>{rangeLabel}</span>
      </div>
      <div className={css.fundApex} ref={container} role="img" aria-label={`${fund.name} ${rangeLabel}`}>
        <Chart options={options} series={[{ name: fund.name, data: chart.candles.map(candle => [...candle]) }]}
          type="candlestick" height={CHART_HEIGHT} width="100%" />
      </div>
      <div className={css.fundLegend}>
        {chart.costY !== undefined && (
          <span>
            <span className={`${css.swatch} ${css.toneMuted}`} aria-hidden="true" />
            {t('fund.costLine')}
          </span>
        )}
        <span className={css.toneSuccess}>
          <span className={`${css.swatch} ${css.toneSuccess}`} aria-hidden="true" />
          {t('fund.buy')}
        </span>
        <span className={css.toneError}>
          <span className={`${css.swatch} ${css.toneError}`} aria-hidden="true" />
          {t('fund.sell')}
        </span>
      </div>
    </div>
  )
}

/** One headline metric. */
function Metric({ label, value, tone }: { label: string; value: number | string; tone?: string | undefined }): ReactNode {
  return (
    <div className={css.metric}>
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
    </div>
  )
}

/** Workspace, Session, scheduled-task, and background-job status page. */
export function Dashboard({ sessionId, useSessions, useJobs, watchRows, listDirectory, readFile, t }: DashboardProps): ReactNode {
  const sessions = useSessions(state => state.ids)
  const sessionRows = useSessions(state => state.byId)
  const cwd = useSessions(state => selectSessionDirectory(state, sessionId))
  const jobs = useJobs(state => state.rows[sessionId]) ?? NO_JOBS
  const [reload, setReload] = useState(0)
  const [fileState, setFileState] = useState<FileState>({ status: 'loading' })
  const [dailyState, setDailyState] = useState<DailyState>({ status: 'loading' })
  const [fundState, setFundState] = useState<FundState>({ status: 'loading' })
  const [selectedFund, setSelectedFund] = useState('')

  useEffect(() => watchRows(sessionId), [sessionId, watchRows])
  useEffect(() => {
    if (cwd === undefined) {
      setFileState({ status: 'error' })
      return
    }
    const controller = new AbortController()
    let active = true
    setFileState({ status: 'loading' })
    void scanWorkspace(sessionId, cwd, listDirectory, controller.signal).then(stats => {
      if (active) setFileState({ status: 'ready', stats })
    }).catch(() => {
      if (active && !controller.signal.aborted) setFileState({ status: 'error' })
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [sessionId, cwd, listDirectory, reload])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setDailyState({ status: 'loading' })
    void loadDailyState(sessionId, readFile, controller.signal).then(next => {
      if (active) setDailyState(next)
    }).catch(() => {
      if (active && !controller.signal.aborted) setDailyState({ status: 'error' })
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [sessionId, readFile, reload])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setFundState({ status: 'loading' })
    void loadFundState(sessionId, readFile, controller.signal).then(next => {
      if (active) setFundState(next)
    }).catch(() => {
      if (active && !controller.signal.aborted) setFundState({ status: 'error' })
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [sessionId, readFile, reload])

  const runningSessions = sessions.filter(id => sessionRows[id]?.running).length
  const runningJobs = jobs.filter(job => job.status === 'running' || job.status === 'stopping').length
  const visibleJobs = useMemo(() => orderedJobs(jobs).slice(0, 6), [jobs])
  const stats = fileState.status === 'ready' ? fileState.stats : undefined
  const fileSegments: ChartSegment[] = stats === undefined ? [] : FILE_CATEGORIES.flatMap((category, index) => {
    const value = stats.categories[category]
    if (value === 0) return []
    const tones: readonly Tone[] = ['toneBusiness', 'toneSuccess', 'toneWarning', 'toneError', 'toneMuted', 'toneBusiness']
    return [{ key: category, label: t(`category.${category}`), value, tone: tones[index] ?? 'toneMuted' }]
  })
  const sessionSegments: ChartSegment[] = [
    { key: 'running', label: t('session.running'), value: runningSessions, tone: 'toneBusiness' },
    { key: 'idle', label: t('session.idle'), value: sessions.length - runningSessions, tone: 'toneMuted' },
  ]
  const completedJobs = jobs.filter(job => job.status === 'completed' && (job.exitCode === undefined || job.exitCode === 0)).length
  const failedJobs = jobs.filter(job => job.status === 'failed' || (job.status === 'completed' && job.exitCode !== undefined && job.exitCode !== 0)).length
  const jobSegments: ChartSegment[] = [
    { key: 'running', label: t('status.running'), value: runningJobs, tone: 'toneBusiness' },
    { key: 'completed', label: t('status.completed'), value: completedJobs, tone: 'toneSuccess' },
    { key: 'failed', label: t('status.failed'), value: failedJobs, tone: 'toneError' },
    { key: 'killed', label: t('status.killed'), value: jobs.filter(job => job.status === 'killed').length, tone: 'toneMuted' },
  ]
  const dailySubtitle = dailyState.status === 'ready' && dailyState.date !== undefined
    ? t(dailyState.historical ? 'daily.historical' : 'daily.date', { date: dailyState.date })
    : t('daily.subtitle')
  const fundSnapshot = fundState.status === 'ready' ? fundState.snapshot : undefined
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

      <div className={css.metrics}>
        <Metric label={t('metric.sessions')} value={sessions.length} />
        <Metric label={t('metric.runningSessions')} value={runningSessions} tone={css.valueBusiness} />
        <Metric label={t('metric.files')} value={stats?.files ?? '—'} />
        <Metric label={t('metric.runningJobs')} value={runningJobs} tone={runningJobs > 0 ? css.valueBusiness : undefined} />
      </div>

      <div className={css.split}>
      <section className={css.card} data-fund-panel>
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
                <strong>{t('fund.money', { value: formatNumber(fundSummary.value) })}</strong>
              </div>
              <div className={css.fundStat}>
                <span>{t('fund.totalCost')}</span>
                <strong>{t('fund.money', { value: formatNumber(fundSummary.cost) })}</strong>
              </div>
              <div className={css.fundStat}>
                <span>{t('fund.pnl')}</span>
                <strong className={fundSummary.pnl >= 0 ? css.toneSuccess : css.toneError}>
                  {signedMoney(fundSummary.pnl, t)}
                </strong>
              </div>
              <div className={css.fundStat}>
                <span>{t('fund.return')}</span>
                <strong className={fundSummary.pnl >= 0 ? css.toneSuccess : css.toneError}>
                  {fundSummary.rate === undefined ? '—' : formatPercent(fundSummary.rate)}
                </strong>
              </div>
            </div>
            <div className={css.fundChips}>
              {funds.map(fund => (
                <button key={fund.code} type="button" aria-pressed={fund.code === activeFund.code}
                  className={`${css.fundChip} ${fund.code === activeFund.code ? css.fundChipActive : ''}`}
                  onClick={() => setSelectedFund(fund.code)}>
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
                    <span className={fund.nav >= fund.cost ? css.toneSuccess : css.toneError}>
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

      <section className={css.card} data-daily-tasks>
        <div className={css.sectionHeader}>
          <div><h2>{t('daily.title')}</h2><p>{dailySubtitle}</p></div>
          {dailyState.status === 'ready' && <span className={css.count}>{t('daily.total', { count: dailyState.tasks.length })}</span>}
        </div>
        {dailyState.status === 'loading' && <p className={css.emptyBlock}>{t('daily.loading')}</p>}
        {(dailyState.status === 'missing' || dailyState.status === 'error' || dailyState.status === 'invalid') && (
          <div className={css.emptyBlock}>
            <p>{t(dailyState.status === 'missing' ? 'daily.missing' : dailyState.status === 'invalid' ? 'daily.invalid' : 'daily.error')}</p>
            <button type="button" className={css.retry} onClick={() => { setReload(value => value + 1) }}>{t('daily.retry')}</button>
          </div>
        )}
        {dailyState.status === 'ready' && dailyState.tasks.length === 0 && <p className={css.emptyBlock}>{t('daily.empty')}</p>}
        {dailyState.status === 'ready' && dailyState.tasks.length > 0 && (
          <ul className={css.dailyList}>
            {dailyState.tasks.map(task => (
              <li key={task.name}>
                <StateDot state={dailyDotState(task.result)} />
                <div className={css.dailyMain}>
                  <div className={css.dailyNameRow}>
                    <span className={css.dailyName} title={task.name}>{task.name}</span>
                    <span className={css.dailySchedule}>{task.schedule}</span>
                  </div>
                  {task.result?.detail !== undefined && task.result.detail !== '' && (
                    <span className={css.dailyDetail} title={task.result.detail}>{task.result.detail}</span>
                  )}
                </div>
                <span className={css.dailyStatus}>{dailyStatusLabel(task.result, t)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={css.card}>
        <div className={css.sectionHeader}>
          <div><h2>{t('jobs.title')}</h2><p>{t('jobs.current')}</p></div>
          <span className={css.count}>{t('jobs.total', { count: jobs.length })}</span>
        </div>
        {visibleJobs.length === 0 ? <p className={css.emptyBlock}>{t('jobs.empty')}</p> : (
          <ul className={css.jobList}>
            {visibleJobs.map(job => (
              <li key={String(job.id)}>
                <StateDot state={jobDotState(job)} />
                <span className={css.jobLabel} title={job.label}>{job.label}</span>
                <span className={css.jobStatus}>{statusLabel(job.status, t)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={css.card}>
        <div className={css.sectionHeader}>
          <div><h2>{t('files.title')}</h2><p>{t('files.subtitle')}</p></div>
          {stats !== undefined && <span className={css.count}>{t('files.directories', { count: stats.directories })}</span>}
        </div>
        {fileState.status === 'loading' && <p className={css.emptyBlock}>{t('files.loading')}</p>}
        {fileState.status === 'error' && (
          <div className={css.emptyBlock}>
            <p>{t('files.error')}</p>
            <button type="button" className={css.retry} onClick={() => { setReload(value => value + 1) }}>{t('files.retry')}</button>
          </div>
        )}
        {stats !== undefined && (
          <>
            <DonutChart title={t('files.title')} segments={fileSegments} totalLabel={t('chart.total')} emptyLabel={t('chart.empty')} />
            <p className={css.footnote}>{t(stats.truncated ? 'files.truncated' : 'files.complete')}</p>
          </>
        )}
      </section>
      </div>

      <section className={css.card}>
        <div className={css.sectionHeader}>
          <div><h2>{t('activity.title')}</h2><p>{t('activity.subtitle')}</p></div>
        </div>
        <div className={css.charts}>
          <DonutChart title={t('chart.sessions')} segments={sessionSegments} totalLabel={t('chart.total')} emptyLabel={t('chart.empty')} />
          <DonutChart title={t('chart.jobs')} segments={jobSegments} totalLabel={t('chart.total')} emptyLabel={t('chart.empty')} />
        </div>
      </section>
    </div>
  )
}
