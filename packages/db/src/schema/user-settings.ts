import { sql } from 'drizzle-orm'
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { users } from './users.js'

// user_settings — generic per-user, per-namespace settings store.
//
// D1/SQLite model: one row PER KEY, not one JSON blob per namespace.
// Postgres stored the whole document in a `jsonb data` column and did
// the shallow merge / key-delete with the `||` and `-` operators, which
// SQLite has no equivalent for. Storing each key as its own row makes
// the merge a plain relational upsert/delete (atomic via D1 `batch()`),
// gives exact shallow-merge parity (setting a key replaces its row;
// deleting drops it — no recursive-merge surprise), and handles any
// front-end key name safely (it's column data, not a JSON path).
//
// RPID does NO per-key schema validation: `value` is whatever the front
// end writes for that key (an opaque JSON value — scalar, object, or
// array), size-capped at the route. The repo (SettingsRepo) assembles
// the rows back into a `Record<string, unknown>` so callers are
// unchanged from the blob model.
//
// `namespace` is either an app's client id (a private bag, e.g.
// 'planner') or 'shared' (the cross-app bag where cross-app prefs like
// theme live). The own-client-or-shared access rule is enforced at the
// route, not by the schema.

export const userSettings = sqliteTable(
  'user_settings',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    namespace: text('namespace').notNull(),
    key: text('key').notNull(),
    // Opaque JSON value for this single key (never JSON-null — a null in
    // a patch means "delete this key", i.e. drop the row).
    value: text('value', { mode: 'json' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.namespace, t.key], name: 'user_settings_pkey' }),
  }),
)

export type DbUserSetting = typeof userSettings.$inferSelect
export type DbUserSettingInsert = typeof userSettings.$inferInsert
