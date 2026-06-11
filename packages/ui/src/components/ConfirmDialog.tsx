import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Button, type ButtonVariant } from './Button.js'
import { nextFocusAfterTrap } from '../lib/focus-trap.js'

const CONFIRM_STYLE_ID = 'rp-confirm-styles'

function ensureConfirmStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(CONFIRM_STYLE_ID)) return
  const el = document.createElement('style')
  el.id = CONFIRM_STYLE_ID
  el.textContent = `
    @keyframes rp-confirm-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes rp-confirm-pop-in {
      from { transform: translateY(8px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
  `
  document.head.appendChild(el)
}

// Centred modal confirmation. Replaces `window.confirm()` everywhere
// in the platform. Escape and backdrop-click both invoke `onCancel`
// (treating dismissal as a "no"). Focus traps to the panel while
// open and restores on close.
//
//   <ConfirmDialog
//     open={confirming}
//     title="Remove attendee?"
//     body="They'll lose access immediately. Their group memberships stay."
//     confirmLabel="Remove"
//     confirmVariant="hot"
//     onConfirm={async () => { await removeAttendee(); setConfirming(false) }}
//     onCancel={() => setConfirming(false)}
//   />

export interface ConfirmDialogProps {
  open: boolean
  title: ReactNode
  body?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** Button variant for the confirm action. `hot` for destructive. */
  confirmVariant?: ButtonVariant
  onConfirm: () => void | Promise<void>
  onCancel: () => void
  /** Set true while the confirm action is in flight; disables both buttons. */
  busy?: boolean
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmVariant = 'brutal',
  onConfirm,
  onCancel,
  busy = false,
}: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  // Inject the shared stylesheet once (idempotent across instances).
  useEffect(() => {
    ensureConfirmStyles()
  }, [])

  useEffect(() => {
    if (!open) return
    previouslyFocused.current = document.activeElement as HTMLElement | null
    const id = window.requestAnimationFrame(() => {
      if (!panelRef.current) return
      // Focus the confirm button by default so Enter confirms.
      const next = nextFocusAfterTrap(panelRef.current, null, 'backward')
      ;(next ?? panelRef.current).focus()
    })
    return () => {
      window.cancelAnimationFrame(id)
      previouslyFocused.current?.focus?.()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (!busy) onCancel()
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
  }, [open, busy, onCancel])

  if (!open) return null

  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 65,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        aria-hidden
        onClick={() => {
          if (!busy) onCancel()
        }}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.4)',
          animation: 'rp-confirm-fade-in var(--duration-drawer, 220ms) ease-out',
        }}
      />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="rp-confirm-title"
        {...(body ? { 'aria-describedby': 'rp-confirm-body' } : {})}
        tabIndex={-1}
        style={{
          position: 'relative',
          width: 'min(420px, 100%)',
          background: 'var(--bg)',
          border: '1.5px solid var(--line)',
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          boxShadow: '0 12px 40px rgba(0, 0, 0, 0.25)',
          animation: 'rp-confirm-pop-in var(--duration-drawer, 220ms) ease-out',
          outline: 'none',
        }}
      >
        <h2
          id="rp-confirm-title"
          className="display"
          style={{ fontSize: 16, letterSpacing: '0.02em' }}
        >
          {title}
        </h2>
        {body && (
          <div id="rp-confirm-body" style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.5 }}>{body}</div>
        )}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: 8,
          }}
        >
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={confirmVariant}
            onClick={() => void onConfirm()}
            disabled={busy}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
