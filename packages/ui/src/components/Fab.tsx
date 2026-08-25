import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { FabAnchor } from '../lib/fab-anchor.js'

/**
 * `<Fab>` — the Ink design kit's quick-add floating action button.
 * Small accent rounded-square (40×40, radius-md). Two placements at the
 * same bottom-right anchor:
 *
 *  - `anchor="subbar"` — flex child of an `<SubBar>` (use as a sibling
 *    of `<SubBarSeg>` children).
 *  - `anchor="float"` (default) — standalone, lifted to the shared
 *    bottom-right anchor above the tab-bar.
 *
 * The decision is route-driven: see `pickFabAnchor()` for the canonical
 * routing of page key → anchor. Defaulting to `'float'` matches the
 * util's null-safe behavior — a standalone FAB never overlays content.
 */
export interface FabProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Anchor placement. Defaults to `'float'`. */
  anchor?: FabAnchor
  /**
   * Aria label for the button. Recommended whenever the rendered
   * content is just an icon ("Add" / "New task" / "New post" / etc.).
   */
  'aria-label'?: string
  children?: ReactNode
}

export function Fab({ anchor = 'float', className, children, ...rest }: FabProps) {
  const klass =
    'rp-fab' +
    (anchor === 'float' ? ' rp-fab-float' : '') +
    (className ? ' ' + className : '')
  // The default render is just the plus glyph (`aria-hidden`), so without
  // a caller-supplied `aria-label` the button has no accessible name.
  // Default to "Add" so a bare `<Fab />` announces correctly to screen
  // readers; callers passing a more specific label always override it.
  const ariaLabel = rest['aria-label'] ?? 'Add'
  return (
    <button type="button" className={klass} {...rest} aria-label={ariaLabel}>
      {children ?? <PlusGlyph />}
    </button>
  )
}

function PlusGlyph() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}
