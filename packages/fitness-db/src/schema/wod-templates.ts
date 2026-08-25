import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// wod_templates — named WOD prescriptions a user picks at session start to
// drive the live logger (timer + tap-to-count). Same global-vs-custom split
// the exercises catalog uses:
//   owner_user_id IS NULL  -> curated global (benchmark) row, seeded
//   owner_user_id NOT NULL -> a user's private custom WOD
// Partial unique indexes enforce the split exactly like exercises_*_name_uq:
// global names are unique across the catalog; custom names are unique per
// owner; the two namespaces are independent so a user can have "Fran v2"
// alongside the global "Fran". id is `wt_<ulid>`.
//
// The body column holds the JSON-encoded WodBody (validated by
// @rallypoint/fitness-shared's wodBodySchema at the route layer — no DB
// CHECK constraints, same convention as the rest of the fitness schema).

export const wodTemplates = sqliteTable(
  'wod_templates',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    ownerUserId: text('owner_user_id'),
    wodType: text('wod_type').notNull(),
    // Ink redesign post-launch (S0): polymorphic-template discriminator.
    // `null` = legacy 'wod'-shape template (handled in the route layer);
    // 'wod' / 'strength' = explicit kind. The body column's JSON shape
    // is validated against the matching branch of
    // `wodOrStrengthBodySchema` in @rallypoint/fitness-shared at the
    // route boundary.
    kind: text('kind'),
    timeCapS: integer('time_cap_s'),
    description: text('description'),
    body: text('body').notNull(),
    isBenchmark: integer('is_benchmark', { mode: 'boolean' }).notNull().default(false),
    // Offline-create idempotency key (see workouts.ts schema notes),
    // owner-scoped — only a user's own custom rows are ever created
    // through the ref-bearing create route.
    ref: text('ref'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    globalNameUq: uniqueIndex('wod_templates_global_name_uq')
      .on(sql`lower(${t.name})`)
      .where(sql`${t.ownerUserId} is null`),
    // Per-kind uniqueness: a user may have a WOD "Squats" AND a
    // strength "Squats" — they're distinct templates with different
    // bodies. Legacy rows have kind=null which collapses to a single
    // null-kind bucket for the index — fine because no legacy
    // duplicates exist (constraint review bugfix, 0011 migration).
    customNameUq: uniqueIndex('wod_templates_custom_name_uq')
      .on(t.ownerUserId, t.kind, sql`lower(${t.name})`)
      .where(sql`${t.ownerUserId} is not null`),
    refUq: uniqueIndex('fitness_wod_templates_owner_ref_uq')
      .on(t.ownerUserId, t.ref)
      .where(sql`${t.ref} IS NOT NULL`),
    ownerIdx: index('wod_templates_owner_idx').on(t.ownerUserId),
    typeIdx: index('wod_templates_type_idx').on(t.wodType),
  }),
)

export type DbWodTemplate = typeof wodTemplates.$inferSelect
export type DbWodTemplateInsert = typeof wodTemplates.$inferInsert
