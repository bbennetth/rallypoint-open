import { Hono } from 'hono'
import { generateDays } from '@rallypoint/events-shared'
import type { HonoApp } from '../context.js'
import type { DayRecord, EventRecord } from '../repos/types.js'
import { requireActor } from './_actor.js'

// Authenticated SDK read surface for the group (festival) events a user
// reaches — as owner, collaborator (event_members), or current attendee
// (event_attendees, removed_at IS NULL). Lives under
// /api/v1/sdk/user-events and is gated by requireSdkKey (PLANNER_API_KEY
// bearer) in build-app.ts; events-api accepts only the planner key, so
// the route is planner-only by construction.
//
// The actor is read from the x-actor header (a `user_<ulid>` asserted by
// the calling Planner BFF). `owned` is server-stamped from
// owner_user_id === actor — never trusted from the client — so the
// Planner pencil-to-edit affordance can't be spoofed.
//
// Planner folds these into upcoming / my-day, one item per day.

// One day row in the DTO. Times follow the "date + optional times"
// model: both null = all-day, both set = a timed window.
function serializeDay(d: { date: string; dayLabel: string; startTime: string | null; endTime: string | null }): Record<string, unknown> {
  return {
    date: d.date,
    dayLabel: d.dayLabel,
    startTime: d.startTime,
    endTime: d.endTime,
  }
}

// Resolve the day rows for an event: the persisted event_days, or — when
// none exist yet — synthesized all-day days across the event's date range
// (so Planner always gets at least one dated entry per dated event).
function resolveDays(event: EventRecord, days: DayRecord[]): Record<string, unknown>[] {
  if (days.length > 0) {
    return [...days]
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.sortOrder - b.sortOrder))
      .map(serializeDay)
  }
  if (event.startDate && event.endDate) {
    return generateDays({ startDate: event.startDate, endDate: event.endDate }).map((g) =>
      serializeDay({ date: g.date, dayLabel: g.dayLabel, startTime: null, endTime: null }),
    )
  }
  return []
}

export function serializeUserEventDto(
  event: EventRecord,
  days: DayRecord[],
  actor: string,
): Record<string, unknown> {
  return {
    eventId: event.id,
    slug: event.slug,
    name: event.name,
    scopeType: event.scopeType,
    owned: event.ownerUserId === actor,
    startDate: event.startDate,
    endDate: event.endDate,
    days: resolveDays(event, days),
  }
}

export const sdkUserEventsRoutes = new Hono<HonoApp>()
  // --- list the actor's group events ---------------------------------
  .get('/api/v1/sdk/user-events', async (c) => {
    const actor = requireActor(c)
    const events = await c.var.repos.events.listGroupForUser(actor)
    // Resolve every event's days in one round-trip rather than fanning out
    // one query per event (#307 — an N+1 foot-gun at O(tens) of events),
    // then group by event id in memory.
    const allDays = await c.var.repos.days.listForEventsIn(events.map((e) => e.id))
    const daysByEvent = new Map<string, DayRecord[]>()
    for (const day of allDays) {
      const bucket = daysByEvent.get(day.eventId)
      if (bucket) bucket.push(day)
      else daysByEvent.set(day.eventId, [day])
    }
    const dtos = events.map((event) =>
      serializeUserEventDto(event, daysByEvent.get(event.id) ?? [], actor),
    )
    return c.json(dtos)
  })
