import type { EventDayDto, HolidayDto, MyDayEvent, MyDayTask } from '../lib/api.js'
import { localYmd } from '../lib/planner-helpers.js'
import type { ResolvedSeries } from '../lib/series-lookup.js'
import { SwipeActions } from '@rallypoint/ui'
import { Check, EventEditPencil, EyeRow, PriTag } from '../ui/bits.js'
import { Icon } from '../ui/icons.js'
import { SeriesChip } from '../ui/SeriesChip.js'
import { openProps, stopRowOpen as stop } from '../ui/row-open.js'
import type { Selected } from './MyDayPage.js'

export interface MyDayAllDaySectionProps {
  allDay: MyDayTask[]
  allDayEvents: EventDayDto[]
  allDayPersonalEvents: MyDayEvent[]
  todayHolidays: HolidayDto[]
  today: string
  choresListId: string | null
  seriesLookup: Map<string, ResolvedSeries>
  busyId: string | null
  isChoreTask: (task: MyDayTask) => boolean
  toggle: (task: MyDayTask) => void | Promise<void>
  onDeleteTask: (task: MyDayTask) => void
  onSelect: (s: Selected) => void
  onRemoveEventFromPlanner: (eventDay: EventDayDto) => void
}

// The roll-up's "All day" band: all-day tasks (swipeable to delete), all-day
// group event days, all-day/continuation personal events, and today's
// holidays. Split out of `MyDayPage` — presentational, all state lives in the
// page + its hooks.
export function MyDayAllDaySection({
  allDay,
  allDayEvents,
  allDayPersonalEvents,
  todayHolidays,
  today,
  choresListId,
  seriesLookup,
  busyId,
  isChoreTask,
  toggle,
  onDeleteTask,
  onSelect,
  onRemoveEventFromPlanner,
}: MyDayAllDaySectionProps) {
  if (
    allDay.length === 0 &&
    allDayEvents.length === 0 &&
    allDayPersonalEvents.length === 0 &&
    todayHolidays.length === 0
  ) {
    return null
  }

  return (
    <>
      <EyeRow>All day</EyeRow>
      <div className="md-allday">
        {allDay.map((a) => (
          <SwipeActions
            key={a.id}
            actions={
              isChoreTask(a)
                ? []
                : [
                    {
                      key: 'delete',
                      label: `Delete ${a.title}`,
                      icon: <>✕</>,
                      onAction: () => onDeleteTask(a),
                    },
                  ]
            }
            contentClassName="pl-row"
            contentProps={openProps(() => onSelect({ kind: 'task', task: a }))}
            contentStyle={{
              gridTemplateColumns: '1fr auto',
              cursor: 'pointer',
              opacity: busyId === a.id ? 0.5 : 1,
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
              <span
                style={{
                  fontSize: 13,
                  color: a.completed ? 'var(--ink-mute)' : 'var(--ink)',
                  textDecoration: a.completed ? 'line-through' : 'none',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {a.title}
              </span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <PriTag p={a.priority} />
              {a.seriesId && (
                <SeriesChip
                  seriesId={a.seriesId}
                  surface={a.listId === choresListId ? 'chores' : 'tasks'}
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
                  done={a.completed}
                  onClick={() => toggle(a)}
                  label={a.completed ? `Mark ${a.title} not done` : `Mark ${a.title} done`}
                />
              </span>
            </span>
          </SwipeActions>
        ))}
        {allDayEvents.map((d) => (
          <div
            key={`eventDay:${d.eventId}@${d.date}`}
            className="pl-row"
            {...openProps(() => onSelect({ kind: 'eventDay', eventDay: d }))}
            style={{
              gridTemplateColumns: '1fr auto',
              cursor: 'pointer',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
              <span
                style={{
                  fontSize: 13,
                  color: 'var(--ink)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {d.name}
              </span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="pl-chip accent" style={{ flexShrink: 0 }}>
                Event
              </span>
              {d.shared && (
                <span
                  className="pl-chip"
                  style={{
                    flexShrink: 0,
                    borderColor: 'var(--acid-dim)',
                    color: 'var(--acid)',
                  }}
                >
                  Shared
                </span>
              )}
              {d.shared ? (
                <span onClick={stop} style={{ display: 'flex' }}>
                  <button
                    type="button"
                    className="pl-donebtn"
                    onClick={() => void onRemoveEventFromPlanner(d)}
                    aria-label={`Remove ${d.name} from Planner`}
                    style={{ flexShrink: 0 }}
                  >
                    Remove
                  </button>
                </span>
              ) : d.owned ? (
                <span onClick={stop} style={{ display: 'flex' }}>
                  <EventEditPencil slug={d.slug} />
                </span>
              ) : null}
            </span>
          </div>
        ))}
        {allDayPersonalEvents.map((e) => {
          // Continuation = a multi-day event that started before today
          // (its day-1 time is moot today); else a genuine all-day event.
          const ongoing = e.startAt != null && localYmd(e.startAt) < today
          return (
            <div
              key={`event:${e.id}`}
              className="pl-row"
              {...openProps(() => onSelect({ kind: 'event', event: e }))}
              style={{
                gridTemplateColumns: '1fr auto',
                cursor: 'pointer',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 13,
                    color: 'var(--ink)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {e.name}
                </span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="pl-chip accent" style={{ flexShrink: 0 }}>
                  Event
                </span>
                <span className="pl-chip" style={{ flexShrink: 0 }}>
                  {ongoing ? 'Ongoing' : 'All day'}
                </span>
                {e.ticketCount > 0 && (
                  <span className="pl-chip accent" style={{ flexShrink: 0 }}>
                    <Icon name="events" size={11} />
                    Ticket
                  </span>
                )}
              </span>
            </div>
          )
        })}
        {todayHolidays.map((h) => (
          <div
            key={`holiday:${h.id}`}
            className="pl-row"
            {...openProps(() => onSelect({ kind: 'holiday', holiday: h }))}
            style={{
              gridTemplateColumns: '1fr auto',
              cursor: 'pointer',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
              <span
                style={{
                  fontSize: 13,
                  color: 'var(--ink)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {h.name}
              </span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="pl-chip" style={{ flexShrink: 0 }}>
                Holiday
              </span>
            </span>
          </div>
        ))}
      </div>
    </>
  )
}
