import { useCallback, useEffect, useRef } from 'react'
import type { CSSProperties, FocusEvent, ReactNode } from 'react'
import { nextFocusAfterTrap } from '../lib/focus-trap.js'
import { drawerCss, drawerRootClass } from '../lib/drawer.js'

// Right-side slide-out panel for compact secondary surfaces (invite
// forms, edit panels, filters). Backdrop click and Escape close;
// focus is trapped inside while open. CSS-only animation via a new
// `--duration-drawer` theme token (default 220ms; consumers can
// override on `:root`).
//
//   <Drawer open={open} onClose={() => setOpen(false)} title="Invite by email">
//     <form>…</form>
//   </Drawer>

// Layout/animation/bottom-sheet rules are injected once into <head> the
// first time any Drawer mounts (rather than per-instance in render) so a
// page with several Drawers doesn't duplicate the stylesheet. Consumers
// still don't have to load a separate CSS file.
const DRAWER_STYLE_ID = 'rp-drawer-styles'

function ensureDrawerStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(DRAWER_STYLE_ID)) return
  const el = document.createElement('style')
  el.id = DRAWER_STYLE_ID
  el.textContent = drawerCss()
  document.head.appendChild(el)
}

export interface DrawerProps {
  /** Open state. Controlled by the caller. */
  open: boolean
  /** Called on backdrop click or Escape. */
  onClose: () => void
  /** Optional header title rendered in a `display`-font H2. */
  title?: ReactNode
  /** Drawer body. Scrolls vertically if it overflows. */
  children: ReactNode
  /** Width in pixels (default 360, capped at viewport). */
  width?: number
  /** Aria label when no `title` is supplied. */
  ariaLabel?: string
  /** Render as a full-width bottom sheet on narrow viewports
   * (≤ `DRAWER_SHEET_BREAKPOINT`) instead of a right-side panel. Adds
   * a safe-area bottom inset and scrolls focused inputs above the
   * soft keyboard. Defaults to `false` (desktop right-side behavior). */
  mobileSheet?: boolean
}

export function Drawer({
  open,
  onClose,
  title,
  children,
  width = 360,
  ariaLabel,
  mobileSheet = false,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  // Inject the shared stylesheet once (idempotent across instances).
  useEffect(() => {
    ensureDrawerStyles()
  }, [])

  // Focus + trap lifecycle.
  useEffect(() => {
    if (!open) return
    previouslyFocused.current = document.activeElement as HTMLElement | null
    // Push focus into the drawer on the next frame so the slide-in
    // animation has started; calling focus on a display:none subtree
    // is a no-op anyway.
    const id = window.requestAnimationFrame(() => {
      if (!panelRef.current) return
      const first = nextFocusAfterTrap(panelRef.current, null, 'forward')
      ;(first ?? panelRef.current).focus()
    })
    return () => {
      window.cancelAnimationFrame(id)
      previouslyFocused.current?.focus?.()
    }
  }, [open])

  // Escape + Tab trap.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panelRef.current) return
      const next = nextFocusAfterTrap(
        panelRef.current,
        document.activeElement,
        e.shiftKey ? 'backward' : 'forward',
      )
      if (!next) return
      e.preventDefault()
      next.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // When rendered as a bottom sheet, the soft keyboard can occlude the
  // focused field. Scroll it back into the visible part of the sheet on
  // focus. No-op on desktop (right-side panel never overlaps a keyboard).
  const onBodyFocus = useCallback(
    (e: FocusEvent<HTMLDivElement>) => {
      if (!mobileSheet) return
      const el = e.target as HTMLElement
      if (!el.matches('input, textarea, select')) return
      window.requestAnimationFrame(() => {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      })
    },
    [mobileSheet],
  )

  if (!open) return null

  return (
    <div role="presentation" className={drawerRootClass(mobileSheet)}>
      <div
        aria-hidden
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.4)',
          animation: 'rp-drawer-fade-in var(--duration-drawer, 220ms) ease-out',
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : ariaLabel}
        tabIndex={-1}
        className="rp-drawer-panel"
        style={{ '--rp-drawer-width': `${width}px` } as CSSProperties}
      >
        {title && (
          <div
            style={{
              flex: '0 0 auto',
              padding: '14px 16px',
              borderBottom: '1.5px solid var(--line)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <h2
              className="display"
              style={{ fontSize: 14, letterSpacing: '0.04em', textTransform: 'uppercase' }}
            >
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                background: 'none',
                border: '1.5px solid var(--line)',
                cursor: 'pointer',
                padding: '4px 8px',
                color: 'var(--ink-dim)',
                fontSize: 16,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
        )}
        <div
          className="rp-drawer-body"
          onFocus={mobileSheet ? onBodyFocus : undefined}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
