import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { events } from './events.js'

// groups — named groupings of Rallypoint ID users within an event
// (design doc §5.5; renamed from `crews` in Phase R of the events
// redesign). id is `grp_<ulid>`. owner_user_id is a `user_<ulid>` (not
// FK'd). join_code_hash = SHA-256('rpj_<base64url-256>') hex — the
// standing join code; the raw token leaves the API exactly once
// (create response) and is never re-derivable. No tenant_id (the
// group is transitively tenant-scoped via its event); no soft-delete
// (groups hard-delete, cascading members + invites). (event_id, name) is
// unique within an event.
//
// date('start_date')/date('end_date') → text; ISO YYYY-MM-DD string.
// timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).

export const groups = sqliteTable(
  'groups',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    // date('start_date')/date('end_date') → text; ISO YYYY-MM-DD string.
    startDate: text('start_date'),
    endDate: text('end_date'),
    joinCodeHash: text('join_code_hash').notNull(),
    // #440: human-friendly 6-char join code (FP parity). Plaintext —
    // it is displayed and re-shown in the UI constantly, unlike the
    // rpj_ token; brute force is covered by the 32^6 space + per-user
    // rate limiting on the resolve/join endpoints. Nullable: lazily
    // backfilled for pre-#440 groups on first owner read.
    shortCode: text('short_code'),
    ownerUserId: text('owner_user_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    eventNameIdx: uniqueIndex('groups_event_name_idx').on(t.eventId, t.name),
    joinCodeHashIdx: uniqueIndex('groups_join_code_hash_idx').on(t.joinCodeHash),
    shortCodeIdx: uniqueIndex('groups_short_code_idx').on(t.shortCode),
  }),
)

export type DbGroup = typeof groups.$inferSelect
export type DbGroupInsert = typeof groups.$inferInsert
