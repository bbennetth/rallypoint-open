import { Hono } from 'hono'
import { z } from 'zod'
import {
  CreatePersonalEventSchema,
  eventInstantField,
  PatchPersonalEventSchema,
} from '@rallypoint/events-shared'
import { ulid } from 'ulid'
import type { Context } from 'hono'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { readJsonBody } from './_body.js'
import { proxyEvents } from '../lib/sdk-error.js'
import {
  cancelEventNotification,
  syncEventNotification,
  type NotifiableEvent,
} from '../lib/notifications.js'

// Best-effort: keep a personal event's scheduled push notification in sync
// with the write that just succeeded. A notification failure must never fail
// the user's event write, so this swallows + logs errors.
async function syncEventNotificationSafe(
  c: Context<HonoApp>,
  actor: string,
  event: NotifiableEvent,
): Promise<void> {
  try {
    await syncEventNotification(c.var.repos, actor, event, {
      now: new Date(),
      appUrl: c.var.env.PLANNER_UI_ORIGIN,
      newId: () => `psn_${ulid()}`,
    })
  } catch (err) {
    c.var.logger.warn({ err, eventId: event.id }, 'failed to sync event notification')
  }
}

// Planner Personal Events BFF (slice 7). A thin proxy over the Events SDK's
// authenticated /sdk/personal-events surface — planner-api owns no event or
// ticket storage. Every route resolves the acting user from the planner
// session and forwards to events-api with x-actor = session.userId.
//
// Authorization: unlike the Lists read surface (which the BFF must guard for
// IDOR), the Events personal surface is actor-scoped end-to-end downstream —
// listPersonalEvents filters by owner, getPersonalEvent 404s on a foreign
// owner, and every ticket route gates on loadOwnedPersonalEvent. So a foreign
// eventId simply 404s at events-api; the BFF needs no extra ownership guard.
//
// Ticket upload (#409): single-step multipart POST to the BFF, which forwards
// the file as multipart to events-api. No presign step, no cross-origin PUT.

export const eventsRoutes = new Hono<HonoApp>()
  // --- toggle the planner-pref for a group event -------------------
  // Sets or clears the actor's "show in planner" flag on a group event they
  // can access. Used by planner-web to remove a group event from the
  // My Day / Upcoming surfaces. `show: false` removes it; `show: true` re-adds.
  // Access is re-checked server-side by events-api; a 403/404 from events-api
  // proxies through as-is.
  .put('/api/v1/ui/events/:eventId/planner-pref', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const eventId = c.req.param('eventId')
    const events = c.var.services.eventsClient
    const PlannerPrefSchema = z.object({ show: z.boolean() })
    const parsed = PlannerPrefSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    await proxyEvents(() =>
      events.setGroupEventPlannerPref({ actor, eventId, show: parsed.data.show }),
    )
    return c.body(null, 204)
  })

  // --- list the caller's personal events ---------------------------
  // Optional from/to ISO-instant window bounds are validated at the boundary
  // so malformed input surfaces a planner validation envelope rather than
  // events-api's internal wording (and never hits the network).
  .get('/api/v1/ui/events', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const events = c.var.services.eventsClient
    const from = c.req.query('from')
    const to = c.req.query('to')
    if (from !== undefined && !eventInstantField.safeParse(from).success)
      throw errors.validation({ from: 'must be an ISO-8601 instant with offset' })
    if (to !== undefined && !eventInstantField.safeParse(to).success)
      throw errors.validation({ to: 'must be an ISO-8601 instant with offset' })
    const rows = await proxyEvents(() =>
      events.listPersonalEvents({
        actor,
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
      }),
    )
    return c.json(rows)
  })

  // --- create a personal event -------------------------------------
  .post('/api/v1/ui/events', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const events = c.var.services.eventsClient
    const parsed = CreatePersonalEventSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data
    const created = await proxyEvents(() =>
      events.createPersonalEvent({
        actor,
        name: body.name,
        ...(body.description != null ? { description: body.description } : {}),
        ...(body.startAt !== undefined ? { startAt: body.startAt } : {}),
        ...(body.endAt !== undefined ? { endAt: body.endAt } : {}),
        ...(body.locationLabel != null ? { locationLabel: body.locationLabel } : {}),
        ...(body.ticketPlatform != null ? { ticketPlatform: body.ticketPlatform } : {}),
        ...(body.ticketAccountEmail != null ? { ticketAccountEmail: body.ticketAccountEmail } : {}),
        ...(body.allDay !== undefined ? { allDay: body.allDay } : {}),
      }),
    )
    await syncEventNotificationSafe(c, actor, created)
    return c.json(created, 201)
  })

  // --- edit a personal event ---------------------------------------
  // A foreign / missing eventId 404s downstream (events-api is actor-scoped),
  // so no extra BFF ownership guard. null clears a nullable field.
  .patch('/api/v1/ui/events/:eventId', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const events = c.var.services.eventsClient
    const parsed = PatchPersonalEventSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const patch = parsed.data
    const updated = await proxyEvents(() =>
      events.patchPersonalEvent({
        actor,
        id: c.req.param('eventId'),
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.startAt !== undefined ? { startAt: patch.startAt } : {}),
        ...(patch.endAt !== undefined ? { endAt: patch.endAt } : {}),
        ...(patch.locationLabel !== undefined ? { locationLabel: patch.locationLabel } : {}),
        ...(patch.ticketPlatform !== undefined ? { ticketPlatform: patch.ticketPlatform } : {}),
        ...(patch.ticketAccountEmail !== undefined ? { ticketAccountEmail: patch.ticketAccountEmail } : {}),
        ...(patch.allDay !== undefined ? { allDay: patch.allDay } : {}),
      }),
    )
    await syncEventNotificationSafe(c, actor, updated)
    return c.json(updated)
  })

  // --- delete a personal event -------------------------------------
  .delete('/api/v1/ui/events/:eventId', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const events = c.var.services.eventsClient
    const eventId = c.req.param('eventId')
    await proxyEvents(() => events.deletePersonalEvent({ actor, id: eventId }))
    try {
      await cancelEventNotification(c.var.repos, actor, eventId, new Date())
    } catch (err) {
      c.var.logger.warn({ err, eventId }, 'failed to cancel event notification')
    }
    return c.body(null, 204)
  })

  // --- list ticket attachments for an event ------------------------
  .get('/api/v1/ui/events/:eventId/tickets', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const events = c.var.services.eventsClient
    const tickets = await proxyEvents(() =>
      events.listTickets({ actor, eventId: c.req.param('eventId') }),
    )
    return c.json(tickets)
  })

  // --- upload a ticket attachment (#409) --------------------------
  // Single-step: browser POSTs multipart/form-data here; the BFF
  // streams the file bytes to events-api via uploadTicket. No presign
  // step, no cross-origin PUT, no two-step presign+bind.
  .post('/api/v1/ui/events/:eventId/tickets', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const eventId = c.req.param('eventId')
    const events = c.var.services.eventsClient

    const formData = await c.req.formData()
    const file = formData.get('file')
    const fileNameRaw = formData.get('fileName')

    if (!(file instanceof File)) {
      throw errors.validation({ issues: [{ path: ['file'], message: 'file is required.' }] })
    }
    const contentType = (file.type ?? '').split(';')[0]!.trim().toLowerCase()
    const fileName = typeof fileNameRaw === 'string' && fileNameRaw.trim().length > 0
      ? fileNameRaw.trim()
      : undefined

    const bound = await proxyEvents(() =>
      events.uploadTicket({
        actor,
        eventId,
        file,
        contentType,
        ...(fileName !== undefined ? { fileName } : {}),
      }),
    )
    return c.json(bound, 201)
  })

  // --- download a ticket attachment --------------------------------
  // Streams the bytes from the Worker (R2 binding) back to the browser.
  .get('/api/v1/ui/events/:eventId/tickets/:ticketId/download', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const events = c.var.services.eventsClient
    const upstream = await proxyEvents(() =>
      events.downloadTicket({
        actor,
        eventId: c.req.param('eventId'),
        ticketId: c.req.param('ticketId'),
      }),
    )
    // Pipe the upstream response (content-type + body) straight through.
    const contentType = upstream.headers.get('Content-Type') ?? 'application/octet-stream'
    const contentLength = upstream.headers.get('Content-Length')
    c.header('Content-Type', contentType)
    if (contentLength) c.header('Content-Length', contentLength)
    c.header('Cache-Control', 'private, max-age=300')
    return c.body(upstream.body as unknown as ReadableStream)
  })
