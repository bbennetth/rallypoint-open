import { useEffect, useState } from 'react'
import { ApiError, createStage, deleteStage, listStages, type StageDto } from '../lib/api.js'

// Stage list + add/delete for an event. Lives on the owner Settings tab
// (#191): stages are event-level config, edited here, then referenced by
// the Lineup grid's Stage column.
export function StagesEditor({ eventId }: { eventId: string }) {
  const [stages, setStages] = useState<StageDto[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    listStages(eventId)
      .then((s) => {
        if (!cancelled) setStages(s)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load stages.')
      })
    return () => {
      cancelled = true
    }
  }, [eventId])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSaving(true)
    try {
      const stage = await createStage(eventId, { name: name.trim() })
      setStages((prev) => [...prev, stage])
      setName('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add stage.')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(stageId: string) {
    setError(null)
    try {
      await deleteStage(eventId, stageId)
      setStages((prev) => prev.filter((s) => s.id !== stageId))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete stage.')
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-[color:var(--ink)]">Stages</h2>
      {stages.length > 0 && (
        <ul className="space-y-1">
          {stages.map((s) => (
            <li key={s.id} className="flex items-center gap-2 text-sm">
              <span className="flex-1">{s.name}</span>
              <button
                type="button"
                onClick={() => void handleDelete(s.id)}
                className="ml-auto btn-hot"
                style={{ width: 'auto' }}
                aria-label={`Delete stage ${s.name}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {stages.length === 0 && <p className="text-xs text-[color:var(--ink-mute)]">No stages yet.</p>}
      <form onSubmit={(e) => void handleAdd(e)} className="flex gap-2">
        <input
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Stage name"
          className="cyber-input flex-1 min-w-0"
        />
        <button type="submit" disabled={saving} className="btn-brutal" style={{ width: 'auto' }}>
          {saving ? 'Adding…' : 'Add stage'}
        </button>
      </form>
      {error && (
        <div
          role="alert"
          className="p-3 text-sm text-[color:var(--ink)]"
          style={{ border: '1.5px solid var(--hot)', background: 'color-mix(in srgb, var(--hot) 12%, transparent)' }}
        >
          {error}
        </div>
      )}
    </section>
  )
}
