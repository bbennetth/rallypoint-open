import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core'

// lists — the core Lists primitive (design resolution: one core row,
// two list types). id is a prefix-tagged ULID (`lst_<ulid>`) minted
// in the app layer. created_by holds a Rallypoint ID `user_<ulid>`;
// it is NOT a cross-app FK (each app owns its own D1 database).
//
// scope_type/scope_id is the scope discriminator (locked scope
// decision 3; renamed from 'crew' in Phase R): scope_type `group`
// references an Events `group_id` opaquely as text (no FK);
// scope_type `list_group` references a Lists-local `list_groups`
// row (added in a later slice).
//
// list_type ∈ tasks|standard|shopping (plain text, no check
// constraint — validated by the LIST_TYPES zod enum). visibility ∈
// all|private (#128 narrowed from all|private|custom; 'custom' rows
// collapse to 'private' in migration 0003 with the share state living
// in list_shares). deleted_at is the soft-delete marker; the pruner
// hard-purges 30 days past it.

export const lists = sqliteTable(
  'lists',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    scopeType: text('scope_type').notNull(),
    scopeId: text('scope_id').notNull(),
    listType: text('list_type').notNull(),
    name: text('name').notNull(),
    visibility: text('visibility').notNull().default('all'),
    color: text('color'),
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
    scopeIdx: index('lists_scope_idx').on(t.tenantId, t.scopeType, t.scopeId),
    createdByIdx: index('lists_created_by_idx').on(t.createdBy),
    // lists_notes_folder_name_uq: partial unique on (scope_id, name) for LIVE
    // `notes`-type lists only — the DB backstop for the Planner notes-folder
    // name race (#559), where two concurrent POSTs both pass the app-level
    // folderNameTaken pre-check and create duplicate folders. Scoped to
    // list_type='notes' so it never constrains tasks/standard/shopping lists,
    // which legitimately allow duplicate names in a scope. Partial on
    // deleted_at IS NULL so a deleted folder's name can be reused. Mirrors
    // the list_groups_created_by_name_uq pattern (case-sensitive, like that
    // index); the app's folderNameTaken stays the case-insensitive guard for
    // the non-racing path.
    notesFolderNameUq: uniqueIndex('lists_notes_folder_name_uq')
      .on(t.scopeId, t.name)
      .where(sql`${t.deletedAt} is null and ${t.listType} = 'notes'`),
  }),
)

export type DbList = typeof lists.$inferSelect
export type DbListInsert = typeof lists.$inferInsert
