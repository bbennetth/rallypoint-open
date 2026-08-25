import type { EventDayDto, MyDayTask } from '../lib/api.js'
import { fmtTime, type ScheduleEntry } from '../lib/planner-helpers.js'
import type { ResolvedSeries } from '../lib/series-lookup.js'
import { Check, EventEditPencil, EyeRow, PriTag } from '../ui/bits.js'
import { Icon } from '../ui/icons.js'
import { SeriesChip } from '../ui/SeriesChip.js'
import { openProps, stopRowOpen as stop } from '../ui/row-open.js'
import type { Selected } from './MyDayPage.js'

export interface MyDayTimelineProps {
  timeline: ScheduleEntry[]
  choresListId: string | null
  seriesLookup: Map<string, ResolvedSeries>
  busyId: string | null
  toggle: (task: MyDayTask) => void | Promise<void>
  onSelect: (s: Selected) => void
  onRemoveEventFromPlanner: (eventDay: EventDayDto) => void
}

// The roll-up's timed "Schedule" grid — tasks, personal events, and group
// event days sorted by instant. Split out of `MyDayPage`; presentational,
// all state lives in the page + its hooks.
export function MyDayTimeline({
  timeline,
  choresListId,
  seriesLookup,
  busyId,
  toggle,
  onSelect,
  onRemoveEventFromPlanner,
}: MyDayTimelineProps) {
  return (
    <>
      <EyeRow>Schedule</EyeRow>
      {timeline.length === 0 ? (
        <p className="meta" style={{ color: 'var(--ink-mute)' }}>
          Nothing scheduled today.
        </p>
      ) : (
        <div className="pl-timeline">
          {timeline.map((e, i) => (
            <div key={e.id} style={{ display: 'contents' }}>
              <div className="pl-tl-time">{fmtTime(e.at)}</div>
              <div
                className="pl-tl-rail"
                style={{ paddingBottom: i === timeline.length - 1 ? 0 : 2 }}
              >
                <span className="pl-tl-tick" />
                <div
                  className={
                    'pl-ev' +
                    (e.kind === 'task' ? ' task' : '') +
                    (e.task?.completed ? ' done' : '')
                  }
                  {...openProps(() => {
                    if (e.kind === 'task' && e.task) onSelect({ kind: 'task', task: e.task })
                    else if (e.kind === 'event' && e.event)
                      onSelect({ kind: 'event', event: e.event })
                    else if (e.kind === 'eventDay' && e.eventDay)
                      onSelect({ kind: 'eventDay', eventDay: e.eventDay })
                  })}
                  style={{
                    cursor: 'pointer',
                    opacity: e.kind === 'task' && e.task && busyId === e.task.id ? 0.5 : 1,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <span
                      className="t"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        color: e.task?.completed ? 'var(--ink-mute)' : 'var(--ink)',
                        textDecoration: e.task?.completed ? 'line-through' : 'none',
                      }}
                    >
                      {e.title}
                    </span>
                    {e.kind === 'eventDay' && e.eventDay?.shared && (
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
                    {e.kind === 'task' && e.task ? (
                      <>
                        <PriTag p={e.task.priority} />
                        {e.task.seriesId && (
                          <SeriesChip
                            seriesId={e.task.seriesId}
                            surface={e.task.listId === choresListId ? 'chores' : 'tasks'}
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
                            done={e.task.completed}
                            onClick={() => toggle(e.task!)}
                            label={
                              e.task.completed ? `Mark ${e.title} not done` : `Mark ${e.title} done`
                            }
                          />
                        </span>
                      </>
                    ) : e.kind === 'eventDay' && e.eventDay ? (
                      e.eventDay.shared ? (
                        <span onClick={stop} style={{ display: 'flex' }}>
                          <button
                            type="button"
                            className="pl-donebtn"
                            onClick={() => void onRemoveEventFromPlanner(e.eventDay!)}
                            aria-label={`Remove ${e.eventDay.name} from Planner`}
                            style={{ flexShrink: 0 }}
                          >
                            Remove
                          </button>
                        </span>
                      ) : e.eventDay.owned ? (
                        <span onClick={stop} style={{ display: 'flex' }}>
                          <EventEditPencil slug={e.eventDay.slug} />
                        </span>
                      ) : null
                    ) : (
                      e.event &&
                      e.event.ticketCount > 0 && (
                        <span className="pl-chip accent">
                          <Icon name="events" size={11} />
                          Ticket
                        </span>
                      )
                    )}
                  </div>
                  {e.event?.locationLabel && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 5,
                        marginTop: 5,
                        color: 'var(--ink-dim)',
                      }}
                    >
                      <Icon name="pin" size={11} />
                      <span className="meta">{e.event.locationLabel}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
