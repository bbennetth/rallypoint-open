import type { ConnectionView } from '../lib/connection-status.js'
import { BRAND } from '../brand.js'

// Minimalist wordmark lockup. Renders the "rallypoint" name in Inter 600
// with an optional status dot. The compass glyph (ported from
// festival-planner) has been removed — see issue #192 Slice 4.
//
// The dot is static (no blink animation). Callers that own a realtime
// stream opt in to live status by passing
// `connectionView={useConnectionView()}` so the dot tracks SSE health.
// On surfaces without a stream the dot renders quiet at `var(--ink-dim)`.

export interface BrandLockupProps {
  /**
   * Controls the wordmark font-size in px. The dot scales proportionally.
   * Default 16 matches the mobile header baseline.
   */
  size?: number
  /**
   * Live connection state from `useConnectionView()` in
   * `@rallypoint/ui`. When provided, the dot reflects realtime
   * SSE health. When omitted, the dot stays at `var(--ink-dim)`.
   */
  connectionView?: ConnectionView | null
  /**
   * @deprecated No-op. Retained for call-site compatibility only —
   * the compass icon has been removed. Will be deleted in a follow-up.
   */
  accentColor?: string
  /**
   * @deprecated No-op. Retained for call-site compatibility only —
   * there is no longer a "compass only" mode without the wordmark.
   * Will be deleted in a follow-up.
   */
  compassOnly?: boolean
}

export function BrandLockup({
  size = 16,
  connectionView,
  // accentColor and compassOnly retained in signature for call-site compat
  accentColor: _accentColor,
  compassOnly: _compassOnly,
}: BrandLockupProps) {
  // Dot color: offline phase uses --hot; everything else is quiet ink-dim.
  const dotColor =
    connectionView?.phase === 'offline' ? 'var(--hot)' : 'var(--ink-dim)'

  const dotSize = 6

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: dotSize + 2,
        lineHeight: 1,
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-body, Inter, system-ui, sans-serif)',
          fontSize: size,
          fontWeight: 600,
          letterSpacing: '-0.02em',
          color: 'var(--ink)',
          userSelect: 'none',
        }}
      >
        {BRAND.displayName}
      </span>
      <span
        aria-hidden
        data-status-indicator="connection"
        style={{
          display: 'inline-block',
          width: dotSize,
          height: dotSize,
          borderRadius: '50%',
          backgroundColor: dotColor,
          flexShrink: 0,
        }}
      />
    </span>
  )
}
