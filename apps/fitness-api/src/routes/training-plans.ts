import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  createTrainingPlanItemSchema,
  createTrainingPlanSchema,
  patchTrainingPlanItemSchema,
  patchTrainingPlanSchema,
  type TrainingPlanDto,
  type TrainingPlanItemDto,
} from '@rallypoint/fitness-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { UniqueConstraintError } from '@rallypoint/api-kit'
import type {
  PatchTrainingPlanItemFields,
  TrainingPlanItemRecord,
  TrainingPlanRecord,
} from '../repos/types.js'
import { idempotentCreate } from '../lib/idempotent-create.js'
import { readJsonBody } from './_body.js'

// Training-plan UI surface (Ink redesign S7). Cookie + CSRF + session
// gated in build-app. Each user can own multiple plans; items live
// under (planId, dayKey, position). Create is race-safe per-owner
// via find-or-create (mirrors `exercises` / `wod-templates`). Item
// CRUD is scoped to the plan's owner.

function planToDto(r: TrainingPlanRecord): TrainingPlanDto {
  return {
    id: r.id,
    name: r.name,
    lengthWeeks: r.lengthWeeks,
    ref: r.ref,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

function itemToDto(r: TrainingPlanItemRecord): TrainingPlanItemDto {
  return {
    id: r.id,
    planId: r.planId,
    dayKey: r.dayKey,
    position: r.position,
    sourceKind: r.sourceKind,
    sourceId: r.sourceId,
    note: r.note,
    ref: r.ref,
    createdAt: r.createdAt.toISOString(),
  }
}

export const trainingPlansRoutes = new Hono<HonoApp>()
  // --- plans -----------------------------------------------------------
  .get('/api/v1/ui/training-plans', async (c) => {
    const userId = c.var.session!.userId
    const rows = await c.var.repos.trainingPlans.listForActor(userId)
    return c.json({ trainingPlans: rows.map(planToDto) })
  })
  .post('/api/v1/ui/training-plans', async (c) => {
    const userId = c.var.session!.userId
    const raw = await readJsonBody(c)
    const parsed = createTrainingPlanSchema.safeParse(raw)
    if (!parsed.success) {
      throw errors.validation({ issues: parsed.error.issues })
    }
    const { name, lengthWeeks } = parsed.data
    const ref = parsed.data.ref ?? null

    // ref layering note (mirrors exercises.ts / wod-templates.ts): the
    // offline-create `ref` idempotency key is checked FIRST via
    // idempotentCreate; the pre-existing per-owner NAME find-or-create
    // (unrelated to offline retries) runs unchanged inside `create`. A
    // name collision can't be mistaken for a ref replay — see
    // apps/fitness-api/src/lib/idempotent-create.ts.
    let outcome: { record: TrainingPlanRecord; viaNameMatch: boolean; idempotent: boolean }
    try {
      const result = await idempotentCreate<{
        record: TrainingPlanRecord
        viaNameMatch: boolean
      }>({
        ref,
        findByRef: async () => {
          if (ref === null) return null
          const existing = await c.var.repos.trainingPlans.findByOwnerAndRef(userId, ref)
          return existing ? { record: existing, viaNameMatch: false } : null
        },
        create: async () => {
          // Race-safe find-or-create: re-POSTing the same name returns
          // 200 with the existing row instead of a 409. Matches the
          // exercises + wod-templates convention.
          const existingByName = await c.var.repos.trainingPlans.findByName(userId, name)
          if (existingByName) return { record: existingByName, viaNameMatch: true }
          const created = await c.var.repos.trainingPlans.create({
            id: `tpl_${ulid()}`,
            ownerUserId: userId,
            name,
            lengthWeeks: lengthWeeks ?? null,
            ref,
          })
          return { record: created, viaNameMatch: false }
        },
      })
      outcome = { ...result.row, idempotent: result.idempotent }
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        // Two POSTs raced past the find — return the winner.
        const winner = await c.var.repos.trainingPlans.findByName(userId, name)
        if (winner) return c.json({ trainingPlan: planToDto(winner) })
      }
      throw err
    }
    if (outcome.idempotent) {
      return c.json({ trainingPlan: planToDto(outcome.record), idempotent: true }, 200)
    }
    if (outcome.viaNameMatch) return c.json({ trainingPlan: planToDto(outcome.record) })
    return c.json({ trainingPlan: planToDto(outcome.record) }, 201)
  })
  .get('/api/v1/ui/training-plans/:id', async (c) => {
    const userId = c.var.session!.userId
    const row = await c.var.repos.trainingPlans.getForActor(userId, c.req.param('id'))
    if (!row) throw errors.notFound('Plan not found.')
    return c.json({ trainingPlan: planToDto(row) })
  })
  .patch('/api/v1/ui/training-plans/:id', async (c) => {
    const userId = c.var.session!.userId
    const raw = await readJsonBody(c)
    const parsed = patchTrainingPlanSchema.safeParse(raw)
    if (!parsed.success) {
      throw errors.validation({ issues: parsed.error.issues })
    }
    try {
      const patch: { name?: string; lengthWeeks?: number | null } = {}
      if (parsed.data.name !== undefined) patch.name = parsed.data.name
      if (parsed.data.lengthWeeks !== undefined) patch.lengthWeeks = parsed.data.lengthWeeks
      const updated = await c.var.repos.trainingPlans.update(
        userId,
        c.req.param('id'),
        patch,
      )
      if (!updated) throw errors.notFound('Plan not found.')
      return c.json({ trainingPlan: planToDto(updated) })
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw errors.validation({
          issues: [
            {
              code: 'custom',
              path: ['name'],
              message: 'You already have a plan with that name.',
            },
          ],
        })
      }
      throw err
    }
  })
  .delete('/api/v1/ui/training-plans/:id', async (c) => {
    const userId = c.var.session!.userId
    const ok = await c.var.repos.trainingPlans.delete(userId, c.req.param('id'))
    if (!ok) throw errors.notFound('Plan not found.')
    return c.json({ ok: true })
  })

  // --- items ----------------------------------------------------------
  .get('/api/v1/ui/training-plans/:id/items', async (c) => {
    const userId = c.var.session!.userId
    const planId = c.req.param('id')
    const plan = await c.var.repos.trainingPlans.getForActor(userId, planId)
    if (!plan) throw errors.notFound('Plan not found.')
    const rows = await c.var.repos.trainingPlans.listItems(planId)
    return c.json({ items: rows.map(itemToDto) })
  })
  .post('/api/v1/ui/training-plans/:id/items', async (c) => {
    const userId = c.var.session!.userId
    const planId = c.req.param('id')
    const plan = await c.var.repos.trainingPlans.getForActor(userId, planId)
    if (!plan) throw errors.notFound('Plan not found.')
    const raw = await readJsonBody(c)
    const parsed = createTrainingPlanItemSchema.safeParse(raw)
    if (!parsed.success) {
      throw errors.validation({ issues: parsed.error.issues })
    }
    // Template rows (both kinds) must reference a template the actor
    // can see (curated global ∪ own custom). The kind must also match
    // the template kind — a `strength_template` row pointing at a WOD
    // template would silently route to the wrong engine on Start.
    const { sourceKind, sourceId } = parsed.data
    if (
      (sourceKind === 'wod_template' || sourceKind === 'strength_template') &&
      sourceId
    ) {
      const tpl = await c.var.repos.wodTemplates.getForActor(userId, sourceId)
      if (!tpl) throw errors.notFound('Saved workout not found.')
      const expectedKind = sourceKind === 'strength_template' ? 'strength' : 'wod'
      if (tpl.kind !== expectedKind) {
        throw errors.validation({
          issues: [
            {
              code: 'custom',
              path: ['sourceKind'],
              message: `Template ${sourceId} is kind="${tpl.kind}", not "${expectedKind}".`,
            },
          ],
        })
      }
    }
    // Exercise rows must reference a catalog exercise the actor can see
    // (curated global ∪ own custom) — same visibility rule as templates.
    if (sourceKind === 'exercise' && sourceId) {
      const exercise = await c.var.repos.exercises.getForActor(userId, sourceId)
      if (!exercise) throw errors.notFound('Exercise not found.')
    }

    const ref = parsed.data.ref ?? null
    const { row, idempotent } = await idempotentCreate({
      ref,
      findByRef: () =>
        ref === null
          ? Promise.resolve(null)
          : c.var.repos.trainingPlans.findItemByPlanAndRef(planId, ref),
      create: () =>
        c.var.repos.trainingPlans.addItem({
          id: `tpi_${ulid()}`,
          planId,
          dayKey: parsed.data.dayKey,
          position: parsed.data.position,
          sourceKind: parsed.data.sourceKind,
          sourceId: parsed.data.sourceId ?? null,
          note: parsed.data.note ?? null,
          ref,
        }),
    })
    if (idempotent) return c.json({ item: itemToDto(row), idempotent: true }, 200)
    return c.json({ item: itemToDto(row) }, 201)
  })
  .patch('/api/v1/ui/training-plans/:id/items/:itemId', async (c) => {
    const userId = c.var.session!.userId
    const planId = c.req.param('id')
    const plan = await c.var.repos.trainingPlans.getForActor(userId, planId)
    if (!plan) throw errors.notFound('Plan not found.')
    const raw = await readJsonBody(c)
    const parsed = patchTrainingPlanItemSchema.safeParse(raw)
    if (!parsed.success) {
      throw errors.validation({ issues: parsed.error.issues })
    }
    const patch: PatchTrainingPlanItemFields = {}
    if (parsed.data.dayKey !== undefined) patch.dayKey = parsed.data.dayKey
    if (parsed.data.position !== undefined) patch.position = parsed.data.position
    if (parsed.data.note !== undefined) patch.note = parsed.data.note
    const updated = await c.var.repos.trainingPlans.updateItem(
      planId,
      c.req.param('itemId'),
      patch,
    )
    if (!updated) throw errors.notFound('Plan item not found.')
    return c.json({ item: itemToDto(updated) })
  })
  .delete('/api/v1/ui/training-plans/:id/items/:itemId', async (c) => {
    const userId = c.var.session!.userId
    const planId = c.req.param('id')
    const plan = await c.var.repos.trainingPlans.getForActor(userId, planId)
    if (!plan) throw errors.notFound('Plan not found.')
    const ok = await c.var.repos.trainingPlans.deleteItem(planId, c.req.param('itemId'))
    if (!ok) throw errors.notFound('Plan item not found.')
    return c.json({ ok: true })
  })
