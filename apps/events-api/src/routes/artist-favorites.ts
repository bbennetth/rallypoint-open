import { Hono } from 'hono'
import { ArtistFavoriteSchema } from '@rallypoint/events-shared'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { readJsonBody } from './_body.js'
import { loadForAction, recordActivity } from './_access.js'
import { assertFeatureEnabled } from './_features.js'

function badRequest(code: string, message: string): ApiError {
  return new ApiError({ code, message, status: 400 })
}

// Attendee artist-favorite routes. Favorites are per-user, per-ARTIST
// within an event — day-agnostic, unlike set stars: they work while the
// lineup is still all-TBA (no days configured) and survive a slot being
// rescheduled to another day.
//
//   POST   /api/v1/ui/events/:id/lineup/favorites — favorite an artist (idempotent)
//   DELETE /api/v1/ui/events/:id/lineup/favorites — unfavorite
//   GET    /api/v1/ui/events/:id/lineup/favorites — list favorited artist keys
//
// Auth: viewer-level (any authenticated user who can see the event).
// The body for POST/DELETE: { artistId }.

export const artistFavoritesRoutes = new Hono<HonoApp>()
  // --- GET list favorited artists -----------------------------------
  .get('/api/v1/ui/events/:id/lineup/favorites', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'viewer')
    assertFeatureEnabled(event, role, 'lineup')
    const userId = c.var.session!.userId
    const favorites = await c.var.repos.eventArtistFavorites.listForUserEvent(userId, event.id)
    return c.json({
      items: favorites.map((f) => ({
        event_id: f.eventId,
        artist_id: f.artistId,
      })),
    })
  })

  // --- POST favorite an artist --------------------------------------
  // The FK only ties the favorite to the artist catalog, so pre-check
  // that the artist actually appears on THIS event's lineup (any day,
  // including TBA rows) — otherwise any catalog artist id could be
  // favorited onto any event.
  .post('/api/v1/ui/events/:id/lineup/favorites', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'viewer')
    assertFeatureEnabled(event, role, 'lineup')
    const parsed = ArtistFavoriteSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { artistId } = parsed.data

    const slots = await c.var.repos.eventArtists.listForEvent(event.id)
    if (!slots.some((s) => s.artistId === artistId)) {
      throw badRequest('artist_not_in_event', 'Referenced artist is not on this event lineup.')
    }

    const userId = c.var.session!.userId
    const changed = await c.var.repos.eventArtistFavorites.favorite(userId, {
      eventId: event.id,
      artistId,
    })
    await recordActivity(c, event.id, 'event.artist_favorited', {
      artist_id: artistId,
      changed,
    })
    return c.json({
      event_id: event.id,
      artist_id: artistId,
      favorited: true,
    })
  })

  // --- DELETE unfavorite an artist ----------------------------------
  .delete('/api/v1/ui/events/:id/lineup/favorites', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'viewer')
    assertFeatureEnabled(event, role, 'lineup')
    const parsed = ArtistFavoriteSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { artistId } = parsed.data

    const userId = c.var.session!.userId
    const changed = await c.var.repos.eventArtistFavorites.unfavorite(userId, {
      eventId: event.id,
      artistId,
    })
    await recordActivity(c, event.id, 'event.artist_unfavorited', {
      artist_id: artistId,
      changed,
    })
    return c.json({
      event_id: event.id,
      artist_id: artistId,
      favorited: false,
    })
  })
