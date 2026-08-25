import { and, asc, eq, sql } from 'drizzle-orm'
import { trainingPlans, trainingPlanItems } from '@rallypoint/fitness-db'
import type { DayKey, PlanSourceKind } from '@rallypoint/fitness-shared'
import type {
  NewTrainingPlan,
  NewTrainingPlanItem,
  PatchTrainingPlanFields,
  PatchTrainingPlanItemFields,
  TrainingPlanItemRecord,
  TrainingPlanRecord,
  TrainingPlanRepo,
} from '../types.js'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'

type PlanRow = typeof trainingPlans.$inferSelect
type ItemRow = typeof trainingPlanItems.$inferSelect

function planRowToRecord(row: PlanRow): TrainingPlanRecord {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    lengthWeeks: row.lengthWeeks ?? null,
    ref: row.ref ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function itemRowToRecord(row: ItemRow): TrainingPlanItemRecord {
  return {
    id: row.id,
    planId: row.planId,
    dayKey: row.dayKey as DayKey,
    position: row.position,
    sourceKind: row.sourceKind as PlanSourceKind,
    sourceId: row.sourceId ?? null,
    note: row.note ?? null,
    ref: row.ref ?? null,
    createdAt: row.createdAt,
  }
}

export class D1TrainingPlanRepo implements TrainingPlanRepo {
  constructor(private readonly db: Db) {}

  async listForActor(actorUserId: string): Promise<TrainingPlanRecord[]> {
    const rows = await this.db
      .select()
      .from(trainingPlans)
      .where(eq(trainingPlans.ownerUserId, actorUserId))
      .orderBy(asc(trainingPlans.createdAt))
    return rows.map(planRowToRecord)
  }

  async getForActor(actorUserId: string, id: string): Promise<TrainingPlanRecord | null> {
    const rows = await this.db
      .select()
      .from(trainingPlans)
      .where(and(eq(trainingPlans.id, id), eq(trainingPlans.ownerUserId, actorUserId)))
      .limit(1)
    return rows[0] ? planRowToRecord(rows[0]) : null
  }

  async findByName(actorUserId: string, name: string): Promise<TrainingPlanRecord | null> {
    const rows = await this.db
      .select()
      .from(trainingPlans)
      .where(
        and(
          eq(trainingPlans.ownerUserId, actorUserId),
          sql`lower(${trainingPlans.name}) = lower(${name})`,
        ),
      )
      .limit(1)
    return rows[0] ? planRowToRecord(rows[0]) : null
  }

  async findByOwnerAndRef(actorUserId: string, ref: string): Promise<TrainingPlanRecord | null> {
    const rows = await this.db
      .select()
      .from(trainingPlans)
      .where(and(eq(trainingPlans.ownerUserId, actorUserId), eq(trainingPlans.ref, ref)))
      .limit(1)
    return rows[0] ? planRowToRecord(rows[0]) : null
  }

  async create(input: NewTrainingPlan): Promise<TrainingPlanRecord> {
    try {
      const rows = await this.db
        .insert(trainingPlans)
        .values({
          id: input.id,
          ownerUserId: input.ownerUserId,
          name: input.name,
          lengthWeeks: input.lengthWeeks ?? null,
          ref: input.ref ?? null,
        })
        .returning()
      return planRowToRecord(rows[0]!)
    } catch (err) {
      // Bugfix: the pre-ref version of this catch called
      // mapUniqueViolation(err) but discarded its return value and
      // rethrew the ORIGINAL (untyped) D1 driver error — the route's
      // `err instanceof UniqueConstraintError` check never matched, so
      // a name race fell through to the generic 500 handler instead of
      // the race-safe find-or-create fallback. Rethrowing the mapped
      // error is required for both the pre-existing name race AND the
      // new ref race to resolve correctly.
      throw mapUniqueViolation(err)
    }
  }

  async update(
    actorUserId: string,
    id: string,
    fields: PatchTrainingPlanFields,
  ): Promise<TrainingPlanRecord | null> {
    const set: Record<string, unknown> = {
      updatedAt: new Date(),
    }
    if (fields.name !== undefined) set.name = fields.name
    if (fields.lengthWeeks !== undefined) set.lengthWeeks = fields.lengthWeeks
    try {
      const rows = await this.db
        .update(trainingPlans)
        .set(set)
        .where(and(eq(trainingPlans.id, id), eq(trainingPlans.ownerUserId, actorUserId)))
        .returning()
      return rows[0] ? planRowToRecord(rows[0]) : null
    } catch (err) {
      // Same bugfix as create() above — rethrow the mapped error, not
      // the raw one, so the route's UniqueConstraintError catch fires.
      throw mapUniqueViolation(err)
    }
  }

  async delete(actorUserId: string, id: string): Promise<boolean> {
    // Pre-flight the actor-scoped ownership check BEFORE touching items —
    // the items-delete clause has no actor scope (FK-by-planId only) and
    // would otherwise nuke a victim's items even when the plan row
    // delete fails to match (review S14 P1 IDOR). The batch still keeps
    // the items + plan writes atomic so a half-applied delete can't
    // leave orphans.
    const own = await this.getForActor(actorUserId, id)
    if (!own) return false
    const res = await this.db.batch([
      this.db
        .delete(trainingPlanItems)
        .where(eq(trainingPlanItems.planId, id)),
      this.db
        .delete(trainingPlans)
        .where(and(eq(trainingPlans.id, id), eq(trainingPlans.ownerUserId, actorUserId))),
    ])
    const planChanges = res[1]?.meta?.changes ?? 0
    return planChanges > 0
  }

  async listItems(planId: string): Promise<TrainingPlanItemRecord[]> {
    const rows = await this.db
      .select()
      .from(trainingPlanItems)
      .where(eq(trainingPlanItems.planId, planId))
      .orderBy(asc(trainingPlanItems.dayKey), asc(trainingPlanItems.position))
    return rows.map(itemRowToRecord)
  }

  async getItem(planId: string, itemId: string): Promise<TrainingPlanItemRecord | null> {
    const rows = await this.db
      .select()
      .from(trainingPlanItems)
      .where(and(eq(trainingPlanItems.id, itemId), eq(trainingPlanItems.planId, planId)))
      .limit(1)
    return rows[0] ? itemRowToRecord(rows[0]) : null
  }

  async findItemByPlanAndRef(
    planId: string,
    ref: string,
  ): Promise<TrainingPlanItemRecord | null> {
    const rows = await this.db
      .select()
      .from(trainingPlanItems)
      .where(and(eq(trainingPlanItems.planId, planId), eq(trainingPlanItems.ref, ref)))
      .limit(1)
    return rows[0] ? itemRowToRecord(rows[0]) : null
  }

  async addItem(input: NewTrainingPlanItem): Promise<TrainingPlanItemRecord> {
    try {
      const rows = await this.db
        .insert(trainingPlanItems)
        .values({
          id: input.id,
          planId: input.planId,
          dayKey: input.dayKey,
          position: input.position,
          sourceKind: input.sourceKind,
          sourceId: input.sourceId ?? null,
          note: input.note ?? null,
          ref: input.ref ?? null,
        })
        .returning()
      return itemRowToRecord(rows[0]!)
    } catch (err) {
      throw mapUniqueViolation(err)
    }
  }

  async updateItem(
    planId: string,
    itemId: string,
    fields: PatchTrainingPlanItemFields,
  ): Promise<TrainingPlanItemRecord | null> {
    const set: Record<string, unknown> = {}
    if (fields.dayKey !== undefined) set.dayKey = fields.dayKey
    if (fields.position !== undefined) set.position = fields.position
    if (fields.note !== undefined) set.note = fields.note
    if (Object.keys(set).length === 0) {
      // No-op patch — return current row.
      return this.getItem(planId, itemId)
    }
    const rows = await this.db
      .update(trainingPlanItems)
      .set(set)
      .where(and(eq(trainingPlanItems.id, itemId), eq(trainingPlanItems.planId, planId)))
      .returning()
    return rows[0] ? itemRowToRecord(rows[0]) : null
  }

  async deleteItem(planId: string, itemId: string): Promise<boolean> {
    const res = await this.db
      .delete(trainingPlanItems)
      .where(and(eq(trainingPlanItems.id, itemId), eq(trainingPlanItems.planId, planId)))
      .run()
    return (res.meta?.changes ?? 0) > 0
  }
}
