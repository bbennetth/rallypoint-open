import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  createMetricSchema,
  metricKindDef,
  metricValueOutOfScale,
  patchMetricSchema,
  type MetricDto,
} from '@rallypoint/fitness-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { MetricRecord } from '../repos/types.js'
import { idempotentCreate } from '../lib/idempotent-create.js'
import { readJsonBody } from './_body.js'
import { parseDateRangeQuery } from './_query.js'

// The body/health metric time-series UI surface (cookie + CSRF +
// session gated in build-app). Scope every read/write to the actor's own rows.

function toDto(r: MetricRecord): MetricDto {
  return {
    id: r.id,
    recordedAt: r.recordedAt.toISOString(),
    kind: r.kind,
    value: r.value,
    unit: r.unit,
    note: r.note,
    ref: r.ref,
    createdAt: r.createdAt.toISOString(),
  }
}

export const metricsRoutes = new Hono<HonoApp>()
  // --- create --------------------------------------------------------
  .post('/api/v1/ui/metrics', async (c) => {
    const userId = c.var.session!.userId
    const parsed = createMetricSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    const ref = body.ref ?? null
    const metricCreate: Parameters<typeof c.var.repos.metrics.create>[0] = {
      id: `fm_${ulid()}`,
      userId,
      recordedAt: new Date(body.recordedAt),
      kind: body.kind,
      value: body.value,
      ref,
    }
    if (body.unit !== undefined) metricCreate.unit = body.unit
    if (body.note !== undefined) metricCreate.note = body.note

    const { row, idempotent } = await idempotentCreate({
      ref,
      findByRef: () =>
        ref === null ? Promise.resolve(null) : c.var.repos.metrics.findByUserAndRef(userId, ref),
      create: () => c.var.repos.metrics.create(metricCreate),
    })
    if (idempotent) return c.json({ ...toDto(row), idempotent: true }, 200)
    return c.json(toDto(row), 201)
  })
  // --- list ----------------------------------------------------------
  .get('/api/v1/ui/metrics', async (c) => {
    const userId = c.var.session!.userId
    const url = new URL(c.req.url)
    const kindParam = url.searchParams.get('kind')
    const limitParam = url.searchParams.get('limit')

    const filter: { kind?: string; from?: Date; to?: Date; limit?: number } =
      parseDateRangeQuery(url)
    if (kindParam) filter.kind = kindParam
    if (limitParam) {
      const n = parseInt(limitParam, 10)
      if (!isNaN(n) && n > 0) filter.limit = n
    }

    const rows = await c.var.repos.metrics.listForActor(userId, filter)
    return c.json({ metrics: rows.map(toDto) })
  })
  // --- patch ---------------------------------------------------------
  .patch('/api/v1/ui/metrics/:id', async (c) => {
    const userId = c.var.session!.userId
    const parsed = patchMetricSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    // Patch doesn't carry `kind` — the row already has one. When the user
    // is updating `value`, enforce the curated scale (soreness 1-10 etc.)
    // against the existing row's kind so a raw PATCH can't sneak an
    // out-of-band reading past the create-time superRefine.
    if (body.value !== undefined) {
      const existing = await c.var.repos.metrics.getForActor(userId, c.req.param('id'))
      if (!existing) throw errors.notFound('Metric not found.')
      if (metricValueOutOfScale(existing.kind, body.value)) {
        const scale = metricKindDef(existing.kind)!.scale!
        throw errors.validation({
          issues: [
            {
              code: 'custom',
              path: ['value'],
              message: `value out of scale (${scale.min}-${scale.max}) for kind "${existing.kind}"`,
            },
          ],
        })
      }
    }

    const fields: import('../repos/types.js').PatchMetricFields = {}
    if (body.recordedAt !== undefined) fields.recordedAt = new Date(body.recordedAt)
    if (body.value !== undefined) fields.value = body.value
    if ('unit' in body) fields.unit = body.unit ?? null
    if ('note' in body) fields.note = body.note ?? null

    const updated = await c.var.repos.metrics.update(userId, c.req.param('id'), fields)
    if (!updated) throw errors.notFound('Metric not found.')
    return c.json(toDto(updated))
  })
  // --- delete --------------------------------------------------------
  .delete('/api/v1/ui/metrics/:id', async (c) => {
    const userId = c.var.session!.userId
    const ok = await c.var.repos.metrics.delete(userId, c.req.param('id'))
    if (!ok) throw errors.notFound('Metric not found.')
    return c.json({ ok: true })
  })
