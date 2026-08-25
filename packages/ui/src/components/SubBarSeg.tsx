import type { ButtonHTMLAttributes, ReactNode } from 'react'

/**
 * `<SubBarSeg>` — one segment inside a `<SubBar>`. Renders as a mono
 * uppercase label; the `active` segment fills accent. Composes plain
 * `<button>` so apps can wire `onClick` to whatever state mechanism
 * they use (React state, Zustand, router-driven, etc.).
 *
 * The button uses `aria-pressed` (not `role="tab"` + `aria-selected`)
 * because `role="tab"` would require its parent `<SubBar>` to be a
 * `role="tablist"` — but the SubBar is a generic group container that
 * may carry non-segment children too (e.g. a trailing `<Fab>` for the
 * quick-add slot). The toggle-button pattern is the right ARIA shape
 * for a segmented control that lives inside a group.
 */
export interface SubBarSegProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  active?: boolean
  children: ReactNode
}

export function SubBarSeg({ active = false, className, children, ...rest }: SubBarSegProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={'rp-subbar-seg' + (active ? ' is-active' : '') + (className ? ' ' + className : '')}
      {...rest}
    >
      {children}
    </button>
  )
}
