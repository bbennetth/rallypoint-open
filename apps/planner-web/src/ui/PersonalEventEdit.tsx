import { useState, type FormEvent } from 'react'
import { TICKET_PLATFORMS, ticketPlatformLabel, ticketPlatformLoginUrl } from '@rallypoint/events-shared'
import {
  ApiError,
  createPersonalEvent,
  deletePersonalEvent,
  updatePersonalEvent,
  type PersonalEventDto,
  type UpdatePersonalEventInput,
} from '../lib/api.js'
import { instantToLocalInput, toInstant } from '../lib/planner-helpers.js'

// Create / edit / delete form for a personal (planner) event, rendered inside
// an Ink Drawer by the host (Events page / My Day / Upcoming sliders). With an
// `event` it pre-fills and saves via updatePersonalEvent and offers a two-step
// delete; with `event == null` it opens empty in create mode and saves via
// createPersonalEvent. Both modes cover the same fields (name + start/end +
// location + ticketPlatform/ticketAccountEmail) — one code path, no drift.
// After an edit write it calls onChanged() (host refetches); after a create it
// calls onCreated(created). Both then close via onClose().

// The minimal event shape the form needs. Both the full PersonalEventDto
// (Events page) and the My Day / Upcoming MyDayEvent satisfy it.
export interface EditablePersonalEvent {
  id: string
  name: string
  startAt: string | null
  endAt: string | null
  locationLabel: string | null
  ticketPlatform: string | null
  ticketAccountEmail: string | null
}

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

export function PersonalEventEdit({
  event = null,
  onChanged,
  onCreated,
  onClose,
}: {
  event?: EditablePersonalEvent | null
  onChanged?: () => void
  onCreated?: (created: PersonalEventDto) => void
  onClose: () => void
}) {
  const isCreate = event === null
  const [name, setName] = useState(event?.name ?? '')
  const [start, setStart] = useState(instantToLocalInput(event?.startAt ?? null))
  const [end, setEnd] = useState(instantToLocalInput(event?.endAt ?? null))
  const [location, setLocation] = useState(event?.locationLabel ?? '')
  const [platform, setPlatform] = useState(event?.ticketPlatform ?? '')
  const [email, setEmail] = useState(event?.ticketAccountEmail ?? '')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(e: FormEvent) {
    e.preventDefault()
    const nm = name.trim()
    if (!nm || busy) return
    setBusy(true)
    setError(null)
    try {
      if (event === null) {
        const startAt = toInstant(start)
        const endAt = toInstant(end)
        const loc = location.trim()
        const acctEmail = email.trim()
        const created = await createPersonalEvent({
          name: nm,
          ...(startAt ? { startAt } : {}),
          ...(endAt ? { endAt } : {}),
          ...(loc ? { locationLabel: loc } : {}),
          ...(platform ? { ticketPlatform: platform } : {}),
          ...(acctEmail ? { ticketAccountEmail: acctEmail } : {}),
        })
        onCreated?.(created)
        onClose()
        return
      }
      const patch: UpdatePersonalEventInput = {
        name: nm,
        startAt: toInstant(start) ?? null,
        endAt: toInstant(end) ?? null,
        locationLabel: location.trim() || null,
        ticketPlatform: platform || null,
        ticketAccountEmail: email.trim() || null,
      }
      await updatePersonalEvent(event.id, patch)
      onChanged?.()
      onClose()
    } catch (err) {
      setError(errMessage(err))
      setBusy(false)
    }
  }

  async function remove() {
    if (event === null || busy) return
    setBusy(true)
    setError(null)
    try {
      await deletePersonalEvent(event.id)
      onChanged?.()
      onClose()
    } catch (err) {
      setError(errMessage(err))
      setBusy(false)
    }
  }

  const loginUrl = ticketPlatformLoginUrl(platform)
  const platformLabel = ticketPlatformLabel(platform)

  return (
    <form className="pl-fab-form" onSubmit={save}>
      <label className="pl-fab-label">
        Name
        <input
          className="pl-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Event name"
        />
      </label>
      <label className="pl-fab-label">
        Starts
        <input
          className="pl-input"
          type="datetime-local"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          aria-label="Event start"
        />
      </label>
      <label className="pl-fab-label">
        Ends
        <input
          className="pl-input"
          type="datetime-local"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          aria-label="Event end"
        />
      </label>
      <label className="pl-fab-label">
        Location
        <input
          className="pl-input"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Optional"
          aria-label="Event location"
        />
      </label>
      <label className="pl-fab-label">
        Platform
        <select
          className="pl-input"
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          aria-label="Ticket platform"
        >
          <option value="">— None —</option>
          {TICKET_PLATFORMS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="pl-fab-label">
        Account email
        <input
          className="pl-input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Optional"
          aria-label="Ticket account email"
        />
      </label>
      {loginUrl && platformLabel && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            className="pl-btn ghost"
            onClick={() => window.open(loginUrl, '_blank', 'noopener,noreferrer')}
          >
            Open {platformLabel} login
          </button>
          {email.trim() && (
            <span className="pl-fab-hint" style={{ margin: 0 }}>
              {email.trim()}
            </span>
          )}
        </div>
      )}
      {error && <p role="alert" className="pl-fab-error">{error}</p>}
      <button className="pl-btn" type="submit" disabled={busy || !name.trim()}>
        {isCreate ? 'Add event' : 'Save changes'}
      </button>
      {isCreate ? (
        <button className="pl-btn ghost" type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      ) : confirmDelete ? (
        <div className="pl-fab-form" style={{ gap: 8 }}>
          <p className="pl-fab-hint">Delete this event? This can't be undone.</p>
          <button className="pl-btn hot" type="button" onClick={() => void remove()} disabled={busy}>
            Yes, delete
          </button>
          <button
            className="pl-btn ghost"
            type="button"
            onClick={() => setConfirmDelete(false)}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          className="pl-btn ghost"
          type="button"
          onClick={() => setConfirmDelete(true)}
          disabled={busy}
        >
          Delete event
        </button>
      )}
    </form>
  )
}
