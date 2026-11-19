/**
 * The way in and out of the panel: one button in the conversation header's
 * corner seat. Collapsed, it opens the panel; expanded on desktop, it closes
 * the chat and returns the panel to the frame-filling dashboard.
 *
 * It lives in the conversation's own header rather than in the frame's right
 * column so that a collapsed Sidebar costs the conversation nothing — no rail,
 * no width, and the transcript's scrollbar stays at the column's edge. The
 * corner seat is its own, past the utilities' edge, so the button never joins
 * the utilities row. On mobile devices, the disabled button stays mounted
 * and hidden while the panel is shown, preserving the title's width during
 * the overlay slide. Desktop devices swap it for the close-chat control while
 * the panel is shown. It shares the panel's per-session store because both
 * seats are session-scoped.
 *
 * The open glyph is the left sidebar's collapse icon mirrored: the same
 * affordance, on the other edge.
 */
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { InjectFace, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconCloseOutlineRegular, IconPanelLeftOutlineRegular, isMobileDevice, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { createSidebarRightStore } from '../stores.ts'
import css from './ExpandButton.module.css'

/** The button's props: the header corner seat, the shared store, and copy. */
export type ExpandButtonProps =
  & PropsRuntime<'conversation.session.header.corner'>
  & PropsStore<ReturnType<typeof createSidebarRightStore>>
  & PropsLocale<'sidebarRight'>
  & InjectFace<{
    hooks: { shortcuts: HostObservable<readonly ShortcutCatalogEntry[]> }
    /** Close the chat view by letting the panel fill the frame beside the sidebar. */
    setDashboardFull: () => void
  }>

/** Opens a collapsed panel; when expanded, closes the chat on desktop and hides on mobile devices. */
export function ExpandButton({ sessionId, useStore, actions, t, useShortcuts, setDashboardFull }: ExpandButtonProps): ReactNode {
  // A session with no surface yet is collapsed: the panel seat materializes the
  // surface on its own mount, and until then there is nothing expanded.
  const shortcut = useShortcuts(entries => entries.find(entry => entry.id === 'sidebar.right.toggle'))
  const expanded = useStore(state => state.bySession[sessionId]?.layout.expanded ?? false)
  if (expanded && !isMobileDevice()) {
    return (
      <Tooltip label={t('chrome.closeChat')} side="bottom" delayMs={500}>
        <Button
          size="sm"
          className={css.button}
          aria-label={t('chrome.closeChatAria')}
          data-sidebar-right-close-chat
          onClick={() => { setDashboardFull() }}
        >
          <IconCloseOutlineRegular />
        </Button>
      </Tooltip>
    )
  }
  return (
    <Tooltip label={t('chrome.expand')} shortcutKeys={shortcut?.keys} side="bottom" delayMs={500} disabled={expanded}>
      <Button
        size="sm"
        className={clsx(css.button, expanded && css.expanded)}
        disabled={expanded}
        aria-label={t('chrome.expandAria')}
        aria-keyshortcuts={shortcut?.aria}
        data-sidebar-right-expand
        onClick={() => { actions.setExpanded(sessionId, true) }}
      >
        <IconPanelLeftOutlineRegular className={css.icon} />
      </Button>
    </Tooltip>
  )
}
