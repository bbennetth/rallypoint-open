import type { ReactNode } from 'react'

// Standardised "nothing here yet" surface. Replaces the scattered
// `<p className="text-sm text-white/60">…</p>` pattern with a
// consistent layout that fits inside a table cell, a card body, or
// a tab. The optional `action` slot accepts a `<Button>` (or any
// other element) so callers can offer the obvious next step.
//
//   <EmptyState
//     icon={<MyIcon />}
//     title="No attendees yet"
//     body="Share the invite link to start filling out the list."
//     action={<Button onClick={onShare}>Copy link</Button>}
//   />

export interface EmptyStateProps {
  /** Optional 24-32px icon node rendered above the title. */
  icon?: ReactNode
  /** Required short heading. */
  title: string
  /** Optional supporting copy underneath the title. */
  body?: ReactNode
  /** Optional CTA element. */
  action?: ReactNode
  /**
   * Compact variant for use inside small containers (e.g. a
   * `<Drawer>` panel). Tightens vertical padding and font sizes.
   */
  compact?: boolean
}

export function EmptyState({
  icon,
  title,
  body,
  action,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: compact ? 6 : 12,
        padding: compact ? '16px 12px' : '32px 16px',
        textAlign: 'center',
      }}
    >
      {icon && (
        <div
          aria-hidden
          style={{
            color: 'var(--ink-mute)',
            fontSize: compact ? 24 : 32,
            lineHeight: 1,
          }}
        >
          {icon}
        </div>
      )}
      <div
        className="display"
        style={{
          fontSize: compact ? 14 : 18,
          color: 'var(--ink)',
          letterSpacing: '0.02em',
        }}
      >
        {title}
      </div>
      {body && (
        <div
          style={{
            fontSize: compact ? 12 : 13,
            color: 'var(--ink-dim)',
            maxWidth: 420,
            lineHeight: 1.45,
          }}
        >
          {body}
        </div>
      )}
      {action && <div style={{ marginTop: compact ? 4 : 8 }}>{action}</div>}
    </div>
  )
}
