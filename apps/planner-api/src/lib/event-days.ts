import type { UserEventDto } from '@rallypoint/events-client'

// Per-day expansion of the group (festival) events the actor owns /
// collaborates on / attends. One UserEventDto carries many days; Planner's
// upcoming/my-day render one row per day, so this flattens an event into one
// EventDayItem per day, carrying the date + its optional window and the
// server-stamped `owned` flag (gates the "edit in RP Events" pencil) through
// unchanged. Pure so the compose helpers stay deterministic.

export interface EventDayItem {
  eventId: string
  slug: string
  name: string
  scopeType: string
  date: string
  dayLabel: string
  // The day's own optional window ('HH:MM' or null; both null = all-day).
  startTime: string | null
  endTime: string | null
  owned: boolean
  /** True when the event is a planner-flagged group event not otherwise reachable. */
  shared?: boolean
}

export function expandEventDays(
  events: UserEventDto[],
  sharedEventIds?: ReadonlySet<string>,
): EventDayItem[] {
  return events.flatMap((e) =>
    e.days.map(
      (d): EventDayItem => ({
        eventId: e.eventId,
        slug: e.slug,
        name: e.name,
        scopeType: e.scopeType,
        date: d.date,
        dayLabel: d.dayLabel,
        startTime: d.startTime,
        endTime: d.endTime,
        owned: e.owned,
        ...(sharedEventIds?.has(e.eventId) ? { shared: true } : {}),
      }),
    ),
  )
}

// An all-day day (no start time) sorts to the top of its calendar day, before
// any timed day. Used as a sort tiebreaker when two days share an instant.
export function isAllDay(item: EventDayItem): boolean {
  return item.startTime == null
}
