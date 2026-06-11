import { Hono } from 'hono'
import type { Context } from 'hono'
import { ulid } from 'ulid'
import {
  TICKET_MIME_EXTENSIONS,
  TICKET_MIME_TYPES,
  validateTicketUpload,
  type TicketMimeType,
} from '@rallypoint/events-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { EventRecord, PersonalTicketRecord } from '../repos/types.js'
import { requireActor } from './_actor.js'

// Authenticated SDK write surface for personal-event ticket attachments.
// Routes live under /api/v1/sdk/personal-events/:eventId/tickets* and
// inherit the existing PLANNER_API_KEY gate from build-app.ts.

// Resolve a personal event, verifying ownership. Throws 404 on any
// mismatch (missing, soft-deleted, wrong scope, different owner) —
// never reveal which condition failed.
async function loadOwnedPersonalEvent(
  c: Context<HonoApp>,
  eventId: string,
  actor: string,
): Promise<EventRecord> {
  const event = await c.var.repos.events.findById(eventId)
  if (
    !event ||
    event.deletedAt !== null ||
    event.scopeType !== 'personal' ||
    event.ownerUserId !== actor
  ) {
    throw errors.notFound('Personal event not found.')
  }
  return event
}

// Object key is reconstructed server-side from trusted ids + mime
// extension — never accepted from the client (design §3.8 posture).
function objectKeyFor(eventId: string, ticketId: string, mime: TicketMimeType): string {
  return `personal-tickets/${eventId}/${ticketId}.${TICKET_MIME_EXTENSIONS[mime]}`
}

// Flat camelCase DTO. objectKey is NEVER surfaced to callers.
function serializeTicketDto(t: PersonalTicketRecord): Record<string, unknown> {
  return {
    id: t.id,
    eventId: t.eventId,
    contentType: t.contentType,
    bytes: t.bytes,
    fileName: t.fileName,
    uploadedByUserId: t.uploadedByUserId,
    uploadedAt: t.uploadedAt.toISOString(),
  }
}

export const sdkPersonalTicketsRoutes = new Hono<HonoApp>()
  // Single-request upload (#409). The caller POSTs multipart/form-data
  // to the Worker; the Worker validates inline and streams bytes into the
  // R2 binding. Fields: `file` (the ticket binary, Content-Type set by
  // the caller), `fileName` (optional display name). No presign step.
  .post('/api/v1/sdk/personal-events/:eventId/tickets', async (c) => {
    const actor = requireActor(c)
    const eventId = c.req.param('eventId')
    await loadOwnedPersonalEvent(c, eventId, actor)

    const formData = await c.req.formData()
    const file = formData.get('file')
    const fileNameRaw = formData.get('fileName')

    if (!(file instanceof File)) {
      throw errors.validation({ issues: [{ path: ['file'], message: 'file is required.' }] })
    }

    const contentType = (file.type ?? '').split(';')[0]!.trim().toLowerCase() as TicketMimeType
    if (!(TICKET_MIME_TYPES as readonly string[]).includes(contentType)) {
      throw errors.validation({
        issues: [{ path: ['file'], message: 'Unsupported ticket file type.' }],
      })
    }

    const check = validateTicketUpload({ contentType, contentLength: file.size })
    if (!check.ok) {
      throw errors.validation({
        issues: [{ path: ['file'], message: 'Ticket file is too large (max 10 MB).' }],
      })
    }

    const ticketId = `pkt_${ulid()}`
    const objectKey = objectKeyFor(eventId, ticketId, contentType)
    const bytes = await file.arrayBuffer()
    await c.var.services.objectStore.put(objectKey, bytes, { contentType })

    const fileName = typeof fileNameRaw === 'string' && fileNameRaw.trim().length > 0
      ? fileNameRaw.trim()
      : null

    let ticket: PersonalTicketRecord
    try {
      ticket = await c.var.repos.personalTickets.create({
        id: ticketId,
        eventId,
        objectKey,
        contentType,
        bytes: file.size,
        fileName,
        uploadedByUserId: actor,
      })
    } catch (err) {
      // Bytes are in R2 but no row references them — reap the orphan the
      // pruner (row-walking only) would never reclaim, then re-throw.
      await c.var.services.objectStore.deleteObject(objectKey).catch(() => undefined)
      throw err
    }

    return c.json(serializeTicketDto(ticket), 201)
  })

  // List all ticket attachments for an owned personal event.
  .get('/api/v1/sdk/personal-events/:eventId/tickets', async (c) => {
    const actor = requireActor(c)
    const eventId = c.req.param('eventId')
    await loadOwnedPersonalEvent(c, eventId, actor)

    const tickets = await c.var.repos.personalTickets.listForEvent(eventId)
    return c.json({ items: tickets.map(serializeTicketDto) })
  })

  // Stream the stored ticket bytes through the Worker (#409). The bucket
  // is private — no presigned URLs. The caller (Planner BFF) presents
  // its PLANNER_API_KEY bearer; the same ownership gate as above applies.
  .get('/api/v1/sdk/personal-events/:eventId/tickets/:ticketId/download', async (c) => {
    const actor = requireActor(c)
    const eventId = c.req.param('eventId')
    await loadOwnedPersonalEvent(c, eventId, actor)

    const ticketId = c.req.param('ticketId')
    const ticket = await c.var.repos.personalTickets.findById(ticketId)
    if (!ticket || ticket.eventId !== eventId) {
      throw errors.notFound('Ticket not found.')
    }

    const obj = await c.var.services.objectStore.get(ticket.objectKey)
    if (!obj) throw errors.notFound('Ticket not found.')
    c.header('Content-Type', obj.contentType ?? 'application/octet-stream')
    if (obj.contentLength !== null) c.header('Content-Length', String(obj.contentLength))
    // Tickets are small, user-uploaded, immutable after upload.
    c.header('Cache-Control', 'private, max-age=300')
    return c.body(obj.body as unknown as ReadableStream)
  })
