import { useState } from 'react'

export interface SwUpdateBannerProps {
  /** From @rallypoint/web-kit's useSwUpdatePrompt(). */
  updateReady: boolean
  /** Applies the parked service-worker update (reloads the page). */
  onReload: () => void
}

// Reload-to-update banner (#675), shared across the five apps. A minimal
// dismissible bar rather than a Toaster toast — the shared <Toast> body is
// plain text with no action-button slot, and this needs a persistent
// "Reload" affordance (no auto-expiry) rather than a transient status
// message. Render it as the FIRST child inside <AppChrome> so it lands at
// the top of the scroll container: sticky there keeps it visible during
// scroll, sitting flush under the mobile top bar — never over the iOS
// home-indicator / app-switcher zone at the bottom.
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
        padding: '8px 16px',
        background: 'var(--surface-2)',
        borderBottom: '1.5px solid var(--line)',
        fontSize: 12,
      }}
    >
      <span style={{ color: 'var(--ink-dim)' }}>New version available</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          type="button"
          onClick={onReload}
          style={{
            all: 'unset',
            cursor: 'pointer',
            color: 'var(--accent, var(--ink))',
            fontWeight: 600,
          }}
        >
          Reload
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss update notice"
          style={{ all: 'unset', cursor: 'pointer', color: 'var(--ink-mute)' }}
        >
          ×
        </button>
      </span>
    </div>
  )
}
