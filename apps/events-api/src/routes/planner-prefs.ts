import { Hono } from 'hono'
import { z } from 'zod'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { readJsonBody } from './_body.js'
import { loadForAction } from './_access.js'
import { requireActor } from './_actor.js'
import { serializeUserEventDto } from './sdk-user-events.js'
import type { DayRecord } from '../repos/types.js'

// Per-user "show in planner" flag for a group event.
// Two surfaces live here:
//
// Session UI (events-web):
//   PUT /api/v1/ui/events/:eventId/planner-pref
//     — viewer-level auth (loadForAction); upserts the caller's pref.
//   GET /api/v1/ui/events/planner-prefs
//     — returns the list of flagged event ids for the caller.
//
// x-actor SDK (planner-api BFF):
//   PUT /api/v1/sdk/events/:eventId/planner-pref
//     — requires Bearer (requireSdkKey in build-app) + x-actor;
//       re-checks access via loadForAction with actor-as-userId.
//   GET /api/v1/sdk/planner-events
//     — returns flagged, live, accessible events as UserEventDto[];
//       re-checks access at read time so a removed attendee's flagged
//       events silently drop out.

const PlannerPrefSchema = z.object({ show: z.boolean() })

// UI surface (session-gated). Mounted before eventsRoutes in build-app.ts
// so GET /api/v1/ui/events/planner-prefs isn't captured by GET /:slug.
export const plannerPrefsUiRoutes = new Hono<HonoApp>()
  // --- UI: list all flagged event ids for the caller -----------------
  // Registered FIRST so "planner-prefs" literal wins over /:slug. Used
  // by events-web to restore toggle state on load.
  .get('/api/v1/ui/events/planner-prefs', async (c) => {
    const userId = c.var.session!.userId
    const eventIds = await c.var.repos.eventPlannerPrefs.flaggedEventIdsForActor(userId)
    return c.json({ eventIds })
  })

  // --- UI: set pref for a single event (session-gated viewer+) ------
  .put('/api/v1/ui/events/:eventId/planner-pref', async (c) => {
    const userId = c.var.session!.userId
    const { event } = await loadForAction(c, c.req.param('eventId'), 'viewer')
    const parsed = PlannerPrefSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    await c.var.repos.eventPlannerPrefs.upsert(event.id, userId, parsed.data.show)
    return c.body(null, 204)
  })

// SDK surface (requireSdkKey in build-app.ts + x-actor). Mounted after the
// key middleware is registered so the Bearer gate applies.
export const plannerPrefsSdkRoutes = new Hono<HonoApp>()
  // --- SDK: set pref for a single event (x-actor + Bearer key) ------
  .put('/api/v1/sdk/events/:eventId/planner-pref', async (c) => {
    const actor = requireActor(c)
    const eventId = c.req.param('eventId')
    if (!eventId.startsWith('event_')) throw errors.notFound()
    const event = await c.var.repos.events.findById(eventId)
    if (!event || event.deletedAt) throw errors.notFound()
    // Verify actor has at least viewer access.
    const member = await c.var.repos.members.findByEventAndUser(event.id, actor)
    const attendee = await c.var.repos.attendees.findByEventAndUser(event.id, actor)
    const isOwner = event.ownerUserId === actor
    const isMember = member !== null && (attendee === null || attendee.removedAt === null)
    const isActiveAttendee = attendee !== null && attendee.removedAt === null
    if (!isOwner && !isMember && !isActiveAttendee) throw errors.notFound()
    const parsed = PlannerPrefSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    await c.var.repos.eventPlannerPrefs.upsert(event.id, actor, parsed.data.show)
    return new Response(null, { status: 204 })
  })

  // --- SDK: get all flagged events for the actor ---------------------
  // Silently drops events the actor can no longer access (removed
  // attendee, soft-deleted event). Re-checks access at read time.
  .get('/api/v1/sdk/planner-events', async (c) => {
    const actor = requireActor(c)
    const eventIds = await c.var.repos.eventPlannerPrefs.flaggedEventIdsForActor(actor)
    const accessible = []
    for (const eventId of eventIds) {
      const event = await c.var.repos.events.findById(eventId)
      // Drop hard-deleted or soft-deleted events.
      if (!event || event.deletedAt) continue
      // Re-check access: verify actor still reaches the event.
      const member = await c.var.repos.members.findByEventAndUser(event.id, actor)
      const attendee = await c.var.repos.attendees.findByEventAndUser(event.id, actor)
      const isOwner = event.ownerUserId === actor
      const isMember = member !== null && (attendee === null || attendee.removedAt === null)
      const isActiveAttendee = attendee !== null && attendee.removedAt === null
      if (!isOwner && !isMember && !isActiveAttendee) continue
      accessible.push(event)
    }
    // Resolve every event's days in one round-trip, then serialize to the
    // same UserEventDto shape listUserEvents returns (Planner expands these
    // by day — a missing `days` array would break the roll-up).
    const allDays = await c.var.repos.days.listForEventsIn(accessible.map((e) => e.id))
    const daysByEvent = new Map<string, DayRecord[]>()
    for (const day of allDays) {
      const bucket = daysByEvent.get(day.eventId)
      if (bucket) bucket.push(day)
      else daysByEvent.set(day.eventId, [day])
    }
    return c.json(
      accessible.map((event) =>
        serializeUserEventDto(event, daysByEvent.get(event.id) ?? [], actor),
      ),
    )
  })
