import { Hono } from 'hono'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'

// Per-user exercise favorites (star/save). The catalog itself is the
// authoritative list of exercises; this surface only tracks which ones
// the actor has bookmarked. Cookie + CSRF + session gated in
// build-app.
//
// PUT to add, DELETE to remove, GET to list. PUT and DELETE are both
// idempotent — re-starring an already-starred row is a 200 with
// `{ changed: false }` so the client never has to special-case a
// "tried to add but it was already there" error.

export const favoritesRoutes = new Hono<HonoApp>()
  .get('/api/v1/ui/favorites/exercises', async (c) => {
    const userId = c.var.session!.userId
    const ids = await c.var.repos.exerciseFavorites.listForActor(userId)
    return c.json({ exerciseIds: ids })
  })
  .put('/api/v1/ui/favorites/exercises/:id', async (c) => {
    const userId = c.var.session!.userId
    const id = c.req.param('id')
    if (!id) {
      throw errors.validation({
        issues: [{ code: 'custom', path: ['id'], message: 'Missing exercise id.' }],
      })
    }
    // Guard against starring an exercise the actor can't see (curated
    // global or own custom). Anything else → 404, mirroring the
    // catalog-route contract.
    const exists = await c.var.repos.exercises.getForActor(userId, id)
    if (!exists) {
      throw errors.notFound('Exercise not found.')
    }
    const changed = await c.var.repos.exerciseFavorites.add(userId, id)
    return c.json({ exerciseId: id, starred: true, changed })
  })
  .delete('/api/v1/ui/favorites/exercises/:id', async (c) => {
    const userId = c.var.session!.userId
    const id = c.req.param('id')
    if (!id) {
      throw errors.validation({
        issues: [{ code: 'custom', path: ['id'], message: 'Missing exercise id.' }],
      })
    }
    const changed = await c.var.repos.exerciseFavorites.remove(userId, id)
    return c.json({ exerciseId: id, starred: false, changed })
  })
