import { Hono } from 'hono'
import { ulid } from 'ulid'
import { createFoodFavoriteSchema, type FoodFavoriteDto } from '@rallypoint/fitness-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { FoodFavoriteRecord } from '../repos/types.js'
import { readJsonBody } from './_body.js'

// Pinned quick-log templates. A pin is a SNAPSHOT of a diary row, so the
// create body carries the values rather than an entry id: the offline
// outbox can drain a pin long after the entry it came from was edited or
// deleted, and freeform/AI entries (no foodItemId) are pinnable too.
//
// Re-logging a pin is the client posting the snapshot to the existing
// /food/log route — there is no server-side quick-log endpoint, so the
// diary write keeps exactly one code path. Cookie + CSRF + session gated
// in build-app.

function favoriteToDto(r: FoodFavoriteRecord): FoodFavoriteDto {
  return {
    id: r.id,
    foodItemId: r.foodItemId,
    name: r.name,
    quantityGrams: r.quantityGrams,
    quantityUnit: r.quantityUnit,
    quantityAmount: r.quantityAmount,
    kcal: r.kcal,
    proteinG: r.proteinG,
    carbsG: r.carbsG,
    fatG: r.fatG,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
  }
}

export const foodFavoritesRoutes = new Hono<HonoApp>()
  .get('/api/v1/ui/food/favorites', async (c) => {
    const rows = await c.var.repos.foodFavorites.listForActor(c.var.session!.userId)
    return c.json({ favorites: rows.map(favoriteToDto) })
  })
  .post('/api/v1/ui/food/favorites', async (c) => {
    const userId = c.var.session!.userId
    const parsed = createFoodFavoriteSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    // Provenance only: unlike /food/log, an id the actor can't see is
    // dropped rather than a 404. The snapshot is self-sufficient, and a
    // pin queued offline shouldn't fail to drain because the cache row
    // it referenced went away in the meantime.
    let foodItemId: string | null = null
    if (body.foodItemId !== undefined) {
      const item = await c.var.repos.foodItems.getForActor(userId, body.foodItemId)
      foodItemId = item ? item.id : null
    }

    const { favorite, created } = await c.var.repos.foodFavorites.create({
      id: `ffav_${ulid()}`,
      userId,
      foodItemId,
      name: body.name,
      quantityGrams: body.quantityGrams ?? null,
      quantityUnit: body.quantityUnit ?? null,
      quantityAmount: body.quantityAmount ?? null,
      kcal: body.kcal,
      proteinG: body.proteinG,
      carbsG: body.carbsG,
      fatG: body.fatG,
      source: body.source,
    })
    // 200 on a dedupe hit so a double-pin (two devices, or a retried
    // outbox op) reads as "already pinned" rather than an error.
    return c.json({ favorite: favoriteToDto(favorite), created }, created ? 201 : 200)
  })
  .delete('/api/v1/ui/food/favorites/:id', async (c) => {
    const id = c.req.param('id')
    if (!id) {
      throw errors.validation({
        issues: [{ code: 'custom', path: ['id'], message: 'Missing favorite id.' }],
      })
    }
    const changed = await c.var.repos.foodFavorites.remove(c.var.session!.userId, id)
    return c.json({ id, pinned: false, changed })
  })
