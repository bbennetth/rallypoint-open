import { useState, type FormEvent } from 'react'
import { ApiError, deleteTaskSeries, updateTaskSeries, type RecurringSeriesDto } from '../lib/api.js'
import { buildSeriesPatch, type TermMode } from '../lib/series-patch.js'
import { PriorityPicker } from './PriorityPicker.js'

// Detail + edit form for a recurring task series, rendered inside an Ink Drawer.
// Edits the rule (freq/interval/byDay/dtstart/until/count/timeOfDay) and
// first-class fields (title/notes/priority). Calls onChanged() + onClose() after
// a successful write or delete so the host page refetches.

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
const DAY_LABEL: Record<string, string> = {
  MO: 'Mo',
  TU: 'Tu',
  WE: 'We',
  TH: 'Th',
  FR: 'Fr',
  SA: 'Sa',
  SU: 'Su',
}

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

function termMode(series: RecurringSeriesDto): TermMode {
  if (series.until) return 'until'
  if (series.count != null) return 'count'
  return 'none'
}

export function SeriesEdit({
  series,
  onChanged,
  onClose,
}: {
  series: RecurringSeriesDto
  onChanged: () => void
  onClose: () => void
}) {
  const [title, setTitle] = useState(series.title)
  const [notes, setNotes] = useState(series.notes ?? '')
  const [priority, setPriority] = useState<string | null>(series.priority)
  const [freq, setFreq] = useState<'daily' | 'weekly'>(series.freq)
  const [interval, setInterval] = useState(String(series.interval))
  const [byDay, setByDay] = useState<string[]>(series.byDay ?? [])
  const [dtstart, setDtstart] = useState(series.dtstart.slice(0, 10))
  const [timeOfDay, setTimeOfDay] = useState(series.timeOfDay ?? '')
  const [mode, setMode] = useState<TermMode>(termMode(series))
  const [untilDate, setUntilDate] = useState(series.until ?? '')
  const [countStr, setCountStr] = useState(series.count != null ? String(series.count) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleDay(day: string) {
    setByDay((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
    )
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const result = buildSeriesPatch(series, {
      title,
      notes,
      priority,
      freq,
      interval,
      byDay,
      dtstart,
      timeOfDay,
      mode,
      untilDate,
      countStr,
    })
    if (!result.ok) {
      setError(result.error)
      return
    }

    setBusy(true)
    setError(null)
    try {
      if (Object.keys(result.patch).length > 0) {
        await updateTaskSeries(series.listId, series.id, result.patch)
      }
      onChanged()
      onClose()
    } catch (err) {
      setError(errMessage(err))
      setBusy(false)
    }
  }

  async function remove() {
    if (busy) return
    if (!window.confirm(`Delete the "${series.title}" series? This cannot be undone.`)) return
    setBusy(true)
    setError(null)
    try {
      await deleteTaskSeries(series.listId, series.id)
      onChanged()
      onClose()
    } catch (err) {
      setError(errMessage(err))
      setBusy(false)
    }
  }

  return (
    <form className="pl-fab-form" onSubmit={(e) => void save(e)}>
      <label className="pl-fab-label">
        Title
        <input
          className="pl-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Series title"
          disabled={busy}
        />
      </label>

      <label className="pl-fab-label">
        Notes
        <textarea
          className="pl-input"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          aria-label="Notes"
          disabled={busy}
          style={{ resize: 'vertical' }}
        />
      </label>

      <div className="pl-fab-label">
        Priority
        <PriorityPicker value={priority} onChange={(p) => setPriority(p)} disabled={busy} />
      </div>

      <label className="pl-fab-label">
        Frequency
        <select
          className="pl-input"
          value={freq}
          onChange={(e) => setFreq(e.target.value as 'daily' | 'weekly')}
          disabled={busy}
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
      </label>

      <label className="pl-fab-label">
        Every
        <input
          className="pl-input"
          type="number"
          min={1}
          value={interval}
          onChange={(e) => setInterval(e.target.value)}
          aria-label="Interval"
          disabled={busy}
          style={{ width: 80 }}
        />
        <span style={{ fontSize: 13, color: 'var(--ink-dim)', alignSelf: 'center' }}>
          {freq === 'daily' ? 'day(s)' : 'week(s)'}
        </span>
      </label>

      {freq === 'weekly' && (
        <div className="pl-fab-label">
          On days
          <div role="group" aria-label="Days of week" style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {WEEKDAYS.map((day) => (
              <button
                key={day}
                type="button"
                disabled={busy}
                onClick={() => toggleDay(day)}
                aria-pressed={byDay.includes(day)}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 6,
                  border: '1.5px solid var(--ink-rule)',
                  background: byDay.includes(day) ? 'var(--acid)' : 'transparent',
                  color: byDay.includes(day) ? 'var(--chassis)' : 'var(--ink)',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: busy ? 'default' : 'pointer',
                }}
              >
                {DAY_LABEL[day]}
              </button>
            ))}
          </div>
        </div>
      )}

      <label className="pl-fab-label">
        Start date
        <input
          className="pl-input"
          type="date"
          value={dtstart}
          onChange={(e) => setDtstart(e.target.value)}
          aria-label="Start date"
          disabled={busy}
        />
      </label>

      <label className="pl-fab-label">
        Time of day (optional)
        <input
          className="pl-input"
          type="time"
          value={timeOfDay}
          onChange={(e) => setTimeOfDay(e.target.value)}
          aria-label="Time of day"
          disabled={busy}
        />
      </label>

      <div className="pl-fab-label">
        End
        <div role="group" aria-label="Termination" style={{ display: 'flex', gap: 8 }}>
          {(['none', 'until', 'count'] as TermMode[]).map((m) => (
            <button
              key={m}
              type="button"
              disabled={busy}
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={mode === m ? 'pl-btn' : 'pl-btn ghost'}
              style={{ flex: 1, fontSize: 12, padding: '4px 8px' }}
            >
              {m === 'none' ? 'Never' : m === 'until' ? 'On date' : 'After N'}
            </button>
          ))}
        </div>
        {mode === 'until' && (
          <input
            className="pl-input"
            type="date"
            value={untilDate}
            onChange={(e) => setUntilDate(e.target.value)}
            aria-label="End date"
            disabled={busy}
            style={{ marginTop: 6 }}
          />
        )}
        {mode === 'count' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <input
              className="pl-input"
              type="number"
              min={1}
              value={countStr}
              onChange={(e) => setCountStr(e.target.value)}
              aria-label="Occurrence count"
              disabled={busy}
              style={{ width: 80 }}
            />
            <span style={{ fontSize: 13, color: 'var(--ink-dim)' }}>times</span>
          </div>
        )}
      </div>

      {error && <p role="alert" className="pl-fab-error">{error}</p>}

      <button className="pl-btn" type="submit" disabled={busy || !title.trim()}>
        Save series
      </button>
      <button className="pl-btn ghost" type="button" onClick={() => void remove()} disabled={busy}>
        Delete series
      </button>
    </form>
  )
}
