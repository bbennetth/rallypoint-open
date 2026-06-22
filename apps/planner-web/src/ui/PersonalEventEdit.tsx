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
import {
  instantToLocalInput,
  toInstant,
  instantToDateInput,
  dateInputToInstant,
} from '../lib/planner-helpers.js'

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
  /** Issue #545: true = all-day event; false/undefined = timed. */
  allDay?: boolean
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
  const [isAllDay, setIsAllDay] = useState(event?.allDay ?? false)
  const [start, setStart] = useState(
    (event?.allDay ?? false) ? instantToDateInput(event?.startAt ?? null) : instantToLocalInput(event?.startAt ?? null)
  )
  const [end, setEnd] = useState(
    (event?.allDay ?? false) ? instantToDateInput(event?.endAt ?? null) : instantToLocalInput(event?.endAt ?? null)
  )
  const [location, setLocation] = useState(event?.locationLabel ?? '')
  const [platform, setPlatform] = useState(event?.ticketPlatform ?? '')
  const [email, setEmail] = useState(event?.ticketAccountEmail ?? '')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleAllDayChange(checked: boolean) {
    setIsAllDay(checked)
    // Convert the current start/end values between datetime-local and date formats
    if (checked) {
      // switching to all-day: strip the time portion
      if (start) {
        const instant = toInstant(start)
        setStart(instant ? instantToDateInput(instant) : '')
      }
      if (end) {
        const instant = toInstant(end)
        setEnd(instant ? instantToDateInput(instant) : '')
      }
    } else {
      // switching to timed: reparse as local midnight instant then back to datetime-local
      if (start) {
        const instant = dateInputToInstant(start)
        setStart(instant ? instantToLocalInput(instant) : '')
      }
      if (end) {
        const instant = dateInputToInstant(end)
        setEnd(instant ? instantToLocalInput(instant) : '')
      }
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    const nm = name.trim()
    if (!nm || busy) return
    setBusy(true)
    setError(null)
    try {
      if (event === null) {
        const startAt = isAllDay ? (dateInputToInstant(start) ?? undefined) : (toInstant(start) ?? undefined)
        const endAt = isAllDay ? (dateInputToInstant(end) ?? undefined) : (toInstant(end) ?? undefined)
        const loc = location.trim()
        const acctEmail = email.trim()
        const created = await createPersonalEvent({
          name: nm,
          allDay: isAllDay,
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
        allDay: isAllDay,
        startAt: isAllDay ? (dateInputToInstant(start) ?? null) : (toInstant(start) ?? null),
        endAt: isAllDay ? (dateInputToInstant(end) ?? null) : (toInstant(end) ?? null),
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
      <label className="pl-fab-label" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={isAllDay}
          onChange={(e) => handleAllDayChange(e.target.checked)}
          aria-label="All day event"
        />
        All day
      </label>
      <label className="pl-fab-label">
        Starts
        <input
          className="pl-input"
          type={isAllDay ? 'date' : 'datetime-local'}
          value={start}
          onChange={(e) => setStart(e.target.value)}
          aria-label="Event start"
        />
      </label>
      <label className="pl-fab-label">
        Ends
        <input
          className="pl-input"
          type={isAllDay ? 'date' : 'datetime-local'}
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
          <p className="pl-fab-hint">Delete this event? This can&apos;t be undone.</p>
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
