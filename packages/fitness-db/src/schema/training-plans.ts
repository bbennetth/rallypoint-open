import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// training_plans — a user-owned weekly training schedule. Each user
// can have multiple plans (e.g. "Strength block", "Marathon prep")
// and switches between them via the active-plan localStorage stamp on
// the client. A plan is just the named container; its scheduled
// workouts live in training_plan_items keyed by (planId, dayKey,
// position). `lengthWeeks` is nullable to encode "ongoing" per the
// design handoff's plan-length chip set (1 / 4 / 8 / Ongoing).
//
// Owner is required — there are no global plans. id is `tpl_<ulid>`.
// Names are unique-per-owner (case-insensitive) so the plans-popover
// list stays clean.

export const trainingPlans = sqliteTable(
  'training_plans',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id').notNull(),
    name: text('name').notNull(),
    lengthWeeks: integer('length_weeks'),
    // Offline-create idempotency key (see workouts.ts schema notes).
    ref: text('ref'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    nameUq: uniqueIndex('training_plans_owner_name_uq').on(
      t.ownerUserId,
      sql`lower(${t.name})`,
    ),
    ownerIdx: index('training_plans_owner_idx').on(t.ownerUserId),
    refUq: uniqueIndex('fitness_training_plans_owner_ref_uq')
      .on(t.ownerUserId, t.ref)
      .where(sql`${t.ref} IS NOT NULL`),
  }),
)

export type DbTrainingPlan = typeof trainingPlans.$inferSelect
export type DbTrainingPlanInsert = typeof trainingPlans.$inferInsert
