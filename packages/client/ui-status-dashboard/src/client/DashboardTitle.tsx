import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './Dashboard.module.css'

/** Status-page chip title. */
export function DashboardTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return <><span className={css.titleMark} aria-hidden="true" />{tab.title}</>
}
