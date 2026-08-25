import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// metrics — body/health data-point time series (bodyweight, sleep, resting
// HR, HRV, soreness, mood, or any user-defined kind). The Planner Diary
// "data points" pattern promoted to a first-class table. One row per
// reading; `kind` is a slug (a curated set lives in @rallypoint/fitness-
// shared with default units, but any slug is allowed so users can track
// arbitrary metrics without a definitions table). value is numeric (SI /
// the kind's canonical unit); unit is a free label for display. id is
// `fm_<ulid>`. (user_id, kind, recorded_at) is indexed for the per-kind
// time-series reads the insights/charts do.
//
// ref is the offline-create idempotency key (see workouts.ts schema
// notes) — partial-unique `(user_id, ref) WHERE ref IS NOT NULL`.

export const metrics = sqliteTable(
  'metrics',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    recordedAt: integer('recorded_at', { mode: 'timestamp_ms' }).notNull(),
    kind: text('kind').notNull(),
    value: real('value').notNull(),
    unit: text('unit'),
    note: text('note'),
    ref: text('ref'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userKindRecordedIdx: index('metrics_user_kind_recorded_idx').on(
      t.userId,
      t.kind,
      t.recordedAt,
    ),
    refUq: uniqueIndex('fitness_metrics_user_ref_uq')
      .on(t.userId, t.ref)
      .where(sql`${t.ref} IS NOT NULL`),
  }),
)

export type DbMetric = typeof metrics.$inferSelect
export type DbMetricInsert = typeof metrics.$inferInsert
