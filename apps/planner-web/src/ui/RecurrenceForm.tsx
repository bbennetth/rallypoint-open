// Controlled recurrence-rule editor (frequency / interval / weekday picker /
// start / end), extracted from the Chores add form so the Chores surface and
// the global quick-add FAB share one implementation. The parent owns the
// RecurrenceState; this component only renders the controls and reports edits
// via onChange. The pure form → CreateTaskSeriesInput mapping lives in
// buildChoreSeriesInput (lib/chores-helpers), which is unit-tested.

// Weekday codes in display order, matching the Lists recurrence DayCode set.
export const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
export type DayCode = (typeof DAY_CODES)[number]

export type RecurFreq = 'daily' | 'weekly'
export type RecurBound = 'count' | 'until' | 'forever'

export interface RecurrenceState {
  freq: RecurFreq
  interval: number
  byDay: DayCode[]
  dtstart: string
  boundType: RecurBound
  count: number
  until: string
  timeOfDay: string
}

function todayISO(): string {
  return new Date().toLocaleDateString('en-CA') // YYYY-MM-DD in local time
}

// Fresh recurrence state for a new series: weekly, every 1, no days picked,
// starting today, bounded after 10 occurrences (the rolling-window default).
export function defaultRecurrenceState(): RecurrenceState {
  return {
    freq: 'weekly',
    interval: 1,
    byDay: [],
    dtstart: todayISO(),
    boundType: 'count',
    count: 10,
    until: '',
    timeOfDay: '',
  }
}

export function RecurrenceForm({
  value,
  onChange,
  disabled,
}: {
  value: RecurrenceState
  onChange: (next: RecurrenceState) => void
  disabled?: boolean
}) {
  const v = value
  const set = (patch: Partial<RecurrenceState>) => onChange({ ...v, ...patch })
  function toggleDay(day: DayCode) {
    set({ byDay: v.byDay.includes(day) ? v.byDay.filter((d) => d !== day) : [...v.byDay, day] })
  }

  return (
    <div className="pl-card" style={{ padding: 14, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="meta">Every</span>
        <input
          className="pl-input"
          type="number"
          min={1}
          aria-label="Interval"
          value={v.interval}
          disabled={disabled}
          onChange={(e) => set({ interval: Math.max(1, Number(e.target.value) || 1) })}
          style={{ width: 56, padding: '8px 10px', textAlign: 'center' }}
        />
        <div className="seg">
          <button
            type="button"
            className={v.freq === 'daily' ? 'on' : ''}
            disabled={disabled}
            onClick={() => set({ freq: 'daily' })}
          >
            Day(s)
          </button>
          <button
            type="button"
            className={v.freq === 'weekly' ? 'on' : ''}
            disabled={disabled}
            onClick={() => set({ freq: 'weekly' })}
          >
            Week(s)
          </button>
        </div>
      </div>

      {v.freq === 'weekly' && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {DAY_CODES.map((day) => {
            const on = v.byDay.includes(day)
            return (
              <button
                key={day}
                type="button"
                className="pl-chip toggle"
                aria-pressed={on}
                disabled={disabled}
                onClick={() => toggleDay(day)}
                style={{
                  cursor: disabled ? 'default' : 'pointer',
                  borderColor: on ? 'var(--acid)' : 'var(--line)',
                  color: on ? 'var(--acid)' : 'var(--ink-mute)',
                  background: on ? 'var(--accent-soft)' : 'transparent',
                }}
              >
                {day}
              </button>
            )
          })}
        </div>
      )}

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="meta">Starts</span>
        <input
          className="pl-input"
          type="date"
          aria-label="Start date"
          value={v.dtstart}
          disabled={disabled}
          onChange={(e) => set({ dtstart: e.target.value })}
          style={{ width: 'auto', padding: '8px 10px' }}
        />
        <span className="meta" style={{ marginLeft: 8 }}>
          Time
        </span>
        <input
          className="pl-input"
          type="time"
          aria-label="Time of day"
          value={v.timeOfDay}
          disabled={disabled}
          onChange={(e) => set({ timeOfDay: e.target.value })}
          style={{ width: 132, padding: '8px 10px' }}
        />
      </label>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="meta">Ends</span>
        <div className="seg">
          <button
            type="button"
            className={v.boundType === 'count' ? 'on' : ''}
            disabled={disabled}
            onClick={() => set({ boundType: 'count' })}
          >
            After N
          </button>
          <button
            type="button"
            className={v.boundType === 'until' ? 'on' : ''}
            disabled={disabled}
            onClick={() => set({ boundType: 'until' })}
          >
            On date
          </button>
          <button
            type="button"
            className={v.boundType === 'forever' ? 'on' : ''}
            disabled={disabled}
            onClick={() => set({ boundType: 'forever' })}
          >
            Open
          </button>
        </div>
        {v.boundType === 'count' && (
          <input
            className="pl-input"
            type="number"
            min={1}
            max={50}
            aria-label="Occurrence count"
            value={v.count}
            disabled={disabled}
            onChange={(e) => set({ count: Math.min(50, Math.max(1, Number(e.target.value) || 1)) })}
            style={{ width: 64, padding: '8px 10px', textAlign: 'center' }}
          />
        )}
        {v.boundType === 'until' && (
          <input
            className="pl-input"
            type="date"
            aria-label="End date"
            min={v.dtstart}
            value={v.until}
            disabled={disabled}
            onChange={(e) => set({ until: e.target.value })}
            style={{ width: 'auto', padding: '8px 10px' }}
          />
        )}
        <span className="meta" style={{ color: 'var(--ink-mute)', marginLeft: 'auto' }}>
          Max 50 · rolling window
        </span>
      </div>
    </div>
  )
}
