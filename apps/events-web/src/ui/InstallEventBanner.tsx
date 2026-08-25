import { useState } from 'react'
import { useInstallPrompt } from '../lib/installPrompt.js'

// "Save this event to your home screen" affordance for the attendee
// shells. Installing here produces a per-event app (see lib/pwaHead.ts
// + events-api routes/pwa.ts) that cold-launches straight into this
// event instead of the generic Events app.
//
// Renders nothing when already installed, and nothing on platforms that
// neither fired `beforeinstallprompt` nor are iOS — a browser with no
// install path shouldn't show a dead button.

const DISMISS_KEY_PREFIX = 'rallypt-install-dismissed:'

function dismissedKey(eventId: string): string {
  return `${DISMISS_KEY_PREFIX}${eventId}`
}

function readDismissed(eventId: string): boolean {
  try {
    return localStorage.getItem(dismissedKey(eventId)) === '1'
  } catch {
    // Private-mode / blocked storage — treat as not dismissed rather
    // than hiding the feature entirely.
    return false
  }
}

function writeDismissed(eventId: string): void {
  try {
    localStorage.setItem(dismissedKey(eventId), '1')
  } catch {
    // Non-fatal: the banner reappears next session.
  }
}

export function InstallEventBanner({
  eventId,
  eventName,
}: {
  eventId: string
  eventName: string
}) {
  const { canPrompt, isStandalone, isIos, promptInstall } = useInstallPrompt()
  const [dismissed, setDismissed] = useState(() => readDismissed(eventId))
  const [showIosHelp, setShowIosHelp] = useState(false)

  const available = canPrompt || isIos
  if (isStandalone || dismissed || !available) return null

  function dismiss(): void {
    writeDismissed(eventId)
    setDismissed(true)
  }

  async function onInstall(): Promise<void> {
    if (isIos) {
      // iOS never fires beforeinstallprompt — the only path is the
      // Share sheet, which we can describe but not open.
      setShowIosHelp((v) => !v)
      return
    }
    const outcome = await promptInstall()
    // Accepting installs the app; either way don't nag again for this
    // event on this device.
    if (outcome !== 'unavailable') dismiss()
  }

  return (
    <div
      style={{
        padding: '10px 16px',
        background: 'var(--surface-2)',
        borderBottom: '1px solid var(--hairline-soft)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 12, color: 'var(--ink-dim)', flex: '1 1 0', minWidth: 0 }}>
          Save {eventName} to your home screen
        </span>
        <button
          type="button"
          className="btn-ghost"
          style={{ width: 'auto' }}
          aria-expanded={isIos ? showIosHelp : undefined}
          onClick={() => void onInstall()}
        >
          {isIos ? 'How' : 'Install'}
        </button>
        <button
          type="button"
          className="btn-ghost"
          style={{ width: 'auto' }}
          aria-label="Dismiss install prompt"
          onClick={dismiss}
        >
          Not now
        </button>
      </div>

      {showIosHelp && (
        <p style={{ fontSize: 12, color: 'var(--ink-dim)', marginTop: 8 }}>
          Tap the Share button in Safari, then <strong>Add to Home Screen</strong>. The
          app opens straight to this event. You may need to sign in once the first time
          you launch it.
        </p>
      )}
    </div>
  )
}
