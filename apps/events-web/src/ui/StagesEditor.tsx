import { useEffect, useState } from 'react'
import { ConfirmDialog, SwipeActions } from '@rallypoint/ui'
import { useAsync } from '@rallypoint/web-kit'
import { ApiError, createStage, deleteStage, listStages, type StageDto } from '../lib/api.js'

// Stage list + add/delete for an event. Lives on the owner Settings tab
// (#191): stages are event-level config, edited here, then referenced by
// the Lineup grid's Stage column.
export function StagesEditor({ eventId }: { eventId: string }) {
  const [stages, setStages] = useState<StageDto[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Swipe/hover Delete stages the row here; the ConfirmDialog commits it.
  const [confirmDelete, setConfirmDelete] = useState<StageDto | null>(null)
  const [deleting, setDeleting] = useState(false)

  const stagesLoad = useAsync<StageDto[]>(() => listStages(eventId), [eventId])
  useEffect(() => {
    if (stagesLoad.data) setStages(stagesLoad.data)
  }, [stagesLoad.data])
  useEffect(() => {
    if (stagesLoad.error) {
      setError(stagesLoad.error instanceof ApiError ? stagesLoad.error.message : 'Failed to load stages.')
    }
  }, [stagesLoad.error])

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
        <ul className="space-y-2">
          {stages.map((s) => (
            <SwipeActions
              key={s.id}
              as="li"
              contentClassName="ev-editrow text-sm"
              actions={[
                {
                  key: 'delete',
                  label: `Delete stage ${s.name}`,
                  icon: <>✕</>,
                  onAction: () => setConfirmDelete(s),
                },
              ]}
            >
              <span className="flex-1">{s.name}</span>
            </SwipeActions>
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
          className="p-3 text-sm"
          style={{ background: 'var(--hot-soft)', color: 'var(--hot-text)', borderRadius: 'var(--radius-lg)' }}
        >
          {error}
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete stage?"
        body={confirmDelete ? `Remove “${confirmDelete.name}” from this event.` : undefined}
        confirmLabel="Delete"
        confirmVariant="hot"
        busy={deleting}
        onConfirm={async () => {
          if (!confirmDelete) return
          setDeleting(true)
          try {
            await handleDelete(confirmDelete.id)
          } finally {
            setDeleting(false)
            setConfirmDelete(null)
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </section>
  )
}
