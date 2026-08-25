import { Hono } from 'hono'
import { z } from 'zod'
import { artistMbReviewStatusSchema } from '@rallypoint/events-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { readJsonBody } from './_body.js'
import { artistListCursorCodec, artistReviewCursorCodec } from '../lib/artist-review-cursor.js'

// MusicBrainz artist-catalog sweep — thin proxies to events-api's
// EventsRPC adminArtistMb* methods over the EVENTS service binding (same
// trust model as system-events.ts: requireSession + requireAdmin here,
// actor re-checked against events-api's ADMIN_USER_IDS). No AI anywhere:
// matching is deterministic (pinned mbid or strict name match) and
// proposals only ever fill currently-null fields.

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

function forbidden(): never {
  throw errors.forbidden()
}

const listQueryLimitSchema = z.coerce.number().int().min(1).max(100)

export const artistReviewRoutes = new Hono<HonoApp>()
  // --- catalog table: list + inline edit -------------------------------
  .get('/api/v1/ui/artists', async (c) => {
    const q = c.req.query('q')
    const rawCursor = c.req.query('cursor')
    const rawLimit = c.req.query('limit')
    let limit: number | undefined
    if (rawLimit !== undefined) {
      const parsed = listQueryLimitSchema.safeParse(rawLimit)
      if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
      limit = parsed.data
    }
    let cursor: { name: string; id: string } | null = null
    if (rawCursor) {
      cursor = artistListCursorCodec.decode(rawCursor)
      if (!cursor) {
        throw errors.validation({
          issues: [{ code: 'custom', path: ['cursor'], message: 'Invalid cursor.' }],
        })
      }
    }
    const res = await c.var.services.systemEvents.listArtists(c.var.session!.userId, {
      ...(q ? { q } : {}),
      cursor,
      ...(limit !== undefined ? { limit } : {}),
    })
    if (res.kind !== 'ok') forbidden()
    const nextOpaque = res.data.nextCursor ? artistListCursorCodec.encode(res.data.nextCursor) : null
    return c.json({ items: res.data.items, nextCursor: nextOpaque })
  })

  .patch('/api/v1/ui/artists/:id', async (c) => {
    const res = await c.var.services.systemEvents.patchArtist(
      c.var.session!.userId,
      c.req.param('id'),
      await readJsonBody(c),
    )
    if (res.kind === 'forbidden') forbidden()
    if (res.kind === 'not_found') throw errors.notFound('Artist not found.')
    if (res.kind === 'invalid') {
      throw errors.validation({
        issues: res.issues.map((i) => ({
          code: 'custom' as const,
          path: i.path ? i.path.split('.') : [],
          message: i.message,
        })),
      })
    }
    if (res.kind === 'conflict') {
      throw errors.conflict('artist_name_taken', 'An artist with that name already exists.')
    }
    return c.json(res.data)
  })

  // Run a single-artist review (per-row "Check MusicBrainz" button).
  .post('/api/v1/ui/artists/:id/mb-review', async (c) => {
    const res = await c.var.services.systemEvents.artistMbReview(
      c.var.session!.userId,
      c.req.param('id'),
    )
    if (res.kind !== 'ok') forbidden()
    if (res.data.outcome === 'not_found') throw errors.notFound('Artist not found.')
    return c.json(res.data)
  })

  .post('/api/v1/ui/artist-mb-reviews/batch', async (c) => {
    const parsed = batchBodySchema.safeParse(await readJsonBodyOrEmpty(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    // Decode the opaque (or legacy bare-id) cursor to the raw artist id the
    // events RPC keysets on — opacity is an edge property; the RPC stays raw.
    let rpcCursor: string | null = null
    if (parsed.data.cursor) {
      const decoded = artistReviewCursorCodec.decode(parsed.data.cursor)
      if (!decoded) {
        throw errors.validation({
          issues: [{ code: 'custom', path: ['cursor'], message: 'Invalid cursor.' }],
        })
      }
      rpcCursor = decoded.id
    }
    const res = await c.var.services.systemEvents.artistMbSweepBatch(c.var.session!.userId, {
      cursor: rpcCursor,
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
    })
    if (res.kind !== 'ok') forbidden()
    const nextOpaque = res.data.nextCursor
      ? artistReviewCursorCodec.encode({ id: res.data.nextCursor })
      : null
    return c.json({ ...res.data, nextCursor: nextOpaque })
  })

  .get('/api/v1/ui/artist-mb-reviews', async (c) => {
    const raw = c.req.query('status') ?? 'pending'
    const parsed = artistMbReviewStatusSchema.safeParse(raw)
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const res = await c.var.services.systemEvents.listArtistMbReviews(c.var.session!.userId, {
      status: parsed.data,
    })
    if (res.kind !== 'ok') forbidden()
    return c.json({ items: res.data })
  })

  .post('/api/v1/ui/artist-mb-reviews/:id/apply', async (c) => {
    const res = await c.var.services.systemEvents.applyArtistMbReview(
      c.var.session!.userId,
      c.req.param('id'),
    )
    if (res.kind === 'forbidden') forbidden()
    if (res.kind === 'not_found') throw errors.notFound('MB review not found.')
    if (res.kind === 'not_pending') {
      throw errors.conflict('mb_review_not_pending', 'That proposal has already been decided.')
    }
    return c.json(res.data)
  })

  .post('/api/v1/ui/artist-mb-reviews/:id/dismiss', async (c) => {
    const res = await c.var.services.systemEvents.dismissArtistMbReview(
      c.var.session!.userId,
      c.req.param('id'),
    )
    if (res.kind === 'forbidden') forbidden()
    if (res.kind === 'not_found') throw errors.notFound('MB review not found.')
    if (res.kind === 'not_pending') {
      throw errors.conflict('mb_review_not_pending', 'That proposal has already been decided.')
    }
    return c.json(res.data)
  })

  // Always 200: per-id failures (already decided / deleted) come back as
  // outcomes in the result body, not as an HTTP error for the batch.
  .post('/api/v1/ui/artist-mb-reviews/bulk', async (c) => {
    const parsed = bulkDecideBodySchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const res = await c.var.services.systemEvents.bulkDecideArtistMbReviews(
      c.var.session!.userId,
      parsed.data.ids,
      parsed.data.action,
    )
    if (res.kind !== 'ok') forbidden()
    return c.json(res.data)
  })

async function readJsonBodyOrEmpty(c: Parameters<typeof readJsonBody>[0]): Promise<unknown> {
  try {
    return await readJsonBody(c)
  } catch {
    return {}
  }
}
