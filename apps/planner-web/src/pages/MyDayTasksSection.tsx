import type { MyDayTask } from '../lib/api.js'
import type { ResolvedSeries } from '../lib/series-lookup.js'
import { SwipeActions } from '@rallypoint/ui'
import { Check, EyeRow, PriTag } from '../ui/bits.js'
import { SeriesChip } from '../ui/SeriesChip.js'
import { openProps, stopRowOpen as stop } from '../ui/row-open.js'
import type { Selected } from './MyDayPage.js'

export interface MyDayTasksSectionProps {
  undatedTasks: MyDayTask[]
  choresListId: string | null
  seriesLookup: Map<string, ResolvedSeries>
  busyId: string | null
  isChoreTask: (task: MyDayTask) => boolean
  toggle: (task: MyDayTask) => void | Promise<void>
  onDeleteTask: (task: MyDayTask) => void
  onSelect: (s: Selected) => void
}

// The roll-up's "No date" band — undated tasks, swipeable to delete. Split
// out of `MyDayPage`; presentational.
export function MyDayTasksSection({
  undatedTasks,
  choresListId,
  seriesLookup,
  busyId,
  isChoreTask,
  toggle,
  onDeleteTask,
  onSelect,
}: MyDayTasksSectionProps) {
  if (undatedTasks.length === 0) return null

  return (
    <>
      <EyeRow>No date</EyeRow>
      <div className="md-allday">
        {undatedTasks.map((u) => (
          <SwipeActions
            key={u.id}
            actions={
              isChoreTask(u)
                ? []
                : [
                    {
                      key: 'delete',
                      label: `Delete ${u.title}`,
                      icon: <>✕</>,
                      onAction: () => onDeleteTask(u),
                    },
                  ]
            }
            contentClassName="pl-row"
            contentProps={openProps(() => onSelect({ kind: 'task', task: u }))}
            contentStyle={{
              gridTemplateColumns: '1fr auto',
              cursor: 'pointer',
              opacity: busyId === u.id ? 0.5 : 1,
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
              <span
                style={{
                  fontSize: 13,
                  color: u.completed ? 'var(--ink-mute)' : 'var(--ink)',
                  textDecoration: u.completed ? 'line-through' : 'none',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {u.title}
              </span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <PriTag p={u.priority} />
              {u.seriesId && (
                <SeriesChip
                  seriesId={u.seriesId}
                  surface={u.listId === choresListId ? 'chores' : 'tasks'}
                  lookup={seriesLookup}
                  onEdit={(r) =>
                    onSelect({
                      kind: 'series',
                      series: r.series,
                      surface: r.surface,
                    })
                  }
                />
              )}
              <span onClick={stop} style={{ display: 'flex' }}>
                <Check
                  done={u.completed}
                  onClick={() => toggle(u)}
                  label={u.completed ? `Mark ${u.title} not done` : `Mark ${u.title} done`}
                />
              </span>
            </span>
          </SwipeActions>
        ))}
      </div>
    </>
  )
}
