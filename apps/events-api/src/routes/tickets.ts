import { Hono } from 'hono'
import { ulid } from 'ulid'
import { z } from 'zod'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { UniqueConstraintError } from '../repos/errors.js'
import type { TicketRecord } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { loadForAction, recordActivity, requireIdPrefix } from './_access.js'

// Phase T of platform/v-1.1 (#16). Owner/editor-defined ticket tiers
// per event. CRUD only — no selling integration. The public SDK
// surface (cookieless visibility of available tiers) is deferred:
// the owner side ships first, the public page reads when selling
// lands.

const TicketNameField = z.string().trim().min(1).max(100)
const TicketDescriptionField = z
  .string()
  .trim()
  .max(2000)
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .optional()
const PriceCentsField = z.number().int().min(0).max(99_999_999)
const QuantityField = z.number().int().min(0).max(1_000_000_000).nullable().optional()
const SortOrderField = z.number().int().min(0).max(100_000).optional()

const CreateTicketSchema = z.object({
  name: TicketNameField,
  description: TicketDescriptionField,
  priceCents: PriceCentsField,
  quantity: QuantityField,
  sortOrder: SortOrderField,
})

const PatchTicketSchema = z
  .object({
    name: TicketNameField.optional(),
    description: TicketDescriptionField,
    priceCents: PriceCentsField.optional(),
    quantity: QuantityField,
    sortOrder: SortOrderField,
  })
  .superRefine((v, ctx) => {
    if (Object.values(v).every((x) => x === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'At least one field must be supplied.',
      })
    }
  })

function serializeTicket(t: TicketRecord): Record<string, unknown> {
  return {
    id: t.id,
    event_id: t.eventId,
    name: t.name,
    description: t.description,
    price_cents: t.priceCents,
    quantity: t.quantity,
    sold_count: t.soldCount,
    sort_order: t.sortOrder,
    created_at: t.createdAt.toISOString(),
    updated_at: t.updatedAt.toISOString(),
    deleted_at: t.deletedAt ? t.deletedAt.toISOString() : null,
  }
}

export const ticketsRoutes = new Hono<HonoApp>()
  // ── list (editor+) ─────────────────────────────────────────────────
  .get('/api/v1/ui/events/:id/tickets', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const rows = await c.var.repos.tickets.listForEvent(event.id)
    return c.json({ items: rows.map(serializeTicket) })
  })

  // ── create (editor+) ───────────────────────────────────────────────
  .post('/api/v1/ui/events/:id/tickets', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const parsed = CreateTicketSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    try {
      const created = await c.var.repos.tickets.create({
        id: `evt_${ulid()}`,
        eventId: event.id,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        priceCents: parsed.data.priceCents,
        quantity: parsed.data.quantity ?? null,
        ...(parsed.data.sortOrder !== undefined
          ? { sortOrder: parsed.data.sortOrder }
          : {}),
      })
      await recordActivity(c, event.id, 'event.ticket_created', {
        ticket_id: created.id,
        name: created.name,
      })
      return c.json(serializeTicket(created), 201)
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw errors.conflict(
          'ticket_name_taken',
          'A ticket tier with that name already exists.',
        )
      }
      throw err
    }
  })

  // ── patch (editor+) ────────────────────────────────────────────────
  .patch('/api/v1/ui/events/:id/tickets/:ticketId', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const ticketId = requireIdPrefix(c.req.param('ticketId'), 'evt_')
    const parsed = PatchTicketSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    const existing = await c.var.repos.tickets.findById(ticketId)
    if (!existing || existing.eventId !== event.id) {
      throw new ApiError({
        code: 'ticket_not_found',
        message: 'Ticket not found.',
        status: 404,
      })
    }

    // Selling lands later, but the math guard is now: an owner can't
    // lower quantity below what's already been sold. Without this
    // pre-check the DB CHECK constraint trips and surfaces as a 500.
    // Treat it as a 409 — the action is rejectable but not malformed.
    if (
      parsed.data.quantity !== undefined &&
      parsed.data.quantity !== null &&
      parsed.data.quantity < existing.soldCount
    ) {
      throw errors.conflict(
        'ticket_quantity_below_sold',
        'Quantity cannot be lower than already-sold tickets.',
      )
    }

    try {
      const updated = await c.var.repos.tickets.patch(ticketId, {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined
          ? { description: parsed.data.description }
          : {}),
        ...(parsed.data.priceCents !== undefined
          ? { priceCents: parsed.data.priceCents }
          : {}),
        ...(parsed.data.quantity !== undefined ? { quantity: parsed.data.quantity } : {}),
        ...(parsed.data.sortOrder !== undefined
          ? { sortOrder: parsed.data.sortOrder }
          : {}),
      })
      if (!updated) {
        throw new ApiError({
          code: 'ticket_not_found',
          message: 'Ticket not found.',
          status: 404,
        })
      }
      await recordActivity(c, event.id, 'event.ticket_patched', {
        ticket_id: ticketId,
      })
      return c.json(serializeTicket(updated))
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw errors.conflict(
          'ticket_name_taken',
          'A ticket tier with that name already exists.',
        )
      }
      throw err
    }
  })

  // ── delete (editor+) ───────────────────────────────────────────────
  // Soft-delete; 409 if sold_count > 0. Sold tiers can't disappear
  // from the audit trail — the owner can rename / hide them but
  // can't delete sales-historical rows.
  .delete('/api/v1/ui/events/:id/tickets/:ticketId', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const ticketId = requireIdPrefix(c.req.param('ticketId'), 'evt_')

    const existing = await c.var.repos.tickets.findById(ticketId)
    if (!existing || existing.eventId !== event.id) {
      throw new ApiError({
        code: 'ticket_not_found',
        message: 'Ticket not found.',
        status: 404,
      })
    }

    const result = await c.var.repos.tickets.softDelete(ticketId, new Date())
    if (result === 'not_found') {
      throw new ApiError({
        code: 'ticket_not_found',
        message: 'Ticket not found.',
        status: 404,
      })
    }
    if (result === 'sold') {
      throw errors.conflict(
        'ticket_has_sales',
        'This tier has sales and cannot be deleted.',
      )
    }
    await recordActivity(c, event.id, 'event.ticket_deleted', { ticket_id: ticketId })
    return c.body(null, 204)
  })

  // ── restore (editor+) ──────────────────────────────────────────────
  .post('/api/v1/ui/events/:id/tickets/:ticketId/restore', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const ticketId = requireIdPrefix(c.req.param('ticketId'), 'evt_')

    const existing = await c.var.repos.tickets.findById(ticketId)
    if (!existing || existing.eventId !== event.id) {
      throw new ApiError({
        code: 'ticket_not_found',
        message: 'Ticket not found.',
        status: 404,
      })
    }
    const restored = await c.var.repos.tickets.restore(ticketId)
    if (!restored) {
      throw new ApiError({
        code: 'ticket_not_found',
        message: 'Ticket not found.',
        status: 404,
      })
    }
    await recordActivity(c, event.id, 'event.ticket_restored', {
      ticket_id: ticketId,
    })
    return c.json(serializeTicket(restored))
  })
