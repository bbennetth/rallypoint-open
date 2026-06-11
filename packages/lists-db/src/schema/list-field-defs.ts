import { sql } from 'drizzle-orm'
import { sqliteTable, index, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { lists } from './lists.js'

// list_field_defs — user-defined custom field (column) definitions for a
// list (Lists v2). id is a prefix-tagged ULID (`lfd_<ulid>`) minted in the
// app layer. list_id is an intra-db FK that CASCADEs when its parent
// list is hard-purged. Values live in list_items.custom_fields keyed by
// THIS row's id (rename-stable).
//
// `key` is a human-ish slug derived once from the label and unique among a
// list's LIVE fields; `label` is the renameable display name. field_type
// is plain text (NO DB check — the FIELD_TYPES enum lives in the app
// layer, mirroring lists.list_type / lists.visibility) and is immutable
// once set. `options` carries select choices / the text multiline flag
// (see @rallypoint/lists-shared FieldDefOptions). `default_value` mirrors a
// stored value's encoding (column reserved here; wired into the API in
// slice 3). deleted_at soft-deletes the field; the partial-unique on
// (list_id, key) constrains only live rows so a freed slug can be reused.

export const listFieldDefs = sqliteTable(
  'list_field_defs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    listId: text('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    fieldType: text('field_type').notNull(),
    options: text('options', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`)
      .$type<{
        choices?: { id: string; label: string; color?: string; archived?: boolean }[]
        multiline?: boolean
      }>(),
    required: integer('required', { mode: 'boolean' }).notNull().default(false),
    defaultValue: text('default_value', { mode: 'json' }),
    position: integer('position').notNull().default(0),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    listIdx: index('list_field_defs_list_idx').on(t.listId, t.position),
    // Partial unique: only LIVE rows are constrained, so a freed slug can
    // be reused. SQLite supports `CREATE UNIQUE INDEX … WHERE …`; if
    // drizzle-kit drops the predicate, the baseline migration is
    // hand-patched to keep it (see migrations/).
    listKeyUq: uniqueIndex('list_field_defs_list_key_uq')
      .on(t.listId, t.key)
      .where(sql`${t.deletedAt} is null`),
  }),
)

export type DbListFieldDef = typeof listFieldDefs.$inferSelect
export type DbListFieldDefInsert = typeof listFieldDefs.$inferInsert
