import { Hono } from 'hono'
import { SetStarSchema } from '@rallypoint/events-shared'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { readJsonBody } from './_body.js'
import { loadForAction, recordActivity } from './_access.js'
import { assertFeatureEnabled } from './_features.js'

function badRequest(code: string, message: string): ApiError {
  return new ApiError({ code, message, status: 400 })
}

// Attendee set-star routes (issue #194). Stars are per-user, per-set.
// A "set" = an event_artists row identified by (event_id, artist_id,
// day_id). Any viewer (attendee) can star/unstar.
//
//   POST   /api/v1/ui/events/:id/lineup/stars   — star a set (idempotent)
//   DELETE /api/v1/ui/events/:id/lineup/stars   — unstar a set
//   GET    /api/v1/ui/events/:id/lineup/stars   — list starred set keys for the user
//
// Auth: viewer-level (any authenticated user who can see the event).
// The body for POST/DELETE: { artistId, dayId }.

export const setStarsRoutes = new Hono<HonoApp>()
  // --- GET list starred sets ----------------------------------------
  .get('/api/v1/ui/events/:id/lineup/stars', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'viewer')
    assertFeatureEnabled(event, role, 'lineup')
    const userId = c.var.session!.userId
    const stars = await c.var.repos.eventSetStars.listForUserEvent(userId, event.id)
    return c.json({
      items: stars.map((s) => ({
        event_id: s.eventId,
        artist_id: s.artistId,
        day_id: s.dayId,
      })),
    })
  })

  // --- POST star a set ----------------------------------------------
  // A star must point at a lineup slot (event_artists row) that actually
  // exists in THIS event: the DB enforces it with a composite FK, and we
  // pre-check here so a missing slot returns a clean 400 (not an FK
  // violation 500) and the in-memory repo behaves the same. This stops
  // phantom stars on never-added slots and, via the FK's ON DELETE
  // CASCADE, drops a star if its slot is later removed from the lineup.
  .post('/api/v1/ui/events/:id/lineup/stars', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'viewer')
    assertFeatureEnabled(event, role, 'lineup')
    const parsed = SetStarSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { artistId, dayId } = parsed.data

    // Verify the day belongs to this event (same guard as lineup.ts slot writes).
    const day = await c.var.repos.days.findById(dayId)
    if (!day || day.eventId !== event.id) {
      throw badRequest('day_not_in_event', 'Referenced day does not belong to this event.')
    }
    // Verify the lineup slot exists for this event before starring it.
    const slot = await c.var.repos.eventArtists.find(event.id, artistId, dayId)
    if (!slot) {
      throw badRequest('set_not_in_event', 'Referenced lineup set does not exist for this event.')
    }

    const userId = c.var.session!.userId
    const changed = await c.var.repos.eventSetStars.star(userId, {
      eventId: event.id,
      artistId,
      dayId,
    })
    await recordActivity(c, event.id, 'event.set_starred', {
      artist_id: artistId,
      day_id: dayId,
      changed,
    })
    return c.json({
      event_id: event.id,
      artist_id: artistId,
      day_id: dayId,
      starred: true,
    })
  })

  // --- DELETE unstar a set ------------------------------------------
  .delete('/api/v1/ui/events/:id/lineup/stars', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'viewer')
    assertFeatureEnabled(event, role, 'lineup')
    const parsed = SetStarSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { artistId, dayId } = parsed.data

    const userId = c.var.session!.userId
    const changed = await c.var.repos.eventSetStars.unstar(userId, {
      eventId: event.id,
      artistId,
      dayId,
    })
    await recordActivity(c, event.id, 'event.set_unstarred', {
      artist_id: artistId,
      day_id: dayId,
      changed,
    })
    return c.json({
      event_id: event.id,
      artist_id: artistId,
      day_id: dayId,
      starred: false,
    })
  })
