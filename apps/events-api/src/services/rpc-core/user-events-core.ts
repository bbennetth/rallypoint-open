import { generateDays } from '@rallypoint/events-shared'
import type { DayRecord, EventRecord } from '../../repos/types.js'
import type { EventsRpcDeps } from './deps.js'

// Cross-Worker RPC core for the user-events + planner-prefs read paths.
// HTTP handlers (routes/sdk-user-events.ts, routes/planner-prefs.ts)
// and EventsRPC methods both call these.

export interface UserEventDayDto {
  date: string
  dayLabel: string
  startTime: string | null
  endTime: string | null
}

export interface UserEventDto {
  eventId: string
  slug: string
  name: string
  scopeType: string
  owned: boolean
  startDate: string | null
  endDate: string | null
  days: UserEventDayDto[]
}

function serializeDay(d: {
  date: string
  dayLabel: string
  startTime: string | null
  endTime: string | null
}): UserEventDayDto {
  return {
    date: d.date,
    dayLabel: d.dayLabel,
    startTime: d.startTime,
    endTime: d.endTime,
  }
}

function resolveDays(event: EventRecord, days: DayRecord[]): UserEventDayDto[] {
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
): UserEventDto {
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

export async function listUserEventsCore(
  actor: string,
  deps: EventsRpcDeps,
): Promise<UserEventDto[]> {
  const events = await deps.repos.events.listGroupForUser(actor)
  return resolveDaysAndSerialize(events, actor, deps)
}

export async function getPlannerEventsCore(
  actor: string,
  deps: EventsRpcDeps,
): Promise<UserEventDto[]> {
  const eventIds = await deps.repos.eventPlannerPrefs.flaggedEventIdsForActor(actor)
  const accessible: EventRecord[] = []
  for (const eventId of eventIds) {
    const event = await deps.repos.events.findById(eventId)
    if (!event || event.deletedAt) continue
    if (!(await actorHasAccess(event, actor, deps))) continue
    accessible.push(event)
  }
  return resolveDaysAndSerialize(accessible, actor, deps)
}

export async function setPlannerPrefCore(
  actor: string,
  eventId: string,
  show: boolean,
  deps: EventsRpcDeps,
): Promise<{ kind: 'ok' } | { kind: 'not_found' }> {
  if (!eventId.startsWith('event_')) return { kind: 'not_found' }
  const event = await deps.repos.events.findById(eventId)
  if (!event || event.deletedAt) return { kind: 'not_found' }
  if (!(await actorHasAccess(event, actor, deps))) return { kind: 'not_found' }
  await deps.repos.eventPlannerPrefs.upsert(event.id, actor, show)
  return { kind: 'ok' }
}

async function actorHasAccess(
  event: EventRecord,
  actor: string,
  deps: EventsRpcDeps,
): Promise<boolean> {
  const member = await deps.repos.members.findByEventAndUser(event.id, actor)
  const attendee = await deps.repos.attendees.findByEventAndUser(event.id, actor)
  const isOwner = event.ownerUserId === actor
  const isMember = member !== null && (attendee === null || attendee.removedAt === null)
  const isActiveAttendee = attendee !== null && attendee.removedAt === null
  return isOwner || isMember || isActiveAttendee
}

async function resolveDaysAndSerialize(
  events: EventRecord[],
  actor: string,
  deps: EventsRpcDeps,
): Promise<UserEventDto[]> {
  const allDays = await deps.repos.days.listForEventsIn(events.map((e) => e.id))
  const daysByEvent = new Map<string, DayRecord[]>()
  for (const day of allDays) {
    const bucket = daysByEvent.get(day.eventId)
    if (bucket) bucket.push(day)
    else daysByEvent.set(day.eventId, [day])
  }
  return events.map((event) =>
    serializeUserEventDto(event, daysByEvent.get(event.id) ?? [], actor),
  )
}
