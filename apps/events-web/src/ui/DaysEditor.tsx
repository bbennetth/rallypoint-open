import { useEffect, useState } from 'react'
import { dayTimesIssue } from '@rallypoint/events-shared'
import {
  ApiError,
  createDay,
  deleteDay,
  generateDays,
  listDays,
  updateDay,
  type DayDto,
} from '../lib/api.js'

// Shared message for the "date + optional times" pair rule, surfaced
// client-side so the user sees the error inline before the round trip.
function timesIssueMessage(start: string, end: string): string | null {
  const issue = dayTimesIssue(start || null, end || null)
  if (issue === 'both_required') {
    return 'Set both start and end time, or leave both blank for an all-day date.'
  }
  if (issue === 'end_before_start') return 'End time must not be before start time.'
  return null
}

// Day list + add/delete + generate-from-event-dates for an event. Lives on
// the owner Settings tab (#191): days are event-level config, edited here,
// then referenced by the Lineup grid and Sessions.
//
// Each day carries an optional start/end time ("date + optional times"):
// leave both blank for an all-day date, or set both for a timed window
// (end must not precede start). Planner reads these to place the day on a
// timeline; blank = an all-day item.
export function DaysEditor({
  eventId,
  eventStartDate = null,
  eventEndDate = null,
}: {
  eventId: string
  eventStartDate?: string | null
  eventEndDate?: string | null
}) {
  const [days, setDays] = useState<DayDto[]>([])
  const [label, setLabel] = useState('')
  const [date, setDate] = useState('')
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [genSaving, setGenSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    listDays(eventId)
      .then((d) => {
        if (!cancelled) setDays(d)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load days.')
      })
    return () => {
      cancelled = true
    }
  }, [eventId])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const timesError = timesIssueMessage(startTime, endTime)
    if (timesError) {
      setError(timesError)
      return
    }
    setSaving(true)
    try {
      const day = await createDay(eventId, {
        dayLabel: label.trim(),
        date,
        startTime: startTime || null,
        endTime: endTime || null,
      })
      setDays((prev) => [...prev, day])
      setLabel('')
      setDate('')
      setStartTime('')
      setEndTime('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add day.')
    } finally {
      setSaving(false)
    }
  }

  async function handleGenerate() {
    setError(null)
    setGenSaving(true)
    try {
      const created = await generateDays(eventId)
      if (created.length === 0) {
        setError('No new days to add — the event date range is already covered.')
      } else {
        setDays((prev) => [...prev, ...created])
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to generate days.')
    } finally {
      setGenSaving(false)
    }
  }

  async function handleDelete(dayId: string) {
    setError(null)
    try {
      await deleteDay(eventId, dayId)
      setDays((prev) => prev.filter((d) => d.id !== dayId))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete day.')
    }
  }

  async function handleSaveTimes(dayId: string, start: string, end: string) {
    setError(null)
    try {
      const updated = await updateDay(eventId, dayId, {
        startTime: start || null,
        endTime: end || null,
      })
      setDays((prev) => prev.map((d) => (d.id === dayId ? updated : d)))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update times.')
    }
  }

  const canGenerate = Boolean(eventStartDate || eventEndDate)

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium text-[color:var(--ink)] flex-1">Days</h2>
        <button
          type="button"
          onClick={() => void handleGenerate()}
          disabled={!canGenerate || genSaving}
          className="btn-brutal"
          style={{ width: 'auto' }}
          title={
            canGenerate
              ? 'Create a Day row for each date in the event range'
              : 'Set the event start/end dates first'
          }
        >
          {genSaving ? 'Generating…' : 'Generate from event dates'}
        </button>
      </div>
      {days.length > 0 && (
        <ul className="space-y-1">
          {days.map((d) => (
            <DayRow key={d.id} day={d} onSaveTimes={handleSaveTimes} onDelete={handleDelete} />
          ))}
        </ul>
      )}
      {days.length === 0 && <p className="text-xs text-[color:var(--ink-mute)]">No days yet.</p>}
      <form onSubmit={(e) => void handleAdd(e)} className="flex flex-wrap gap-2">
        <input
          type="text"
          required
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. Friday)"
          className="cyber-input flex-1 min-w-0"
        />
        <input
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="cyber-input"
          style={{ flex: '0 0 11rem' }}
        />
        <input
          type="time"
          value={startTime}
          onChange={(e) => setStartTime(e.target.value)}
          aria-label="Start time (optional)"
          className="cyber-input"
          style={{ flex: '0 0 7rem' }}
        />
        <input
          type="time"
          value={endTime}
          onChange={(e) => setEndTime(e.target.value)}
          aria-label="End time (optional)"
          className="cyber-input"
          style={{ flex: '0 0 7rem' }}
        />
        <button type="submit" disabled={saving} className="btn-brutal" style={{ width: 'auto' }}>
          {saving ? 'Adding…' : 'Add day'}
        </button>
      </form>
      <p className="text-xs text-[color:var(--ink-mute)]">
        Leave both times blank for an all-day date.
      </p>
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

function DayRow({
  day,
  onSaveTimes,
  onDelete,
}: {
  day: DayDto
  onSaveTimes: (dayId: string, start: string, end: string) => Promise<void>
  onDelete: (dayId: string) => Promise<void>
}) {
  const [start, setStart] = useState(day.start_time ?? '')
  const [end, setEnd] = useState(day.end_time ?? '')
  const [saving, setSaving] = useState(false)

  const dirty = start !== (day.start_time ?? '') || end !== (day.end_time ?? '')
  const invalid = timesIssueMessage(start, end) !== null

  async function handleSave() {
    setSaving(true)
    try {
      await onSaveTimes(day.id, start, end)
    } finally {
      setSaving(false)
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      <span className="flex-1 min-w-0">
        {day.day_label} <span className="text-xs text-[color:var(--ink-dim)]">{day.date}</span>
      </span>
      <input
        type="time"
        value={start}
        onChange={(e) => setStart(e.target.value)}
        aria-label={`Start time for ${day.day_label}`}
        className="cyber-input"
        style={{ flex: '0 0 7rem' }}
      />
      <input
        type="time"
        value={end}
        onChange={(e) => setEnd(e.target.value)}
        aria-label={`End time for ${day.day_label}`}
        className="cyber-input"
        style={{ flex: '0 0 7rem' }}
      />
      <button
        type="button"
        onClick={() => void handleSave()}
        disabled={!dirty || invalid || saving}
        className="btn-brutal"
        style={{ width: 'auto' }}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button
        type="button"
        onClick={() => void onDelete(day.id)}
        className="btn-hot"
        style={{ width: 'auto' }}
        aria-label={`Delete day ${day.day_label}`}
      >
        ×
      </button>
    </li>
  )
}
