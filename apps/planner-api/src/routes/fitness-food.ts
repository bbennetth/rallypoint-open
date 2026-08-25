import { Hono } from 'hono'
import { z } from 'zod'
import { createFoodLogEntrySchema } from '@rallypoint/fitness-client'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { readJsonBody } from './_body.js'

// Fitness food-diary write proxy — the save/Undo behind the AI Assist
// `food` category ("I ate 5 cherries"). Same shape as the events write
// proxy: planner-api owns NO food storage or rules; it resolves the actor
// from the planner session and forwards to fitness-api's FitnessRPC
// binding, which validates and inserts the actor-scoped diary row.
//
// The body is pre-validated here with the SHARED fitness schema (via
// @rallypoint/fitness-client) so bad input 400s with a planner validation
// envelope; the cache-contribution fields (saveAsCustom / saveAsUpc /
// foodItemId) are additionally rejected — they're HTTP-route-exclusive on
// the fitness side and have no cross-app story. An RPC failure after a
// valid body is an outage → 503.

function fitnessUnavailable(): ApiError {
  return new ApiError({
    code: 'fitness_unavailable',
    message: 'Food logging is not available right now.',
    status: 503,
  })
}

const ForbiddenProxyFields = ['saveAsCustom', 'saveAsUpc', 'foodItemId'] as const

export const fitnessFoodRoutes = new Hono<HonoApp>()
  // --- log one food-diary entry into fitness -------------------------
  .post('/api/v1/ui/fitness/food-log', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const raw = await readJsonBody(c)
    const parsed = createFoodLogEntrySchema.safeParse(raw)
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    for (const field of ForbiddenProxyFields) {
      if (parsed.data[field] !== undefined) {
        throw errors.validation({
          issues: [{ code: 'custom', path: [field], message: `${field} is not supported here.` }],
        })
      }
    }
    try {
      const entry = await c.var.services.fitnessClient.createFoodLogEntry({
        actor,
        entry: parsed.data,
      })
      return c.json(entry, 201)
    } catch (err) {
      c.var.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'fitness food-log create failed',
      )
      throw fitnessUnavailable()
    }
  })

  // --- undo: delete a just-created entry ------------------------------
  // Actor-scoped downstream — a foreign or unknown id resolves false → 404.
  .delete('/api/v1/ui/fitness/food-log/:id', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const id = z.string().min(1).max(60).safeParse(c.req.param('id'))
    if (!id.success) throw errors.validation({ issues: id.error.issues })
    let deleted: boolean
    try {
      deleted = await c.var.services.fitnessClient.deleteFoodLogEntry({ actor, id: id.data })
    } catch (err) {
      c.var.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'fitness food-log delete failed',
      )
      throw fitnessUnavailable()
    }
    if (!deleted) throw errors.notFound('Food log entry not found.')
    return c.body(null, 204)
  })
