import { DAY_KEYS } from '@rallypoint/fitness-shared'
import { DAY_LABELS } from '../lib/plan-build.js'
import type { ScheduleChoice } from '../lib/composer-template.js'

export function ScheduleChips({
  value,
  onChange,
}: {
  value: ScheduleChoice
  onChange: (next: ScheduleChoice) => void
}) {
  return (
    <section style={{ display: 'grid', gap: 6 }}>
      <span className="cmp-label">SCHEDULE</span>
      <div className="day-chips">
        <button
          type="button"
          className={`day-chip${value === 'none' ? ' on' : ''}`}
          onClick={() => onChange('none')}
        >
          Not scheduled
        </button>
        <button
          type="button"
          className={`day-chip${value === 'today' ? ' on' : ''}`}
          onClick={() => onChange('today')}
        >
          Today
        </button>
        {DAY_KEYS.map((d) => (
          <button
            key={d}
            type="button"
            className={`day-chip${value === d ? ' on' : ''}`}
            onClick={() => onChange(d)}
          >
            {DAY_LABELS[d]}
          </button>
        ))}
      </div>
    </section>
  )
}
