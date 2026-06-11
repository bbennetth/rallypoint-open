import { Hono } from 'hono'
import { z } from 'zod'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { serializeListDto } from './sdk-lists.js'
import { requireActor, loadListForActor } from './sdk-writes.js'
import { readJsonBody } from './_body.js'

// SDK planner-pref surface — peer-app (Planner BFF) s2s calls.
// Gated by requireSdkKey in build-app; uses x-actor to identify the end user.
//
// PUT /api/v1/sdk/lists/:listId/planner-pref
//   — membership-checked (loadListForActor); upserts the actor's pref.
//
// GET /api/v1/sdk/planner-lists
//   — returns flagged, live, accessible lists as ListDto[].
//   Re-checks access at read time: a list the actor lost access to since
//   they set the flag silently drops out of the response.

const PlannerPrefSchema = z.object({ show: z.boolean() })

export const sdkPlannerPrefsRoutes = new Hono<HonoApp>()
  // --- set pref for a single list ------------------------------------
  .put('/api/v1/sdk/lists/:listId/planner-pref', async (c) => {
    const actor = requireActor(c)
    const list = await loadListForActor(c, actor, c.req.param('listId'))
    const parsed = PlannerPrefSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    await c.var.repos.listPlannerPrefs.upsert(actor, list.id, parsed.data.show)
    return new Response(null, { status: 204 })
  })

  // --- get all flagged (show=true) lists for the actor ---------------
  // Silently drops lists that the actor can no longer access (lost
  // membership, list soft-deleted). For list_group scopes, access is
  // re-checked via loadListForActor; opaque (Events group) scopes are
  // trusted to the caller (same posture as the read surface).
  .get('/api/v1/sdk/planner-lists', async (c) => {
    const actor = requireActor(c)
    const listIds = await c.var.repos.listPlannerPrefs.flaggedListIdsForActor(actor)
    if (listIds.length === 0) return c.json([])
    // Batch-fetch all lists in a single query to avoid N+1 round trips.
    const listRows = await c.var.repos.lists.findByIds(listIds)
    const results = []
    for (let i = 0; i < listIds.length; i++) {
      const list = listRows[i]!
      const listId = listIds[i]!
      // Drop hard-deleted or soft-deleted lists.
      if (!list || list.deletedAt) continue
      // Re-check access: for list_group scopes verify the actor is still a
      // member; for opaque scopes (Events group) trust the caller. We call
      // loadListForActor which throws on failure, so catch and skip.
      try {
        await loadListForActor(c, actor, listId)
      } catch {
        continue
      }
      results.push(serializeListDto(list))
    }
    return c.json(results)
  })
