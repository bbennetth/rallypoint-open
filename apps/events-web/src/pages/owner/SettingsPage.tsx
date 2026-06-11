import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ApiError,
  deleteEvent,
  patchEvent,
  restoreEvent,
  type EventDto,
  type PrivacyMode,
} from '../../lib/api.js'
import { buildEventPatch, eventDetailsDraft } from '../../lib/event-patch.js'
import { InviteSection, TransferSection } from '../EventDetailPage.js'
import { DaysEditor } from '../../ui/DaysEditor.js'
import { StagesEditor } from '../../ui/StagesEditor.js'
import { useEventOutlet } from './_event-outlet.js'

// Owner-side Settings tab: invite link generator, ownership transfer,
// and the danger zone (delete / restore). Phase 2 keeps the existing
// section components imported from EventDetailPage rather than
// extracting them into their own files — that lifts cleanly later if
// EventDetailPage is fully retired.

export function SettingsPage() {
  const { event, reload } = useEventOutlet()
  const navigate = useNavigate()
  const [deleting, setDeleting] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const isOwner = event.viewer_role === 'owner'

  async function handleDelete() {
    if (!window.confirm(`Delete "${event.name}"? This soft-deletes the event.`)) return
    setDeleting(true)
    try {
      await deleteEvent(event.id)
      await navigate('/me/events', { replace: true })
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Failed to delete event.')
    } finally {
      setDeleting(false)
    }
  }

  async function handleRestore() {
    setRestoring(true)
    try {
      await restoreEvent(event.id)
      await reload()
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Failed to restore event.')
    } finally {
      setRestoring(false)
    }
  }

  return (
    <main className="page-pad">
      <div className="max-w-3xl mx-auto space-y-6">
        <header className="space-y-1">
          <p
            className="text-xs font-medium"
            style={{ color: 'var(--acid)' }}
          >
            Settings
          </p>
          <h1 className="display text-2xl">{event.name}</h1>
        </header>

        {isOwner && <DetailsSection event={event} onSaved={() => void reload()} />}

        {isOwner && (
          <StagesEditor eventId={event.id} />
        )}

        {isOwner && (
          <DaysEditor
            eventId={event.id}
            eventStartDate={event.start_date}
            eventEndDate={event.end_date}
          />
        )}

        {isOwner && <InviteSection eventId={event.id} />}

        {isOwner && (
          <TransferSection eventId={event.id} onTransferred={() => void reload()} />
        )}

        {isOwner && (
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-[color:var(--ink)]">Danger zone</h2>
            <div className="flex items-center gap-3">
              {event.deleted_at ? (
                <button
                  type="button"
                  disabled={restoring}
                  onClick={() => void handleRestore()}
                  className="btn-ghost"
                  style={{ width: 'auto' }}
                >
                  {restoring ? 'Restoring…' : 'Restore event'}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => void handleDelete()}
                  className="btn-hot"
                  style={{ width: 'auto' }}
                >
                  {deleting ? 'Deleting…' : 'Delete event'}
                </button>
              )}
            </div>
            {event.deleted_at && (
              <p className="text-xs text-[color:var(--ink-mute)]">
                Soft-deleted on {new Date(event.deleted_at).toLocaleString()}. Restoring
                puts it back into your active list.
              </p>
            )}
          </section>
        )}

        {!isOwner && (
          <p className="text-sm text-[color:var(--ink-dim)]">
            Only the event owner can change settings on this event.
          </p>
        )}
      </div>
    </main>
  )
}

const PRIVACY_OPTIONS: { value: PrivacyMode; label: string }[] = [
  { value: 'public', label: 'Public' },
  { value: 'unlisted', label: 'Unlisted' },
  { value: 'private', label: 'Private' },
]

// Event details editor: name, description, start/end dates, location, and
// privacy. Diffs the draft against the event via buildEventPatch so only
// changed fields are sent, then calls onSaved() to refetch the shared
// outlet event.
function DetailsSection({ event, onSaved }: { event: EventDto; onSaved: () => void }) {
  const [draft, setDraft] = useState(() => eventDetailsDraft(event))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  // Reseed the draft when the server's values actually change (after our own
  // save reloads the outlet event, or a concurrent remote edit). Keyed on the
  // primitive fields buildEventPatch reads — not the event object identity —
  // so an unrelated parent re-render can't clobber in-progress typing.
  useEffect(() => {
    setDraft(eventDetailsDraft(event))
  }, [
    event.id,
    event.name,
    event.description,
    event.start_date,
    event.end_date,
    event.location_label,
    event.privacy_mode,
  ])

  function set<K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setDone(false)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const fields = buildEventPatch(event, draft)
    if (Object.keys(fields).length === 0) {
      setDone(true)
      return
    }
    setSaving(true)
    try {
      await patchEvent(event.id, fields)
      setDone(true)
      onSaved()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save.')
    } finally {
      setSaving(false)
    }
  }

  const labelCls = 'block text-xs font-medium text-[color:var(--ink-mute)]'

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-[color:var(--ink)]">Details</h2>
      <form onSubmit={(e) => void handleSave(e)} className="space-y-3">
        <div className="space-y-1">
          <label htmlFor="settings-name" className={labelCls}>
            Name
          </label>
          <input
            id="settings-name"
            type="text"
            required
            value={draft.name}
            onChange={(e) => set('name', e.target.value)}
            className="w-full cyber-input"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="settings-description" className={labelCls}>
            Description
          </label>
          <textarea
            id="settings-description"
            rows={3}
            value={draft.description}
            onChange={(e) => set('description', e.target.value)}
            className="w-full resize-y cyber-input"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label htmlFor="settings-startDate" className={labelCls}>
              Start date
            </label>
            <input
              id="settings-startDate"
              type="date"
              value={draft.startDate}
              onChange={(e) => set('startDate', e.target.value)}
              className="w-full cyber-input"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="settings-endDate" className={labelCls}>
              End date
            </label>
            <input
              id="settings-endDate"
              type="date"
              value={draft.endDate}
              onChange={(e) => set('endDate', e.target.value)}
              className="w-full cyber-input"
            />
          </div>
        </div>

        <div className="space-y-1">
          <label htmlFor="settings-location" className={labelCls}>
            Location
          </label>
          <input
            id="settings-location"
            type="text"
            value={draft.locationLabel}
            onChange={(e) => set('locationLabel', e.target.value)}
            className="w-full cyber-input"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="settings-privacy" className={labelCls}>
            Privacy
          </label>
          <select
            id="settings-privacy"
            value={draft.privacyMode}
            onChange={(e) => set('privacyMode', e.target.value as PrivacyMode)}
            className="w-full cyber-input"
          >
            {PRIVACY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <div
            role="alert"
            className="p-3 text-sm text-[color:var(--ink)]"
            style={{ border: '1.5px solid var(--hot)', background: 'color-mix(in srgb, var(--hot) 12%, transparent)' }}
          >
            {error}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button type="submit" disabled={saving} className="btn-brutal" style={{ width: 'auto' }}>
            {saving ? 'Saving…' : 'Save details'}
          </button>
          {done && !error && (
            <span className="text-xs" style={{ color: 'var(--map-highlight)' }}>
              Saved.
            </span>
          )}
        </div>
      </form>
    </section>
  )
}
