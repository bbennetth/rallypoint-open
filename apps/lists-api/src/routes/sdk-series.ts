import { Hono } from 'hono'
import { CreateSeriesSchema, UpdateSeriesSchema } from '@rallypoint/lists-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { ListItemSeriesRecord } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { loadListForActor } from './sdk-writes.js'

// Authenticated SDK write surface for recurring series.  Mounted under
// /api/v1/sdk/* (same requireSdkKey gate as sdk-lists).  The actor is read
// from the x-actor request header — a `user_<ulid>` asserted by the calling
// peer app (events-api / planner-api), which has already checked ownership.
// All responses are flat camelCase; deletedAt/tenantId are never surfaced.

function serializeSeriesDto(s: ListItemSeriesRecord): Record<string, unknown> {
  return {
    id: s.id,
    listId: s.listId,
    title: s.title,
    notes: s.notes,
    assignedTo: s.assignedTo,
    priority: s.priority,
    freq: s.freq,
    interval: s.interval,
    byDay: s.byDay,
    dtstart: s.dtstart,
    until: s.until,
    count: s.count,
    timeOfDay: s.timeOfDay,
    createdBy: s.createdBy,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }
}

// Expected format for an actor id: `user_` prefix + 26-character Crockford
// ULID alphabet (uppercase digits 0–9 and letters A–Z minus I, L, O, U).
// Case-insensitive: see the matching constant in sdk-writes.ts for the
// full rationale. Keep both copies co-located — do NOT extract a shared pkg.
const ACTOR_RE = /^user_[0-9A-HJKMNP-TV-Z]{26}$/i

// Read the x-actor header; throw 400 if absent or not in `user_<ulid>` format.
function requireActor(c: { req: { header(name: string): string | undefined } }): string {
  const raw = c.req.header('x-actor')
  if (!raw || raw.trim().length === 0) {
    throw errors.validation({ issues: [{ path: ['x-actor'], message: 'x-actor header is required.' }] })
  }
  const actor = raw.trim()
  if (!ACTOR_RE.test(actor)) {
    throw errors.validation({ issues: [{ path: ['x-actor'], message: 'x-actor must be a valid user id (user_<ulid>).' }] })
  }
  return actor
}

export const sdkSeriesRoutes = new Hono<HonoApp>()
  // --- create series for a list ------------------------------------
  .post('/api/v1/sdk/lists/:listId/series', async (c) => {
    const actor = requireActor(c)
    const listId = c.req.param('listId')
    // The list must exist and be live; its tenant is inherited by the
    // series + every projected occurrence (matches sdk-lists gating).
    const list = await c.var.repos.lists.findById(listId)
    if (!list || list.deletedAt) throw errors.listNotFound()
    const parsed = CreateSeriesSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const series = await c.var.repos.series.create(listId, parsed.data, actor, list.tenantId)
    return c.json(serializeSeriesDto(series), 201)
  })
  // --- list series for a list --------------------------------------
  .get('/api/v1/sdk/lists/:listId/series', async (c) => {
    const listId = c.req.param('listId')
    const rows = await c.var.repos.series.list(listId)
    return c.json(rows.map(serializeSeriesDto))
  })
  // --- update a series (rule + template) ---------------------------
  // Actor-scoped: the actor must be a member of the list the series
  // belongs to. Mirrors the loadListForActor() posture used by item/
  // field writes — a foreign or missing series looks identical to the
  // actor (opaque 404) so existence is never confirmed to a non-member.
  .patch('/api/v1/sdk/series/:seriesId', async (c) => {
    const actor = requireActor(c)
    const seriesId = c.req.param('seriesId')
    const parsed = UpdateSeriesSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    // Pre-read the series to obtain its listId for the access check.
    // If the series doesn't exist or is already deleted, surface the
    // same opaque 404 the update step would return (no info leak).
    const existing = await c.var.repos.series.findById(seriesId)
    if (!existing || existing.deletedAt) throw errors.notFound('Series not found.')
    // loadListForActor throws the standard listNotFound 404 when the
    // actor is not a member of the owning list's scope — same posture as
    // item and field writes. planner-api passes the real end-user actor,
    // so a legitimate owner/member call passes through unchanged.
    await loadListForActor(c, actor, existing.listId)
    const series = await c.var.repos.series.update(seriesId, parsed.data, actor)
    if (!series) throw errors.notFound('Series not found.')
    // `list_item_series` has no `updated_by` column yet (#266); log the
    // mutating actor so the change isn't silently unattributed in the
    // meantime.
    c.var.logger.info({ seriesId, actor }, 'series updated (sdk)')
    return c.json(serializeSeriesDto(series))
  })
  // --- delete a series ---------------------------------------------
  // Actor-scoped: same loadListForActor() guard as the PATCH above.
  .delete('/api/v1/sdk/series/:seriesId', async (c) => {
    const actor = requireActor(c)
    const seriesId = c.req.param('seriesId')
    // Pre-read to get the owning listId before we attempt the delete.
    const existing = await c.var.repos.series.findById(seriesId)
    if (!existing || existing.deletedAt) throw errors.notFound('Series not found.')
    await loadListForActor(c, actor, existing.listId)
    const deleted = await c.var.repos.series.softDelete(seriesId, actor)
    if (!deleted) throw errors.notFound('Series not found.')
    c.var.logger.info({ seriesId, actor }, 'series soft-deleted (sdk)')
    return new Response(null, { status: 204 })
  })
