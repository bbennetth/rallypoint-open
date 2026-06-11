import { useEffect } from 'react'
import { useToastStore, type Toast } from '../store/toast.js'
import { nextExpireDeadline } from '../lib/toast-queue.js'

// Renders the live toast queue. Mount once near the root (next to
// `<AppShell>`). The component subscribes to `useToastStore`; callers
// push via `useToast()` or `useToastStore.getState().push(…)`.

const TONE_COLOR: Record<Toast['tone'], string> = {
  info: 'var(--acid)',
  success: 'var(--map-highlight, #22c55e)',
  error: 'var(--hot)',
}

export function Toaster() {
  const queue = useToastStore((s) => s.queue)
  const expire = useToastStore((s) => s.expire)
  const dismiss = useToastStore((s) => s.dismiss)

  // Schedule the next auto-expire pass at the earliest deadline; on
  // queue mutation re-derive.
  useEffect(() => {
    if (queue.length === 0) return
    const now = Date.now()
    const next = nextExpireDeadline(queue, now)
    if (next === null) return
    const handle = window.setTimeout(() => expire(Date.now()), Math.max(0, next - now))
    return () => window.clearTimeout(handle)
  }, [queue, expire])

  if (queue.length === 0) return null

  return (
    <div
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
        right: 16,
        zIndex: 70,
        display: 'flex',
        flexDirection: 'column-reverse',
        gap: 8,
        pointerEvents: 'none',
        maxWidth: 'calc(100vw - 32px)',
      }}
    >
      {queue.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'error' ? 'alert' : 'status'}
          className="mono"
          style={{
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 12px',
            background: 'var(--bg)',
            border: `1.5px solid ${TONE_COLOR[t.tone]}`,
            color: 'var(--ink)',
            fontSize: 12,
            letterSpacing: '0.04em',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.2)',
          }}
        >
          <span style={{ flex: 1 }}>{t.body}</span>
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss notification"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--ink-dim)',
              padding: 0,
              fontSize: 14,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
