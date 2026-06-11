import { Hono } from 'hono'
import { ulid } from 'ulid'
import { CreateRallySchema, PatchRallySchema, RallyRsvpSchema } from '@rallypoint/events-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { RallyAttendeeRecord, RallyRecord } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { recordActivity } from './_access.js'
import { loadGroupForAction } from './_group-access.js'

// Rallies — a group's planned meet-ups within an event (Slice 9b). All
// routes live under /api/v1/ui/groups/:id/rallies and are gated by
// loadGroupForAction: reads need 'member', writes need 'sidekick', and
// RSVP is a per-member self-action ('member'). The :rallyId must belong
// to the addressed group or we 404 (no cross-group leak).

const num = (n: number | null | undefined): string | null =>
  n === null || n === undefined ? null : String(n)

function rsvpSummary(attendees: RallyAttendeeRecord[]): {
  going: number
  maybe: number
  out: number
} {
  const summary = { going: 0, maybe: 0, out: 0 }
  for (const a of attendees) summary[a.status] += 1
  return summary
}

function serializeAttendee(a: RallyAttendeeRecord): Record<string, unknown> {
  return {
    id: a.id,
    user_id: a.userId,
    status: a.status,
    responded_at: a.respondedAt.toISOString(),
  }
}

function serializeRally(
  rally: RallyRecord,
  attendees: RallyAttendeeRecord[],
  viewerUserId: string,
): Record<string, unknown> {
  const viewer = attendees.find((a) => a.userId === viewerUserId) ?? null
  return {
    id: rally.id,
    group_id: rally.groupId,
    event_id: rally.eventId,
    title: rally.title,
    description: rally.description,
    day_id: rally.dayId,
    start_time: rally.startTime,
    poi_id: rally.poiId,
    location_label: rally.locationLabel,
    lat: rally.lat,
    lng: rally.lng,
    status: rally.status,
    created_by: rally.createdBy,
    created_at: rally.createdAt.toISOString(),
    updated_at: rally.updatedAt.toISOString(),
    attendees: attendees.map(serializeAttendee),
    rsvp_summary: rsvpSummary(attendees),
    viewer_rsvp: viewer ? viewer.status : null,
  }
}

// Load a rally and confirm it belongs to the addressed group. A rally
// from another group 404s exactly like a missing one (no existence leak).
async function loadRallyInGroup(
  c: Parameters<typeof loadGroupForAction>[0],
  groupId: string,
  rallyId: string,
): Promise<RallyRecord> {
  const rally = await c.var.repos.rallies.findById(rallyId)
  if (!rally || rally.groupId !== groupId) throw errors.rallyNotFound()
  return rally
}

// Verify any supplied day_id / poi_id belongs to the rally's event so a
// bad reference fails as a clean 409, not an opaque FK 500.
async function assertLocationRefs(
  c: Parameters<typeof loadGroupForAction>[0],
  eventId: string,
  fields: { dayId?: string | null | undefined; poiId?: string | null | undefined },
): Promise<void> {
  if (fields.dayId) {
    const day = await c.var.repos.days.findById(fields.dayId)
    if (!day || day.eventId !== eventId) {
      throw errors.conflict('rally_day_invalid', 'That day does not belong to this event.')
    }
  }
  if (fields.poiId) {
    const poi = await c.var.repos.pois.findById(fields.poiId)
    if (!poi || poi.eventId !== eventId) {
      throw errors.conflict('rally_poi_invalid', 'That location does not belong to this event.')
    }
  }
}

export const ralliesRoutes = new Hono<HonoApp>()
  // --- list (group member+) -----------------------------------------
  .get('/api/v1/ui/groups/:id/rallies', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'member')
    const rallies = await c.var.repos.rallies.listForGroup(group.id)
    const attendees = await c.var.repos.rallyAttendees.listForRallies(rallies.map((r) => r.id))
    const byRally = new Map<string, RallyAttendeeRecord[]>()
    for (const a of attendees) {
      const list = byRally.get(a.rallyId) ?? []
      list.push(a)
      byRally.set(a.rallyId, list)
    }
    const items = rallies.map((r) =>
      serializeRally(r, byRally.get(r.id) ?? [], c.var.session!.userId),
    )
    return c.json({ items })
  })

  // --- create (group sidekick+) -------------------------------------
  .post('/api/v1/ui/groups/:id/rallies', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'sidekick')
    const parsed = CreateRallySchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data
    await assertLocationRefs(c, group.eventId, { dayId: body.dayId, poiId: body.poiId })

    const rally = await c.var.repos.rallies.create({
      id: `rally_${ulid()}`,
      groupId: group.id,
      eventId: group.eventId,
      title: body.title,
      description: body.description ?? null,
      dayId: body.dayId ?? null,
      startTime: body.startTime ?? null,
      poiId: body.poiId ?? null,
      locationLabel: body.locationLabel ?? null,
      lat: num(body.lat),
      lng: num(body.lng),
      ...(body.status !== undefined ? { status: body.status } : {}),
      createdBy: c.var.session!.userId,
    })
    await recordActivity(c, group.eventId, 'rally.created', { rally_id: rally.id, group_id: group.id })
    return c.json(serializeRally(rally, [], c.var.session!.userId), 201)
  })

  // --- detail (group member+) ---------------------------------------
  .get('/api/v1/ui/groups/:id/rallies/:rallyId', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'member')
    const rally = await loadRallyInGroup(c, group.id, c.req.param('rallyId'))
    const attendees = await c.var.repos.rallyAttendees.listForRally(rally.id)
    return c.json(serializeRally(rally, attendees, c.var.session!.userId))
  })

  // --- patch (group sidekick+) --------------------------------------
  .patch('/api/v1/ui/groups/:id/rallies/:rallyId', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'sidekick')
    const rally = await loadRallyInGroup(c, group.id, c.req.param('rallyId'))
    const parsed = PatchRallySchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const fields = parsed.data
    await assertLocationRefs(c, group.eventId, { dayId: fields.dayId, poiId: fields.poiId })

    const updated = await c.var.repos.rallies.patch(rally.id, {
      ...(fields.title !== undefined ? { title: fields.title } : {}),
      ...(fields.description !== undefined ? { description: fields.description } : {}),
      ...(fields.dayId !== undefined ? { dayId: fields.dayId } : {}),
      ...(fields.startTime !== undefined ? { startTime: fields.startTime } : {}),
      ...(fields.poiId !== undefined ? { poiId: fields.poiId } : {}),
      ...(fields.locationLabel !== undefined ? { locationLabel: fields.locationLabel } : {}),
      ...(fields.lat !== undefined ? { lat: num(fields.lat) } : {}),
      ...(fields.lng !== undefined ? { lng: num(fields.lng) } : {}),
      ...(fields.status !== undefined ? { status: fields.status } : {}),
    })
    if (!updated) throw errors.rallyNotFound()
    await recordActivity(c, group.eventId, 'rally.patched', {
      rally_id: rally.id,
      fields: Object.keys(fields),
    })
    const attendees = await c.var.repos.rallyAttendees.listForRally(updated.id)
    return c.json(serializeRally(updated, attendees, c.var.session!.userId))
  })

  // --- delete (group sidekick+) -------------------------------------
  .delete('/api/v1/ui/groups/:id/rallies/:rallyId', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'sidekick')
    const rally = await loadRallyInGroup(c, group.id, c.req.param('rallyId'))
    await c.var.repos.rallies.delete(rally.id)
    await recordActivity(c, group.eventId, 'rally.deleted', { rally_id: rally.id, group_id: group.id })
    return c.body(null, 204)
  })

  // --- rsvp (group member+, self) -----------------------------------
  .put('/api/v1/ui/groups/:id/rallies/:rallyId/rsvp', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'member')
    const rally = await loadRallyInGroup(c, group.id, c.req.param('rallyId'))
    const parsed = RallyRsvpSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    await c.var.repos.rallyAttendees.upsert({
      id: `rta_${ulid()}`,
      rallyId: rally.id,
      userId: c.var.session!.userId,
      status: parsed.data.status,
    })
    await recordActivity(c, group.eventId, 'rally.rsvp', {
      rally_id: rally.id,
      status: parsed.data.status,
    })
    const attendees = await c.var.repos.rallyAttendees.listForRally(rally.id)
    return c.json(serializeRally(rally, attendees, c.var.session!.userId))
  })
