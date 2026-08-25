import { and, desc, eq, exists } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { foodItems, foodLogEntries, foodSubmissions } from '@rallypoint/fitness-db'
import type {
  AcceptFoodSubmissionMigrationInput,
  FoodSubmissionAdminRecord,
  FoodSubmissionRecord,
  FoodSubmissionRepo,
  FoodSubmissionStatus,
  NewFoodSubmission,
  SetFoodSubmissionReviewedFields,
} from '../types.js'
import type { FoodServingUnit } from '@rallypoint/fitness-shared'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'

type Stmt = BatchItem<'sqlite'>
type FoodSubmissionRow = typeof foodSubmissions.$inferSelect

function rowToRecord(r: FoodSubmissionRow): FoodSubmissionRecord {
  return {
    id: r.id,
    userId: r.userId,
    upc: r.upc,
    privateFoodItemId: r.privateFoodItemId,
    name: r.name,
    brand: r.brand ?? null,
    servingGrams: r.servingGrams,
    servingQuantity: r.servingQuantity,
    servingUnit: r.servingUnit as FoodServingUnit,
    isLiquid: r.isLiquid === 1,
    per100g: {
      kcal: r.kcalPer100g,
      proteinG: r.proteinPer100g,
      carbsG: r.carbsPer100g,
      fatG: r.fatPer100g,
    },
    status: r.status as FoodSubmissionStatus,
    adminNote: r.adminNote ?? null,
    globalFoodItemId: r.globalFoodItemId ?? null,
    migrationStatus: r.migrationStatus as FoodSubmissionRecord['migrationStatus'],
    createdAt: r.createdAt,
    reviewedAt: r.reviewedAt ?? null,
    migratedAt: r.migratedAt ?? null,
  }
}

function snapshotInsertRow(input: NewFoodSubmission): typeof foodSubmissions.$inferInsert {
  return {
    id: input.id,
    userId: input.userId,
    upc: input.upc,
    privateFoodItemId: input.privateFoodItemId,
    name: input.name,
    brand: input.brand ?? null,
    servingGrams: input.servingGrams,
    servingQuantity: input.servingQuantity,
    servingUnit: input.servingUnit,
    isLiquid: input.isLiquid ? 1 : 0,
    kcalPer100g: input.per100g.kcal,
    proteinPer100g: input.per100g.proteinG,
    carbsPer100g: input.per100g.carbsG,
    fatPer100g: input.per100g.fatG,
    status: 'pending',
    migrationStatus: 'none',
    createdAt: new Date(),
  }
}

export class D1FoodSubmissionsRepo implements FoodSubmissionRepo {
  constructor(private readonly db: Db) {}

  async create(input: NewFoodSubmission): Promise<FoodSubmissionRecord> {
    const row = snapshotInsertRow(input)
    try {
      // The partial UNIQUE index on (upc) WHERE status='pending' is the
      // race-safe double-submit guard; the caller maps the mapped
      // UniqueConstraintError to the "already pending" fallback.
      await this.db.insert(foodSubmissions).values(row)
    } catch (err) {
      throw mapUniqueViolation(err)
    }
    return rowToRecord(row as FoodSubmissionRow)
  }

  async getById(id: string): Promise<FoodSubmissionRecord | null> {
    const row = await this.db
      .select()
      .from(foodSubmissions)
      .where(eq(foodSubmissions.id, id))
      .get()
    return row ? rowToRecord(row) : null
  }

  async getByIdForUser(id: string, userId: string): Promise<FoodSubmissionRecord | null> {
    const row = await this.db
      .select()
      .from(foodSubmissions)
      .where(and(eq(foodSubmissions.id, id), eq(foodSubmissions.userId, userId)))
      .get()
    return row ? rowToRecord(row) : null
  }

  async getPendingByUpc(upc: string): Promise<FoodSubmissionRecord | null> {
    const row = await this.db
      .select()
      .from(foodSubmissions)
      .where(and(eq(foodSubmissions.upc, upc), eq(foodSubmissions.status, 'pending')))
      .get()
    return row ? rowToRecord(row) : null
  }

  async listByUser(userId: string): Promise<FoodSubmissionRecord[]> {
    const rows = await this.db
      .select()
      .from(foodSubmissions)
      .where(eq(foodSubmissions.userId, userId))
      .orderBy(desc(foodSubmissions.createdAt))
    return rows.map(rowToRecord)
  }

  async listByStatus(status?: FoodSubmissionStatus): Promise<FoodSubmissionAdminRecord[]> {
    const rows = await this.db
      .select()
      .from(foodSubmissions)
      .where(status ? eq(foodSubmissions.status, status) : undefined)
      .orderBy(desc(foodSubmissions.createdAt))
    return rows.map(rowToRecord)
  }

  async getAdminById(id: string): Promise<FoodSubmissionAdminRecord | null> {
    return this.getById(id)
  }

  async setReviewed(
    id: string,
    fields: SetFoodSubmissionReviewedFields,
  ): Promise<FoodSubmissionRecord | null> {
    const existing = await this.getById(id)
    if (!existing) return null
    const updateVals: Partial<typeof foodSubmissions.$inferInsert> = {
      status: fields.status,
      reviewedAt: fields.reviewedAt,
    }
    if ('adminNote' in fields) updateVals.adminNote = fields.adminNote ?? null
    if ('globalFoodItemId' in fields) updateVals.globalFoodItemId = fields.globalFoodItemId ?? null
    if (fields.migrationStatus !== undefined) updateVals.migrationStatus = fields.migrationStatus
    await this.db
      .update(foodSubmissions)
      .set(updateVals)
      .where(and(eq(foodSubmissions.id, id), eq(foodSubmissions.status, 'pending')))
    return this.getById(id)
  }

  async declineMigration(id: string): Promise<FoodSubmissionRecord | null> {
    const existing = await this.getById(id)
    if (!existing) return null
    // Guard on migrationStatus like acceptMigration's terminal write: a
    // decline racing an in-flight accept must not clobber 'accepted'
    // after the diary entry has already been re-pointed.
    await this.db
      .update(foodSubmissions)
      .set({ migrationStatus: 'declined' })
      .where(
        and(eq(foodSubmissions.id, id), eq(foodSubmissions.migrationStatus, 'offered')),
      )
    return this.getById(id)
  }

  async acceptMigration(
    input: AcceptFoodSubmissionMigrationInput,
  ): Promise<FoodSubmissionRecord | null> {
    const existing = await this.getById(input.submissionId)
    if (!existing || existing.userId !== input.userId) return null
    // Pre-check every precondition here (status/migrationStatus/private
    // row match) so the batch below — which D1 can't conditionally
    // short-circuit mid-sequence — only runs when the migration is
    // actually offered; the terminal guarded UPDATE re-asserts the same
    // preconditions atomically against a race.
    if (
      existing.status !== 'approved' ||
      existing.migrationStatus !== 'offered' ||
      existing.privateFoodItemId !== input.privateFoodItemId ||
      existing.globalFoodItemId !== input.globalFoodItemId
    ) {
      return existing
    }

    const stmts: Stmt[] = []

    // A decline (or double-accept) can commit between the pre-check above
    // and this batch. db.batch runs as one transaction, so guarding EVERY
    // statement on the submission still being approved+offered makes the
    // whole batch a no-op in that case — the data statements and the
    // terminal status flip can't disagree.
    const stillOffered = exists(
      this.db
        .select({ one: foodSubmissions.id })
        .from(foodSubmissions)
        .where(
          and(
            eq(foodSubmissions.id, input.submissionId),
            eq(foodSubmissions.userId, input.userId),
            eq(foodSubmissions.status, 'approved'),
            eq(foodSubmissions.migrationStatus, 'offered'),
          ),
        ),
    )

    // food_log_entries: re-point every diary row that still references
    // the interim private item onto the newly-global one. Scoped to
    // user_id defensively (private rows are always owner-scoped, but the
    // WHERE stays explicit in case that invariant ever changes).
    stmts.push(
      this.db
        .update(foodLogEntries)
        .set({ foodItemId: input.globalFoodItemId })
        .where(
          and(
            eq(foodLogEntries.foodItemId, input.privateFoodItemId),
            eq(foodLogEntries.userId, input.userId),
            stillOffered,
          ),
        ) as Stmt,
    )

    // The private food_items row is now superseded by the global one —
    // delete it (owner-scoped, defensive).
    stmts.push(
      this.db
        .delete(foodItems)
        .where(
          and(
            eq(foodItems.id, input.privateFoodItemId),
            eq(foodItems.ownerUserId, input.userId),
            stillOffered,
          ),
        ) as Stmt,
    )

    const now = new Date()
    stmts.push(
      this.db
        .update(foodSubmissions)
        .set({ migrationStatus: 'accepted', migratedAt: now })
        // Re-assert every precondition so a raced decline/double-accept
        // can't be clobbered by this terminal write.
        .where(
          and(
            eq(foodSubmissions.id, input.submissionId),
            eq(foodSubmissions.userId, input.userId),
            eq(foodSubmissions.status, 'approved'),
            eq(foodSubmissions.migrationStatus, 'offered'),
          ),
        ) as Stmt,
    )

    await this.db.batch(stmts as [Stmt, ...Stmt[]])

    return this.getById(input.submissionId)
  }
}
