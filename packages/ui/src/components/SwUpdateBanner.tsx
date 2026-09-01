import { useState } from 'react'

export interface SwUpdateBannerProps {
  /** From @rallypoint/web-kit's useSwUpdatePrompt(). */
  updateReady: boolean
  /** Applies the parked service-worker update (reloads the page). */
  onReload: () => void
}

// Reload-to-update banner (#675), shared across the five apps. A minimal
// dismissible card rather than a Toaster toast — the shared <Toast> body is
// plain text with no action-button slot, and this needs a persistent
// "Reload" affordance (no auto-expiry) rather than a transient status
// message. Render it as the FIRST child inside <AppChrome> so it lands at
// the top of the scroll container: sticky there keeps it visible during
// scroll, sitting flush under the mobile top bar — never over the iOS
// home-indicator / app-switcher zone at the bottom.
//
// Styled per the design system's info-notice treatment (see Banner.tsx):
// accent border + accent wash, on the Soft Ink radius/shadow scale. The
// wash is mixed over --bg (not transparent like Banner's) because this
// card is sticky and content scrolls beneath it.
export function SwUpdateBanner({ updateReady, onReload }: SwUpdateBannerProps) {
  const [dismissed, setDismissed] = useState(false)

  if (!updateReady || dismissed) return null

  return (
    <div
      role="status"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 5,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        margin: '8px 12px 4px',
        padding: '8px 10px 8px 14px',
        background: 'color-mix(in srgb, var(--acid) 10%, var(--bg))',
        border: '1.5px solid var(--acid)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
        fontSize: 12,
      }}
    >
      <span style={{ color: 'var(--ink)' }}>New version available</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={onReload}
          style={{
            background: 'transparent',
            border: '1px solid color-mix(in srgb, var(--acid) 55%, transparent)',
            borderRadius: 'var(--radius-md)',
            padding: '4px 12px',
            color: 'var(--accent, var(--ink))',
            font: 'inherit',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss update notice"
          style={{
            background: 'transparent',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            padding: '2px 6px',
            color: 'var(--ink-mute)',
            font: 'inherit',
            fontSize: 14,
            lineHeight: 1,
            cursor: 'pointer',
          }}
        >
          ×
        </button>
      </span>
    </div>
  )
}
