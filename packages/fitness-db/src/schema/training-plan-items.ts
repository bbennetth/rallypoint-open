import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// training_plan_items — a single scheduled workout inside a plan. The
// (planId, dayKey, position) composite key is the natural order; the
// index below covers reorders + retrievals cheaply.
//
// `dayKey` is the canonical lower-case three-letter weekday
// ('mon'..'sun') so reads can group rows cheaply without parsing
// dates. `sourceKind` identifies what the row points at:
//   wod_template → a WOD from `wod_templates` (the saved-workouts
//                  shelf)
//   strength     → a free-form strength session whose details live in
//                  the `note` column (until strength templates land
//                  with the future expand of wod_templates.kind)
// `sourceId` is the id when `sourceKind='wod_template'`, or null for
// `strength`. No FK across packages — repo logic re-validates on read.
//
// ref is the offline-create idempotency key (see workouts.ts schema
// notes), scoped to the plan — partial-unique `(plan_id, ref) WHERE ref
// IS NOT NULL`.

export const trainingPlanItems = sqliteTable(
  'training_plan_items',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id').notNull(),
    dayKey: text('day_key').notNull(),
    position: integer('position').notNull(),
    sourceKind: text('source_kind').notNull(),
    sourceId: text('source_id'),
    note: text('note'),
    ref: text('ref'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    planDayPosIdx: index('training_plan_items_plan_day_pos_idx').on(
      t.planId,
      t.dayKey,
      t.position,
    ),
    refUq: uniqueIndex('fitness_plan_items_plan_ref_uq')
      .on(t.planId, t.ref)
      .where(sql`${t.ref} IS NOT NULL`),
  }),
)

export type DbTrainingPlanItem = typeof trainingPlanItems.$inferSelect
export type DbTrainingPlanItemInsert = typeof trainingPlanItems.$inferInsert
