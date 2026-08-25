import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// exercises — the movement catalog. Mirrors the events `artists` GLOBAL
// catalog pattern (no tenant/event scope, find-or-create against a
// lower(name) unique index), extended with the curated-global-vs-private-
// custom split:
//   owner_user_id IS NULL  -> curated global row (seeded; source of truth
//                             for muscle maps, shared across all users)
//   owner_user_id NOT NULL -> a user's private custom exercise (never
//                             pollutes the global catalog)
// Two PARTIAL unique indexes enforce that split (same technique as
// lists-db 0011's notes-folder index): global names are unique across the
// catalog; custom names are unique only within one owner. A custom name
// may collide with a global name, and two users may each have a custom
// 'Sled Push'. id is `fx_<ulid>`.
//
// Facets carried from seed time (cheap now, a migration later):
//   discipline       — equipment/family (barbell|dumbbell|...|cardio|gymnastics)
//   movement_pattern — squat|hinge|push/pull variants|carry|gait|...
//   metric_shape     — how a result is captured (load_reps|distance_time|
//                      rounds_reps|duration); drives the slice-2 logging UI
//                      so a run is never forced into a sets-and-reps form.
// Enum values are validated by @rallypoint/fitness-shared, not the DB.

export const exercises = sqliteTable(
  'exercises',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    // NULL = curated global; non-null = the owning user's private custom row.
    ownerUserId: text('owner_user_id'),
    discipline: text('discipline').notNull(),
    movementPattern: text('movement_pattern').notNull(),
    metricShape: text('metric_shape').notNull(),
    unilateral: integer('unilateral', { mode: 'boolean' }).notNull().default(false),
    // Offline-create idempotency key (see workouts.ts schema notes),
    // owner-scoped like the custom-name index below — only a user's own
    // custom rows are ever created through the ref-bearing create route.
    ref: text('ref'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    // Curated-global names unique across the catalog (case-insensitive).
    globalNameUq: uniqueIndex('exercises_global_name_uq')
      .on(sql`lower(${t.name})`)
      .where(sql`${t.ownerUserId} is null`),
    // Custom names unique only within one owner.
    customNameUq: uniqueIndex('exercises_custom_name_uq')
      .on(t.ownerUserId, sql`lower(${t.name})`)
      .where(sql`${t.ownerUserId} is not null`),
    refUq: uniqueIndex('fitness_exercises_owner_ref_uq')
      .on(t.ownerUserId, t.ref)
      .where(sql`${t.ref} IS NOT NULL`),
    ownerIdx: index('exercises_owner_idx').on(t.ownerUserId),
    disciplineIdx: index('exercises_discipline_idx').on(t.discipline),
    // Backs the `?pattern=` filter on GET /api/v1/ui/exercises. Without
    // this index, every pattern filter does a full table scan over the
    // global+custom catalog.
    movementPatternIdx: index('exercises_movement_pattern_idx').on(t.movementPattern),
  }),
)

export type DbExercise = typeof exercises.$inferSelect
export type DbExerciseInsert = typeof exercises.$inferInsert
