import type { DayDto } from '../lib/api.js'
import { labelForDay, todayIso } from '../lib/attendee-day.js'

// Day rail for the attendee Now tab (both shells). Events with published
// days get a tab rail; events without them fall back to a free date input
// so the day view still works.
export function DayPicker({
  days,
  value,
  onChange,
  fallbackToday,
}: {
  days: DayDto[]
  value: string
  onChange: (date: string) => void
  fallbackToday?: string
}) {
  const today = fallbackToday ?? todayIso()

  if (days.length === 0) {
    return (
      <label className="flex items-center gap-2 text-sm text-[color:var(--ink)]">
        <span className="text-xs font-medium text-[color:var(--ink-mute)]">Date</span>
        <input
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="cyber-input"
          style={{ width: 'auto' }}
        />
      </label>
    )
  }

  const sorted = [...days].sort((a, b) => a.sort_order - b.sort_order)
  return (
    <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Pick a day">
      {sorted.map((d) => {
        const active = d.date === value
        const isToday = d.date === today
        return (
          <button
            key={d.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(d.date)}
            style={{
              all: 'unset',
              cursor: active ? 'default' : 'pointer',
              padding: '6px 12px',
              background: active ? 'var(--ink)' : 'var(--surface-2)',
              color: active ? 'var(--bg)' : 'var(--ink-dim)',
              fontSize: 12,
              fontWeight: active ? 500 : 400,
              whiteSpace: 'nowrap',
              borderRadius: 'var(--radius-round)',
            }}
          >
            {labelForDay(d.date)}
            {isToday && <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.6 }}>Today</span>}
          </button>
        )
      })}
    </div>
  )
}
