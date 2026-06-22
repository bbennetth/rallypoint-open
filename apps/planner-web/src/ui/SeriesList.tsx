import { describeRecurrence } from '../lib/recurrence-label.js'
import type { TaskSeriesDto } from '../lib/api.js'
import { Icon } from './icons.js'
import { openProps } from './row-open.js'

// A flat, clickable list of recurring series — the "Manage series" surface for
// the Tasks and Chores tabs. Each row shows the series title + a human rule
// description (describeRecurrence) and opens the SeriesEdit drawer on click.
// The host owns the drawer + which `surface` to pass to SeriesEdit.

export function SeriesList({
  series,
  onEdit,
  emptyLabel = 'No recurring series yet.',
}: {
  series: readonly TaskSeriesDto[]
  onEdit: (series: TaskSeriesDto) => void
  emptyLabel?: string
}) {
  if (series.length === 0) {
    return (
      <p className="meta" style={{ color: 'var(--ink-mute)' }}>
        {emptyLabel}
      </p>
    )
  }
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 7 }}>
      {series.map((sr) => (
        <li
          key={sr.id}
          className="pl-row"
          {...openProps(() => onEdit(sr))}
          style={{ gridTemplateColumns: '1fr auto', alignItems: 'center', cursor: 'pointer' }}
        >
          <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <span style={{ fontSize: 13.5, color: 'var(--ink)' }}>{sr.title}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
              <span
                className="pl-chip repeat"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <Icon name="repeat" size={10} />
                {describeRecurrence(sr)}
              </span>
            </span>
          </span>
          <Icon name="sliders" size={13} />
        </li>
      ))}
    </ul>
  )
}
