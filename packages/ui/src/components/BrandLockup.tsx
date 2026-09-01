import type { ConnectionView } from '../lib/connection-status.js'
import { BRAND } from '../brand.js'
import { Compass } from './icons.js'

// Brand lockup: the compass mark followed by the two-tone "rallypt"
// wordmark (`.pl-wordmark`, shared with `AppBrandLockup`), with an
// optional status dot. The compass was dropped in
// issue #192 Slice 4, leaving a text-only wordmark; it is back by user
// directive — the app chrome reads as unbranded without it.
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
   * @deprecated No-op. The compass takes its accent from `var(--acid)`
   * like every other surface. Retained for call-site compatibility.
   */
  accentColor?: string
  /**
   * Renders the compass mark on its own, without the wordmark or the
   * status dot. For tight surfaces (narrow mobile chrome, icon slots).
   */
  compassOnly?: boolean
}

export function BrandLockup({
  size = 16,
  connectionView,
  // accentColor retained in the signature for call-site compat
  accentColor: _accentColor,
  compassOnly = false,
}: BrandLockupProps) {
  // Dot color: offline phase uses --hot; everything else is quiet ink-dim.
  const dotColor =
    connectionView?.phase === 'offline' ? 'var(--hot)' : 'var(--ink-dim)'

  const dotSize = 6
  // The mark reads a touch larger than the cap height it sits beside.
  const markSize = Math.round(size * 1.25)

  const mark = (
    <span style={{ color: 'var(--ink)', display: 'flex', flexShrink: 0 }}>
      <Compass size={markSize} />
    </span>
  )

  if (compassOnly) return mark

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: dotSize + 2,
        lineHeight: 1,
      }}
    >
      {mark}
      {/*
        Two-tone "rallypt" wordmark — the same `.pl-wordmark` styling
        (and the same `BRAND.wordmark` split) that `AppBrandLockup`
        renders in every other app's chrome, so the Events attendee
        header no longer reads "rallypoint" while Planner/Health/Lists
        read "rallypt" (issue #894). Font size stays caller-controlled.
      */}
      <span className="pl-wordmark" style={{ fontSize: size, userSelect: 'none' }}>
        {BRAND.wordmark.primary}
        <b>{BRAND.wordmark.accent}</b>
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
