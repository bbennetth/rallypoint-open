import type { MyDayTask } from '../lib/api.js'
import { formatChoreTrailingLabel } from '../lib/chores-helpers.js'
import { localYmd } from '../lib/planner-helpers.js'
import type { ResolvedSeries } from '../lib/series-lookup.js'
import { Check, EyeRow, PriTag } from '../ui/bits.js'
import { openProps, stopRowOpen as stop } from '../ui/row-open.js'
import type { Selected } from './MyDayPage.js'

export interface MyDayChoresSectionProps {
  chores: MyDayTask[]
  today: string
  seriesLookup: Map<string, ResolvedSeries>
  busyId: string | null
  toggle: (task: MyDayTask) => void | Promise<void>
  onSelect: (s: Selected) => void
}

// Today's chores — always-visible section between Schedule and No date, lifted
// out of `data.tasks`/`data.undatedTasks` by the `view` builder so they don't
// double-render elsewhere. Split out of `MyDayPage`; presentational.
export function MyDayChoresSection({
  chores,
  today,
  seriesLookup,
  busyId,
  toggle,
  onSelect,
}: MyDayChoresSectionProps) {
  if (chores.length === 0) return null

  return (
    <div style={{ marginTop: 14 }}>
      <EyeRow>Chores</EyeRow>
      <div className="md-allday">
        {chores.map((c) => {
          const series = c.seriesId ? (seriesLookup.get(c.seriesId)?.series ?? null) : null
          const trailing = formatChoreTrailingLabel({
            dueYmd: c.dueDate ? localYmd(c.dueDate) : null,
            todayYmd: today,
            seriesFreq: (series?.freq as 'daily' | 'weekly' | null | undefined) ?? null,
            seriesInterval: series?.interval ?? null,
            dateLabel: (ymd) => {
              const parsed = new Date(`${ymd}T00:00:00`)
              if (Number.isNaN(parsed.getTime())) return ymd
              return parsed.toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              })
            },
          })
          return (
            <div
              key={c.id}
              className="pl-row"
              {...openProps(() => onSelect({ kind: 'task', task: c }))}
              style={{
                gridTemplateColumns: '1fr auto',
                cursor: 'pointer',
                opacity: busyId === c.id ? 0.5 : 1,
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 13,
                    color: c.completed ? 'var(--ink-mute)' : 'var(--ink)',
                    textDecoration: c.completed ? 'line-through' : 'none',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {c.title}
                </span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {trailing &&
                  (c.completed ? null : (
                    <span
                      className="pl-chip"
                      style={{ flexShrink: 0 }}
                      aria-label={`Recurs ${trailing}`}
                    >
                      {trailing}
                    </span>
                  ))}
                <PriTag p={c.priority} />
                <span onClick={stop} style={{ display: 'flex' }}>
                  <Check
                    done={c.completed}
                    onClick={() => toggle(c)}
                    label={c.completed ? `Mark ${c.title} not done` : `Mark ${c.title} done`}
                  />
                </span>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
