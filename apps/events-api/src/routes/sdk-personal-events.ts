import { Hono } from 'hono'
import { ulid } from 'ulid'
import { CreatePersonalEventSchema, PatchPersonalEventSchema } from '@rallypoint/events-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { EventRecord, PatchEventInput } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { requireActor } from './_actor.js'

// Authenticated SDK write surface for personal (planner-owned) events.
// All routes live under /api/v1/sdk/personal-events and are gated by
// requireSdkKey (PLANNER_API_KEY bearer) in build-app.ts.
// The actor (ownerUserId) is read from the x-actor header — a
// `user_<ulid>` asserted by the calling Planner BFF peer.

const TENANT = 'rallypoint'

// Parse an optional ISO-instant query param into a Date; absent → null,
// present-but-unparseable → 400 (rather than letting an Invalid Date reach
// the DB and 500).
function parseInstantParam(raw: string | undefined, name: string): Date | null {
  if (raw === undefined) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) {
    throw errors.validation({
      issues: [{ path: [name], message: `${name} must be an ISO-8601 datetime.` }],
    })
  }
  return d
}

// Issue #545: resolve the effective all-day flag. Explicit DB value wins;
// null falls back to inference: no startAt → false (no time info);
// midnight UTC (or no time-of-day component) → true; any other time → false.
function effectiveAllDay(e: EventRecord): boolean {
  if (e.allDay !== null && e.allDay !== undefined) return e.allDay
  // Inference fallback for null rows (pre-migration data).
  if (!e.startAt) return false
  const iso = e.startAt.toISOString()
  // Date-only strings have no 'T' component. UTC midnight ends in T00:00:00.000Z.
  if (!iso.includes('T')) return true
  const timePart = iso.split('T')[1] ?? ''
  return timePart === '00:00:00.000Z'
}

// Flat camelCase DTO. tenantId and deletedAt are never surfaced to callers.
function serializePersonalEventDto(e: EventRecord): Record<string, unknown> {
  return {
    id: e.id,
    scopeType: e.scopeType,
    ownerUserId: e.ownerUserId,
    slug: e.slug,
    name: e.name,
    description: e.description,
    startAt: e.startAt?.toISOString() ?? null,
    endAt: e.endAt?.toISOString() ?? null,
    allDay: effectiveAllDay(e),
    timezone: e.timezone,
    locationLabel: e.locationLabel,
    privacyMode: e.privacyMode,
    ticketCount: e.ticketCount,
    ticketPlatform: e.ticketPlatform ?? null,
    ticketAccountEmail: e.ticketAccountEmail ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  }
}

export const sdkPersonalEventsRoutes = new Hono<HonoApp>()
  // --- create personal event -----------------------------------------
  .post('/api/v1/sdk/personal-events', async (c) => {
    const actor = requireActor(c)
    const parsed = CreatePersonalEventSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    const id = `event_${ulid()}`
    // Slug: personal-<ulid lowercase>. ULID is Crockford base32 (A-Z0-9 except
    // I, L, O, U) — lowercased it satisfies ^[a-z0-9]+(?:-[a-z0-9]+)*$.
    const slug = `personal-${ulid().toLowerCase()}`

    const record = await c.var.repos.events.create({
      id,
      tenantId: TENANT,
      ownerUserId: actor,
      slug,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      timezone: 'UTC',
      scopeType: 'personal',
      privacyMode: 'private',
      locationLabel: parsed.data.locationLabel ?? null,
      startAt: parsed.data.startAt ? new Date(parsed.data.startAt) : null,
      endAt: parsed.data.endAt ? new Date(parsed.data.endAt) : null,
      ticketPlatform: parsed.data.ticketPlatform ?? null,
      ticketAccountEmail: parsed.data.ticketAccountEmail ?? null,
      ...(parsed.data.allDay !== undefined ? { allDay: parsed.data.allDay } : {}),
    })

    return c.json(serializePersonalEventDto(record), 201)
  })

  // --- list personal events ------------------------------------------
  .get('/api/v1/sdk/personal-events', async (c) => {
    const actor = requireActor(c)
    // from/to are optional ISO-instant window bounds on start_at. Parse
    // strictly — a junk value would otherwise bind as an Invalid Date and
    // 500 in Postgres, so reject it at the boundary with a 400.
    const from = parseInstantParam(c.req.query('from'), 'from')
    const to = parseInstantParam(c.req.query('to'), 'to')

    const records = await c.var.repos.events.listPersonalForUser(actor, { from, to })
    return c.json(records.map(serializePersonalEventDto))
  })

  // --- get one personal event ----------------------------------------
  .get('/api/v1/sdk/personal-events/:id', async (c) => {
    const actor = requireActor(c)
    const id = c.req.param('id')
    const record = await c.var.repos.events.findById(id)

    // 404 for missing, soft-deleted, wrong scope, or another owner's event
    // — never distinguish which condition failed (same errors.notFound so
    // callers can't probe ownership or existence).
    if (
      !record ||
      record.deletedAt ||
      record.scopeType !== 'personal' ||
      record.ownerUserId !== actor
    ) {
      throw errors.notFound('Personal event not found.')
    }

    return c.json(serializePersonalEventDto(record))
  })

  // --- patch one personal event --------------------------------------
  // Same opaque ownership 404 as the GET-by-id read: a missing / deleted /
  // wrong-scope / other-owner id is indistinguishable. Only name /
  // description / startAt / endAt / locationLabel are patchable; the
  // instants are stored as Date columns.
  .patch('/api/v1/sdk/personal-events/:id', async (c) => {
    const actor = requireActor(c)
    const id = c.req.param('id')
    const parsed = PatchPersonalEventSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    const record = await c.var.repos.events.findById(id)
    if (
      !record ||
      record.deletedAt ||
      record.scopeType !== 'personal' ||
      record.ownerUserId !== actor
    ) {
      throw errors.notFound('Personal event not found.')
    }

    const fields: PatchEventInput = {}
    if (parsed.data.name !== undefined) fields.name = parsed.data.name
    if (parsed.data.description !== undefined) fields.description = parsed.data.description
    if (parsed.data.locationLabel !== undefined) fields.locationLabel = parsed.data.locationLabel
    if (parsed.data.startAt !== undefined)
      fields.startAt = parsed.data.startAt === null ? null : new Date(parsed.data.startAt)
    if (parsed.data.endAt !== undefined)
      fields.endAt = parsed.data.endAt === null ? null : new Date(parsed.data.endAt)
    if (parsed.data.ticketPlatform !== undefined) fields.ticketPlatform = parsed.data.ticketPlatform
    if (parsed.data.ticketAccountEmail !== undefined) fields.ticketAccountEmail = parsed.data.ticketAccountEmail
    if (parsed.data.allDay !== undefined) fields.allDay = parsed.data.allDay

    const updated = await c.var.repos.events.patch(id, fields)
    if (!updated) throw errors.notFound('Personal event not found.')
    return c.json(serializePersonalEventDto(updated))
  })

  // --- delete one personal event -------------------------------------
  // Soft-delete (the pruner hard-purges after the grace window). Same
  // opaque ownership 404 as the read.
  .delete('/api/v1/sdk/personal-events/:id', async (c) => {
    const actor = requireActor(c)
    const id = c.req.param('id')
    const record = await c.var.repos.events.findById(id)
    if (
      !record ||
      record.deletedAt ||
      record.scopeType !== 'personal' ||
      record.ownerUserId !== actor
    ) {
      throw errors.notFound('Personal event not found.')
    }
    await c.var.repos.events.softDelete(id, new Date())
    return c.body(null, 204)
  })
