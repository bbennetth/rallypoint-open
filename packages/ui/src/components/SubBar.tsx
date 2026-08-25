import type { ReactNode } from 'react'

/**
 * `<SubBar>` — the Ink design kit's shared **secondary glass bar** that
 * sits above the mobile tab-bar for section switching within a tab
 * (e.g. Planner's My Day Agenda/Week/Month, Events Attendee's Social
 * DMs/Groups/Feed). On desktop the glass collapses into a regular
 * inline strip — same markup renders correctly above 1024px.
 *
 * Single source of truth for the glass blur + radius + shadow tokens.
 * Visual styles live in `packages/ui/src/shell.css` (`.rp-subbar`,
 * `.rp-subbar-seg`) so they re-tint with the live accent.
 *
 * Pair with `<SubBarSeg>` children and (optionally) a trailing
 * `<Fab anchor="subbar">` for the kit's quick-add slot.
 */
export interface SubBarProps {
  /** ARIA label for the bar's role (e.g. "Section switcher"). */
  label?: string
  /** Segments (typically `<SubBarSeg>` children). */
  children: ReactNode
  /** Optional trailing quick-add control. Pass a `<Fab anchor="subbar" />`
   *  here so the kit's "FAB attached to the sub-bar" pattern composes
   *  from a single page-side declaration; the Fab renders as the last
   *  flex child of the bar at the canonical right-edge slot.
   *
   *  Pages without a SubBar should render `<Fab anchor="float" />`
   *  directly at the page's top level instead — `pickFabAnchor` codifies
   *  the per-route routing of which placement to use. */
  fab?: ReactNode
  /** Extra className for app-specific tweaks. Optional. */
  className?: string
}

export function SubBar({ label, children, fab, className }: SubBarProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className={'rp-subbar' + (className ? ' ' + className : '')}
    >
      {children}
      {fab}
    </div>
  )
}
