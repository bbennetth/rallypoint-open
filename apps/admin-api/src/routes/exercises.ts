import { Hono } from 'hono'
import { z } from 'zod'
import {
  MUSCLE_GROUP_IDS,
  MUSCLE_IDS,
  disciplineSchema,
  exerciseAiReviewStatusSchema,
} from '@rallypoint/fitness-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { readJsonBody } from './_body.js'
import { aiReviewCursorCodec } from '../lib/ai-review-cursor.js'

// Admin exercise-catalog editor + AI muscle-map review pipeline — thin
// proxies to fitness-api's FitnessRPC over the FITNESS service binding.
// Access control (requireSession + requireAdmin) and CSRF/origin are
// mounted in build-app; validation of the patch body itself happens in
// fitness-api (shared adminUpdateExerciseSchema), so 'invalid' comes back
// as a marker rather than crossing the RPC boundary as a zod error.

const batchBodySchema = z.object({
  cursor: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(10).optional(),
})

// Bulk decide: max 200 ids bounds the sequential D1 round-trips inside a
// single Worker invocation.
const bulkDecideBodySchema = z.object({
  ids: z.array(z.string()).min(1).max(200),
  action: z.enum(['apply', 'dismiss']),
})

export const exerciseCatalogRoutes = new Hono<HonoApp>()
  // --- catalog list / detail / edit -----------------------------------
  .get('/api/v1/ui/exercises', async (c) => {
    const q = c.req.query('q')
    const group = c.req.query('group')
    const muscle = c.req.query('muscle')
    const discipline = c.req.query('discipline')
    if (group && !MUSCLE_GROUP_IDS.has(group)) {
      throw errors.validation({
        issues: [{ code: 'custom', path: ['group'], message: 'Unknown muscle group.' }],
      })
    }
    if (muscle && !MUSCLE_IDS.has(muscle)) {
      throw errors.validation({
        issues: [{ code: 'custom', path: ['muscle'], message: 'Unknown muscle.' }],
      })
    }
    if (discipline && !disciplineSchema.safeParse(discipline).success) {
      throw errors.validation({
        issues: [{ code: 'custom', path: ['discipline'], message: 'Unknown discipline.' }],
      })
    }
    const items = await c.var.services.exerciseCatalog.listExercises({
      ...(q ? { q } : {}),
      ...(group ? { group } : {}),
      ...(muscle ? { muscle } : {}),
      ...(discipline ? { discipline } : {}),
    })
    return c.json({ items })
  })

  .get('/api/v1/ui/exercises/:id', async (c) => {
    const item = await c.var.services.exerciseCatalog.getExercise(c.req.param('id'))
    if (!item) throw errors.notFound('Exercise not found.')
    return c.json(item)
  })

  .patch('/api/v1/ui/exercises/:id', async (c) => {
    const body = await readJsonBody(c)
    const item = await c.var.services.exerciseCatalog.updateExercise(c.req.param('id'), body)
    if (item === null) throw errors.notFound('Exercise not found.')
    if (item === 'invalid') {
      throw errors.validation({
        issues: [{ code: 'custom', path: [], message: 'Invalid exercise patch.' }],
      })
    }
    if (item === 'name_taken') {
      throw errors.conflict('exercise_name_taken', 'A global exercise with that name exists.')
    }
    return c.json(item)
  })

  // --- AI muscle-map review pipeline ----------------------------------
  .post('/api/v1/ui/exercises/:id/ai-review', async (c) => {
    const res = await c.var.services.exerciseCatalog.aiReviewExercise(c.req.param('id'), {
      actorUserId: c.var.session!.userId,
    })
    if (res.outcome === 'not_found') throw errors.notFound('Exercise not found.')
    if (res.outcome === 'ai_unavailable') {
      throw errors.upstreamUnavailable('The AI reviewer is not available in this deployment.')
    }
    return c.json(res)
  })

  .post('/api/v1/ui/ai-reviews/batch', async (c) => {
    const parsed = batchBodySchema.safeParse(await readJsonBodyOrEmpty(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    // Decode the opaque (or legacy bare-id) cursor to the raw exercise id the
    // fitness RPC keysets on — opacity is an edge property; the RPC stays raw.
    let rpcCursor: string | null = null
    if (parsed.data.cursor) {
      const decoded = aiReviewCursorCodec.decode(parsed.data.cursor)
      if (!decoded) {
        throw errors.validation({
          issues: [{ code: 'custom', path: ['cursor'], message: 'Invalid cursor.' }],
        })
      }
      rpcCursor = decoded.id
    }
    const res = await c.var.services.exerciseCatalog.aiReviewBatch({
      cursor: rpcCursor,
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      actorUserId: c.var.session!.userId,
    })
    if (res === 'ai_unavailable') {
      throw errors.upstreamUnavailable('The AI reviewer is not available in this deployment.')
    }
    // Re-encode the RPC's raw next id to the opaque form. Dual-emit `nextCursor`
    // (the pre-unification key) alongside `next_cursor` for one release so a
    // stale admin-web bundle keeps looping. TODO(remove nextCursor after the
    // admin-web cursor rollout has shipped).
    const nextOpaque = res.nextCursor ? aiReviewCursorCodec.encode({ id: res.nextCursor }) : null
    return c.json({ ...res, next_cursor: nextOpaque, nextCursor: nextOpaque })
  })

  .get('/api/v1/ui/ai-reviews', async (c) => {
    const raw = c.req.query('status') ?? 'pending'
    const parsed = exerciseAiReviewStatusSchema.safeParse(raw)
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const items = await c.var.services.exerciseCatalog.listAiReviews(parsed.data)
    return c.json({ items })
  })

  .post('/api/v1/ui/ai-reviews/:id/apply', async (c) => {
    const item = await c.var.services.exerciseCatalog.applyAiReview(c.req.param('id'))
    if (!item) throw errors.notFound('AI review not found.')
    if (item === 'not_pending') {
      throw errors.conflict('ai_review_not_pending', 'That proposal has already been decided.')
    }
    return c.json(item)
  })

  .post('/api/v1/ui/ai-reviews/:id/dismiss', async (c) => {
    const item = await c.var.services.exerciseCatalog.dismissAiReview(c.req.param('id'))
    if (!item) throw errors.notFound('AI review not found.')
    if (item === 'not_pending') {
      throw errors.conflict('ai_review_not_pending', 'That proposal has already been decided.')
    }
    return c.json(item)
  })

  // Always 200: per-id failures (already decided / deleted) come back as
  // outcomes in the result body, not as an HTTP error for the batch.
  .post('/api/v1/ui/ai-reviews/bulk', async (c) => {
    const parsed = bulkDecideBodySchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const result = await c.var.services.exerciseCatalog.bulkDecideAiReviews(
      parsed.data.ids,
      parsed.data.action,
    )
    return c.json(result)
  })

async function readJsonBodyOrEmpty(c: Parameters<typeof readJsonBody>[0]): Promise<unknown> {
  try {
    return await readJsonBody(c)
  } catch {
    return {}
  }
}
