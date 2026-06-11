import { Hono } from 'hono'
import {
  eventDateField,
  setRange,
  composeInstant,
  findConflicts,
  type LabeledSet,
  type DueThing,
} from '@rallypoint/events-shared'
import type { ListItemDto } from '@rallypoint/lists-client'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { applyPerUserRateLimit } from '../middleware/rate-limit.js'
import type { DayRecord, EventArtistRecord, RallyRecord } from '../repos/types.js'
import { loadGroupForAction } from './_group-access.js'

// My Day (slice 9b, #131): a single group-scoped, read-only aggregator for
// one calendar date. It folds together the group's rallies, the event's
// lineup sets, and the group's task items due that day, then runs the pure
// conflict resolver (events-shared) to flag tasks/rallies that land inside a
// lineup set. Group members can read; there are no writes here.
//
// All times are treated as UTC-naive wall-clock (see schedule-logic.ts) —
// cross-timezone correctness is a deliberate v1 deferral.

function serializeDayRally(r: RallyRecord): Record<string, unknown> {
  return {
    id: r.id,
    title: r.title,
    day_id: r.dayId,
    start_time: r.startTime,
    poi_id: r.poiId,
    location_label: r.locationLabel,
    status: r.status,
  }
}

function serializeSet(s: EventArtistRecord, label: string): Record<string, unknown> {
  return {
    artist_id: s.artistId,
    label,
    stage_id: s.stageId,
    start_time: s.startTime,
    end_time: s.endTime,
  }
}

function serializeTask(item: ListItemDto): Record<string, unknown> {
  return {
    id: item.id,
    list_id: item.listId,
    title: item.title,
    due_date: item.dueDate,
    status: item.status,
    priority: item.priority,
    completed: item.completed,
  }
}

export const groupDayRoutes = new Hono<HonoApp>().get(
  '/api/v1/ui/groups/:id/day',
  async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'member')

    // Per-user rate limit: 60 req/min. loadGroupForAction already verified
    // the session, so c.var.session is guaranteed to be set here.
    await applyPerUserRateLimit(c, {
      userId: c.var.session!.userId,
      route: 'group-day',
      limit: 60,
      windowSeconds: 60,
    })

    const parsedDate = eventDateField.safeParse(c.req.query('date'))
    if (!parsedDate.success) throw errors.validation({ issues: parsedDate.error.issues })
    const date = parsedDate.data

    // The day record (if any) anchors lineup + day-scoped rallies to this
    // date. A date with no configured day still surfaces tasks due then.
    const days = await c.var.repos.days.listForEvent(group.eventId)
    const day: DayRecord | null = days.find((d) => d.date === date) ?? null

    // Rallies: listForGroup is unfiltered, so narrow to this day's id.
    const allRallies = await c.var.repos.rallies.listForGroup(group.id)
    const dayRallies = day ? allRallies.filter((r) => r.dayId === day.id) : []

    // Lineup sets for the day, labelled with the artist's display/catalog name.
    const allSlots = await c.var.repos.eventArtists.listForEvent(group.eventId)
    const daySlots = day ? allSlots.filter((s) => s.dayId === day.id) : []
    const labelByArtist = new Map<string, string>()
    for (const id of new Set(daySlots.map((s) => s.artistId))) {
      const artist = await c.var.repos.artists.findById(id)
      labelByArtist.set(id, artist?.name ?? id)
    }
    const labelFor = (s: EventArtistRecord): string => s.displayName ?? labelByArtist.get(s.artistId) ?? s.artistId

    // Group task items due this day, pulled across the group's lists via the
    // lists SDK. due_date is a real timestamptz; match on its UTC date-part.
    const lists = await c.var.services.listsClient.listLists({
      scopeType: 'group',
      scopeId: group.id,
    })
    const dueTasks: ListItemDto[] = []
    for (const list of lists) {
      const items = await c.var.services.listsClient.listItems(list.id)
      for (const item of items) {
        if (item.dueDate && item.dueDate.slice(0, 10) === date) dueTasks.push(item)
      }
    }

    // Conflict detection over the day's sets vs. task-dues and rally-starts.
    const labeledSets: LabeledSet[] = []
    for (const s of daySlots) {
      const range = setRange(date, s.startTime, s.endTime)
      if (range) labeledSets.push({ ...range, label: labelFor(s) })
    }
    const things: DueThing[] = []
    for (const t of dueTasks) {
      const at = t.dueDate ? Date.parse(t.dueDate) : NaN
      if (!Number.isNaN(at)) things.push({ id: t.id, title: t.title, at, kind: 'task' })
    }
    for (const r of dayRallies) {
      const at = composeInstant(date, r.startTime)
      if (at !== null) things.push({ id: r.id, title: r.title, at, kind: 'rally' })
    }
    const conflicts = findConflicts(labeledSets, things).map((conflict) => ({
      kind: conflict.kind,
      id: conflict.id,
      title: conflict.title,
      sets: conflict.sets.map((s) => s.label),
    }))

    return c.json({
      date,
      day: day ? { id: day.id, day_label: day.dayLabel, date: day.date } : null,
      rallies: dayRallies.map(serializeDayRally),
      lineup: daySlots.map((s) => serializeSet(s, labelFor(s))),
      tasks: dueTasks.map(serializeTask),
      conflicts,
    })
  },
)
