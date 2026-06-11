import { useState } from 'react'
import {
  ApiError,
  listSnapshots,
  restoreSnapshot,
  type SnapshotDto,
  type SnapshotKind,
} from '../lib/api.js'

function formatWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

// Version history + one-click restore for the bulk-editable Lineup and
// Sessions tabs (#191 Phase 2). Collapsed by default; lists snapshots
// newest-first and restores one non-destructively (the API captures the
// current state first, so a restore is itself undoable). `onRestored`
// lets the parent editor refetch its grid after a restore lands.
export function SnapshotHistory({
  eventId,
  kind,
  onRestored,
}: {
  eventId: string
  kind: SnapshotKind
  onRestored: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [snaps, setSnaps] = useState<SnapshotDto[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restoringId, setRestoringId] = useState<string | null>(null)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      setSnaps(await listSnapshots(eventId, kind))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load history.')
    } finally {
      setLoading(false)
    }
  }

  async function toggle() {
    const next = !open
    setOpen(next)
    if (next) await refresh()
  }

  async function handleRestore(id: string) {
    if (!window.confirm('Restore this version? The current state is saved first, so you can undo.')) {
      return
    }
    setRestoringId(id)
    setError(null)
    try {
      await restoreSnapshot(eventId, id)
      await onRestored()
      await refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to restore version.')
    } finally {
      setRestoringId(null)
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void toggle()}
        className="text-xs font-medium text-[color:var(--ink-mute)]"
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} Version history
      </button>

      {open && (
        <div className="space-y-2">
          {loading && <p className="text-xs text-[color:var(--ink-mute)]">Loading…</p>}
          {error && (
            <div
              role="alert"
              className="p-3 text-sm text-[color:var(--ink)]"
              style={{
                border: '1.5px solid var(--hot)',
                background: 'color-mix(in srgb, var(--hot) 12%, transparent)',
              }}
            >
              {error}
            </div>
          )}
          {!loading && snaps.length === 0 && (
            <p className="text-xs text-[color:var(--ink-mute)]">No saved versions yet.</p>
          )}
          {snaps.length > 0 && (
            <ul className="space-y-1">
              {snaps.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-2 text-sm px-2 py-1.5 flex-wrap"
                  style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
                >
                  <span className="flex-1 min-w-40">
                    {s.reason}
                    <span className="text-[color:var(--ink-mute)]"> · {s.item_count} items</span>
                  </span>
                  <span className="mono text-xs text-[color:var(--ink-mute)]">{formatWhen(s.created_at)}</span>
                  <button
                    type="button"
                    onClick={() => void handleRestore(s.id)}
                    disabled={restoringId !== null}
                    className="btn-brutal"
                    style={{ width: 'auto' }}
                  >
                    {restoringId === s.id ? 'Restoring…' : 'Restore'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
