import { useConnectionStore } from '@rallypoint/ui'
import { useOfflineSync, useOutboxCount } from '../lib/offline/hooks.js'

// Mounts the offline engine (connectivity listeners + flush triggers +
// user-switch purge) and renders an unobtrusive status pill when the app is
// offline or has unsynced changes. Hidden entirely when online and fully
// synced, so it never intrudes on the normal flow.
export function OfflineIndicator({ userId }: { userId: string }) {
  useOfflineSync(userId)
  const pending = useOutboxCount(userId)
  const online = useConnectionStore((s) => s.online)

  if (online && pending === 0) return null

  const changes = `${pending} ${pending === 1 ? 'change' : 'changes'}`
  const label = !online
    ? pending > 0
      ? `Offline · ${changes} pending`
      : 'Offline · showing saved data'
    : `Syncing ${changes}…`

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-1/2 z-50 -translate-x-1/2 px-3 py-1.5 text-xs"
      style={{
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
        border: '1.5px solid var(--line)',
        background: 'var(--surface)',
        color: 'var(--ink-dim)',
        borderRadius: 2,
        boxShadow: '0 2px 8px color-mix(in srgb, var(--ink) 18%, transparent)',
      }}
    >
      <span
        aria-hidden
        className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
        style={{ background: online ? 'var(--acid)' : 'var(--hot)' }}
      />
      {label}
    </div>
  )
}
