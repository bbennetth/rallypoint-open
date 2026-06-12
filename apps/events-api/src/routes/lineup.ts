import { Hono } from 'hono'
import type { Context } from 'hono'
import { ulid } from 'ulid'
import {
  CreateStageSchema,
  PatchStageSchema,
  CreateDaySchema,
  PatchDaySchema,
  CreateArtistSchema,
  PatchArtistSchema,
  LineupSlotSchema,
  BulkLineupSchema,
  GenerateDaysSchema,
  generateDays,
  type LineupSlotBody,
} from '@rallypoint/events-shared'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { UniqueConstraintError } from '../repos/errors.js'
import type {
  ArtistRecord,
  DayRecord,
  EventArtistRecord,
  StageRecord,
} from '../repos/types.js'
import { readJsonBody, readOptionalJsonBody } from './_body.js'
import { loadForAction, recordActivity } from './_access.js'
import { assertFeatureEnabled } from './_features.js'
import { captureSnapshot } from './_snapshots.js'
import { publish } from '../realtime/publish.js'
import { eventChannel, envelope } from '../realtime/channels.js'

const ARTIST_SEARCH_LIMIT = 20

function serializeStage(s: StageRecord): Record<string, unknown> {
  return { id: s.id, event_id: s.eventId, name: s.name, sort_order: s.sortOrder }
}

function serializeDay(d: DayRecord): Record<string, unknown> {
  return {
    id: d.id,
    event_id: d.eventId,
    day_label: d.dayLabel,
    date: d.date,
    start_time: d.startTime,
    end_time: d.endTime,
    sort_order: d.sortOrder,
  }
}

function serializeArtist(a: ArtistRecord): Record<string, unknown> {
  return {
    id: a.id,
    name: a.name,
    soundcloud: a.soundcloud,
    spotify: a.spotify,
    apple_music: a.appleMusic,
    youtube_music: a.youtubeMusic,
    instagram: a.instagram,
    updated_at: a.updatedAt.toISOString(),
  }
}

function serializeSlot(
  s: EventArtistRecord,
  artistName: string | null = null,
): Record<string, unknown> {
  return {
    event_id: s.eventId,
    artist_id: s.artistId,
    // Canonical catalog name, so read clients (attendee lineup, editor
    // grid) can label a slot without a separate catalog lookup. Distinct
    // from display_name, which is an optional per-slot override.
    artist_name: artistName,
    day_id: s.dayId,
    stage_id: s.stageId,
    tier: s.tier,
    genre: s.genre,
    start_time: s.startTime,
    end_time: s.endTime,
    display_name: s.displayName,
  }
}

// Resolve catalog names for a set of slots in one pass (deduped), so the
// serialized lineup can carry artist_name without N+1 lookups per render.
async function slotArtistNames(
  repo: { findById(id: string): Promise<{ name: string } | null> },
  slots: EventArtistRecord[],
): Promise<Map<string, string>> {
  const ids = [...new Set(slots.map((s) => s.artistId))]
  const found = await Promise.all(
    ids.map(async (id) => [id, (await repo.findById(id))?.name ?? null] as const),
  )
  const names = new Map<string, string>()
  for (const [id, name] of found) if (name) names.set(id, name)
  return names
}

function badRequest(code: string, message: string): ApiError {
  return new ApiError({ code, message, status: 400 })
}

// Fire-and-forget invalidation on the event channel: stages, days, and slots
// all render in the lineup viewer, so any of them changing tells subscribers
// to refetch the lineup. authorId suppresses the actor's own echo.
// (Phase 4: was lineupChannel; collapsed into eventChannel.)
function publishLineup(
  c: Context<HonoApp>,
  eventId: string,
  resource: string,
  operation: 'create' | 'update' | 'delete',
  id: string,
): void {
  publish(c, eventChannel(eventId), envelope(resource, operation, id, c.var.session!.userId))
}

export const lineupRoutes = new Hono<HonoApp>()
  // --- stages ------------------------------------------------------
  .post('/api/v1/ui/events/:id/stages', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const parsed = CreateStageSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    try {
      const stage = await c.var.repos.stages.create({
        id: `evs_${ulid()}`,
        eventId: event.id,
        name: parsed.data.name,
        sortOrder: parsed.data.sortOrder,
      })
      await recordActivity(c, event.id, 'event.stage_created', { stage_id: stage.id })
      publishLineup(c, event.id, 'stages', 'create', stage.id)
      return c.json(serializeStage(stage), 201)
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw errors.conflict('stage_name_taken', 'A stage with that name already exists.')
      }
      throw err
    }
  })
  .get('/api/v1/ui/events/:id/stages', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'viewer')
    const stages = await c.var.repos.stages.listForEvent(event.id)
    return c.json({ items: stages.map(serializeStage) })
  })
  .patch('/api/v1/ui/events/:id/stages/:stageId', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const stage = await c.var.repos.stages.findById(c.req.param('stageId'))
    if (!stage || stage.eventId !== event.id) throw errors.notFound('Stage not found.')
    const parsed = PatchStageSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    try {
      const updated = await c.var.repos.stages.update(stage.id, parsed.data)
      await recordActivity(c, event.id, 'event.stage_updated', { stage_id: stage.id })
      publishLineup(c, event.id, 'stages', 'update', stage.id)
      return c.json(serializeStage(updated!))
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw errors.conflict('stage_name_taken', 'A stage with that name already exists.')
      }
      throw err
    }
  })
  .delete('/api/v1/ui/events/:id/stages/:stageId', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const stage = await c.var.repos.stages.findById(c.req.param('stageId'))
    if (!stage || stage.eventId !== event.id) throw errors.notFound('Stage not found.')
    await c.var.repos.stages.delete(stage.id)
    await recordActivity(c, event.id, 'event.stage_deleted', { stage_id: stage.id })
    publishLineup(c, event.id, 'stages', 'delete', stage.id)
    return c.body(null, 204)
  })

  // --- days --------------------------------------------------------
  .post('/api/v1/ui/events/:id/days', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const parsed = CreateDaySchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    try {
      const day = await c.var.repos.days.create({
        id: `evd_${ulid()}`,
        eventId: event.id,
        dayLabel: parsed.data.dayLabel,
        date: parsed.data.date,
        startTime: parsed.data.startTime,
        endTime: parsed.data.endTime,
        sortOrder: parsed.data.sortOrder,
      })
      await recordActivity(c, event.id, 'event.day_created', { day_id: day.id })
      publishLineup(c, event.id, 'days', 'create', day.id)
      return c.json(serializeDay(day), 201)
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw errors.conflict('day_taken', 'A day with that label or date already exists.')
      }
      throw err
    }
  })
  .get('/api/v1/ui/events/:id/days', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'viewer')
    const days = await c.var.repos.days.listForEvent(event.id)
    return c.json({ items: days.map(serializeDay) })
  })
  .patch('/api/v1/ui/events/:id/days/:dayId', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const day = await c.var.repos.days.findById(c.req.param('dayId'))
    if (!day || day.eventId !== event.id) throw errors.notFound('Day not found.')
    const parsed = PatchDaySchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    try {
      const updated = await c.var.repos.days.update(day.id, parsed.data)
      await recordActivity(c, event.id, 'event.day_updated', { day_id: day.id })
      publishLineup(c, event.id, 'days', 'update', day.id)
      return c.json(serializeDay(updated!))
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw errors.conflict('day_taken', 'A day with that label or date already exists.')
      }
      throw err
    }
  })
  .delete('/api/v1/ui/events/:id/days/:dayId', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const day = await c.var.repos.days.findById(c.req.param('dayId'))
    if (!day || day.eventId !== event.id) throw errors.notFound('Day not found.')
    // event_artists.day_id ON DELETE CASCADE drops any slots on this day.
    await c.var.repos.days.delete(day.id)
    await recordActivity(c, event.id, 'event.day_deleted', { day_id: day.id })
    publishLineup(c, event.id, 'days', 'delete', day.id)
    return c.body(null, 204)
  })
  // Quick-create days from the event's date range (issue #191). Body is
  // optional ({} or empty): a supplied startDate/endDate overrides the
  // event's own dates. Idempotent — dates already present are skipped, so
  // re-running only adds the gap. Returns just the newly-created days.
  .post('/api/v1/ui/events/:id/days/generate', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const parsed = GenerateDaysSchema.safeParse(await readOptionalJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const startDate = parsed.data.startDate ?? event.startDate
    const endDate = parsed.data.endDate ?? event.endDate
    if (!startDate || !endDate) {
      throw badRequest(
        'event_dates_missing',
        'Set the event start and end dates first, or pass a date range.',
      )
    }
    // Validate the EFFECTIVE pair after fallback — the schema only checks
    // the body, so a lone startDate override against the event's earlier
    // endDate (or vice-versa) would otherwise invert the range and no-op
    // silently. 'YYYY-MM-DD' strings order lexically.
    if (endDate < startDate) {
      throw badRequest('invalid_date_range', 'End date must be on or after the start date.')
    }
    const existing = await c.var.repos.days.listForEvent(event.id)
    // Continue "Day N" numbering past the highest existing Day-N LABEL, not
    // the row count — a manually-added "Day 2" as the only day would make a
    // count-based start collide on the unique (event_id, day_label) index.
    const maxDayNum = existing.reduce((m, d) => {
      const mm = /^Day (\d+)$/.exec(d.dayLabel)
      return mm ? Math.max(m, Number(mm[1])) : m
    }, 0)
    const generated = generateDays({
      startDate,
      endDate,
      existing: existing.map((d) => d.date),
      startIndex: maxDayNum + 1,
    })
    if (generated.length === 0) return c.json({ items: [] }, 200)
    // Continue sort_order after the highest existing day so generated days
    // sort after any manually-added ones.
    const maxSort = existing.reduce((m, d) => Math.max(m, d.sortOrder), -1)
    const rows = generated.map((g, i) => ({
      id: `evd_${ulid()}`,
      eventId: event.id,
      dayLabel: g.dayLabel,
      date: g.date,
      sortOrder: maxSort + 1 + i,
    }))
    try {
      const created = await c.var.repos.days.createMany(rows)
      await recordActivity(c, event.id, 'event.days_generated', { count: created.length })
      publishLineup(c, event.id, 'days', 'create', event.id)
      return c.json({ items: created.map(serializeDay) }, 201)
    } catch (err) {
      // Defense in depth: a label/date collision the pre-numbering didn't
      // foresee aborts the whole batch (createMany is one txn) — surface a
      // 409 rather than a 500.
      if (err instanceof UniqueConstraintError) {
        throw errors.conflict('day_taken', 'A day with that label or date already exists.')
      }
      throw err
    }
  })

  // --- artists (global catalog) ------------------------------------
  // The artist catalog is GLOBAL and cross-event (design §5.2): it has
  // no tenant/event scope, so these routes are gated by session only,
  // not by event role. Any signed-in user can search, find-or-create,
  // and edit catalog rows — the same collaborative model the
  // festival-planner registry used. Edit provenance / row-locking is a
  // deliberate follow-up (see PR), not an oversight.
  .get('/api/v1/ui/artists', async (c) => {
    const q = (c.req.query('q') ?? '').trim()
    if (q.length === 0) return c.json({ items: [] })
    const found = await c.var.repos.artists.search(q, ARTIST_SEARCH_LIMIT)
    return c.json({ items: found.map(serializeArtist) })
  })
  .post('/api/v1/ui/artists', async (c) => {
    const parsed = CreateArtistSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    // Find-or-create against unique(lower(name)). On a concurrent
    // insert the unique violation falls back to the now-existing row.
    const existing = await c.var.repos.artists.findByName(parsed.data.name)
    if (existing) return c.json(serializeArtist(existing), 200)
    try {
      const artist = await c.var.repos.artists.create({ id: `art_${ulid()}`, ...parsed.data })
      return c.json(serializeArtist(artist), 201)
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        const raced = await c.var.repos.artists.findByName(parsed.data.name)
        if (raced) return c.json(serializeArtist(raced), 200)
        // Lost the race then the winner vanished — surface a 409, never a 500.
        throw errors.conflict('artist_name_taken', 'An artist with that name already exists.')
      }
      throw err
    }
  })
  .patch('/api/v1/ui/artists/:artistId', async (c) => {
    const artist = await c.var.repos.artists.findById(c.req.param('artistId'))
    if (!artist) throw errors.notFound('Artist not found.')
    const parsed = PatchArtistSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    try {
      const updated = await c.var.repos.artists.update(artist.id, parsed.data)
      return c.json(serializeArtist(updated!))
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw errors.conflict('artist_name_taken', 'An artist with that name already exists.')
      }
      throw err
    }
  })

  // --- lineup slots (event_artists) --------------------------------
  .get('/api/v1/ui/events/:id/lineup', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'viewer')
    assertFeatureEnabled(event, role, 'lineup')
    const slots = await c.var.repos.eventArtists.listForEvent(event.id)
    const names = await slotArtistNames(c.var.repos.artists, slots)
    return c.json({ items: slots.map((s) => serializeSlot(s, names.get(s.artistId) ?? null)) })
  })
  .post('/api/v1/ui/events/:id/lineup', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'editor')
    assertFeatureEnabled(event, role, 'lineup')
    const parsed = LineupSlotSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const slot = await resolveSlot(c, event.id, parsed.data)
    const saved = await c.var.repos.eventArtists.upsert(slot)
    await recordActivity(c, event.id, 'event.lineup_updated', {
      artist_id: saved.artistId,
      day_id: saved.dayId,
    })
    publishLineup(c, event.id, 'event_artists', 'update', `${saved.artistId}:${saved.dayId}`)
    const artist = await c.var.repos.artists.findById(saved.artistId)
    return c.json(serializeSlot(saved, artist?.name ?? null), 200)
  })
  .post('/api/v1/ui/events/:id/lineup/bulk', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'editor')
    assertFeatureEnabled(event, role, 'lineup')
    const parsed = BulkLineupSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const slots: EventArtistRecord[] = []
    for (const raw of parsed.data.slots ?? []) slots.push(await resolveSlot(c, event.id, raw))
    const deletes = parsed.data.deletes ?? []
    // Capture a pre-apply version so a bad bulk edit can be reverted.
    // The grid restates the whole lineup each save, so every apply
    // overwrites — worth a snapshot regardless of deletes (#191 Phase 2).
    if (slots.length > 0 || deletes.length > 0) {
      await captureSnapshot(c, event.id, 'lineup', 'before bulk lineup edit', c.var.session!.userId)
    }
    const { upserted, deleted } = await c.var.repos.eventArtists.bulkApply(event.id, {
      upserts: slots,
      deletes,
    })
    await recordActivity(c, event.id, 'event.lineup_bulk_updated', {
      upserted: upserted.length,
      deleted,
    })
    publishLineup(c, event.id, 'event_artists', 'update', event.id)
    const names = await slotArtistNames(c.var.repos.artists, upserted)
    return c.json({ items: upserted.map((s) => serializeSlot(s, names.get(s.artistId) ?? null)) }, 200)
  })
  .delete('/api/v1/ui/events/:id/lineup/:artistId/:dayId', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'editor')
    assertFeatureEnabled(event, role, 'lineup')
    const removed = await c.var.repos.eventArtists.delete(
      event.id,
      c.req.param('artistId'),
      c.req.param('dayId'),
    )
    if (!removed) throw errors.notFound('Lineup entry not found.')
    await recordActivity(c, event.id, 'event.lineup_removed', {
      artist_id: c.req.param('artistId'),
      day_id: c.req.param('dayId'),
    })
    publishLineup(
      c,
      event.id,
      'event_artists',
      'delete',
      `${c.req.param('artistId')}:${c.req.param('dayId')}`,
    )
    return c.body(null, 204)
  })

// Validate a lineup slot's foreign references and build the record.
// The DB enforces existence, but NOT that the day/stage belong to THIS
// event — so we check that here to stop one event borrowing another's
// day or stage (which the composite key would otherwise allow).
async function resolveSlot(
  c: Context<HonoApp>,
  eventId: string,
  body: LineupSlotBody,
): Promise<EventArtistRecord> {
  const artist = await c.var.repos.artists.findById(body.artistId)
  if (!artist) throw badRequest('artist_not_found', 'Referenced artist does not exist.')

  const day = await c.var.repos.days.findById(body.dayId)
  if (!day || day.eventId !== eventId) {
    throw badRequest('day_not_in_event', 'Referenced day does not belong to this event.')
  }

  let stageId: string | null = null
  if (body.stageId != null) {
    const stage = await c.var.repos.stages.findById(body.stageId)
    if (!stage || stage.eventId !== eventId) {
      throw badRequest('stage_not_in_event', 'Referenced stage does not belong to this event.')
    }
    stageId = stage.id
  }

  return {
    eventId,
    artistId: body.artistId,
    dayId: body.dayId,
    stageId,
    tier: body.tier ?? null,
    genre: body.genre ?? null,
    startTime: body.startTime ?? null,
    endTime: body.endTime ?? null,
    displayName: body.displayName ?? null,
  }
}
