/**
 * Browser half: a right-sidebar status page over the existing Session, jobs,
 * and workspace-file services. The page opens once for each newly mounted
 * Session; after that, the human's close and tab choices remain untouched.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-job-controller/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Dashboard } from './Dashboard.tsx'
import type { DashboardInjected } from './Dashboard.tsx'
import { DashboardTitle } from './DashboardTitle.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh, type StatusDashboardKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Status-dashboard labels and chart copy. */
    statusDashboard: StatusDashboardKey
  }
}

/** This implementation's identity in the tab system and keyed body seat. */
export const DASHBOARD_ID = '@deepseek-ai/dsh-client-ui-status-dashboard'

/** The page kind used by the right-sidebar navigation controller. */
export const DASHBOARD_KIND = 'status'

/** Required services: right-sidebar registration, live jobs, workspace files, slots, and copy. */
export const inject = [
  'slots', 'locale', 'layout', 'sidebarRightTabs', 'sidebarRight', 'jobs', 'remote', 'remote.workspaceFiles',
]

/**
 * Register the page, its body and title, and its once-per-Session reveal.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-status-dashboard: dictionaries')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: DASHBOARD_ID,
    kind: DASHBOARD_KIND,
    priority: 'extension',
    title: () => t('tab.title'),
  }), 'ui-status-dashboard: page type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    {
      name: 'sidebar.right.pane.tab',
      key: DASHBOARD_ID,
      locale: NS,
      inject: (): DashboardInjected => ({
        hooks: { jobs: ctx.jobs.state },
        watchRows: sessionId => ctx.jobs.watchRows(sessionId),
        listDirectory: (sessionId, path, signal) => ctx.remote.workspaceFiles.list(sessionId, path, signal),
        readFile: (sessionId, path, options, signal) => ctx.remote.workspaceFiles.readBytes(sessionId, path, options, signal),
      }),
    },
    Dashboard,
  )), 'ui-status-dashboard: page body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: DASHBOARD_ID },
    DashboardTitle,
  )), 'ui-status-dashboard: page title')
  ctx.effect(() => {
    const opened = new Set<SessionId>()
    let timer: ReturnType<typeof setTimeout> | undefined
    // H5 上状态面板铺满整屏，但会话恢复晚于首帧；先用同色遮罩挡住聊天输入框，
    // 面板完成挂载后立刻撤掉，避免「先输入框、后面板」的闪烁。
    let cover: HTMLDivElement | undefined
    if (typeof document !== 'undefined' && window.innerWidth < 768) {
      cover = document.createElement('div')
      cover.dataset.dshDashboardBoot = ''
      cover.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:var(--dsw-alias-bg-base,#101114)'
      document.body.append(cover)
    }
    const dropCover = (): void => {
      cover?.remove()
      cover = undefined
    }
    const coverTimer = cover === undefined ? undefined : setTimeout(dropCover, 4_000)
    const reveal = (force: boolean): void => {
      if (timer !== undefined) clearTimeout(timer)
      // `mounted` changes before React mints the arriving Session's surface;
      // navigate after that render commit, as an ordinary component effect would.
      timer = setTimeout(() => {
        timer = undefined
        const sessionId = ctx.sidebarRight.mounted.getSnapshot()
        if (sessionId === undefined || (!force && opened.has(sessionId))) return
        ctx.sidebarRight.openTab(DASHBOARD_KIND)
        opened.add(sessionId)
        // 等面板完成这一帧绘制再撤遮罩。
        requestAnimationFrame(dropCover)
      }, 0)
    }
    const scheduleReveal = (): void => { reveal(false) }
    scheduleReveal()
    const unsubscribe = ctx.sidebarRight.mounted.subscribe(scheduleReveal)
    // Leaving the frame-filling dashboard for a conversation should keep the
    // panel beside it even when the Session itself is reused (New Session on a
    // blank one), where no mount change announces the switch.
    let full = ctx.layout.dashboardFull.getSnapshot()
    const unsubscribeFull = ctx.layout.dashboardFull.subscribe(() => {
      const next = ctx.layout.dashboardFull.getSnapshot()
      if (next === full) return
      full = next
      if (!next) reveal(true)
    })
    return () => {
      unsubscribe()
      unsubscribeFull()
      if (timer !== undefined) clearTimeout(timer)
      if (coverTimer !== undefined) clearTimeout(coverTimer)
      dropCover()
    }
  }, 'ui-status-dashboard: reveal for mounted Session')
}
