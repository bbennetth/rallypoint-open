import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core'

// list_groups — the Lists-local group primitive (locked scope decision
// 3). A list with scope_type='list_group' references a row here via
// scope_id. id is `lgr_<ulid>`. created_by holds a Rallypoint ID
// `user_<ulid>` (not a cross-app FK). Membership lives in
// list_group_members; the creator is auto-enrolled as 'owner' at create
// time. Join-codes and email invites are deferred to a later slice.
// deleted_at is the soft-delete marker (pruner hard-purges 30 days past
// it, cascading members).
//
// list_groups_created_by_name_uq: partial unique on (created_by, name)
// WHERE deleted_at IS NULL prevents duplicate personal-group names
// (e.g. two concurrent "My Tasks" creates for the same user — #277).
// Partial scope keeps the constraint off soft-deleted rows so a freed
// name can be reused. The D1GroupRepo.create() handles the conflict by
// re-selecting the winner row rather than erroring (see groups.ts).

export const listGroups = sqliteTable(
  'list_groups',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    name: text('name').notNull(),
    description: text('description'),
    // Provenance discriminator: 'planner' for groups provisioned by the
    // Planner BFF (read-only on the Lists UI surface); NULL for groups
    // created in the Lists app. Nullable for expand/contract safety.
    origin: text('origin'),
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
    // Partial unique: only LIVE rows constrained, mirroring the
    // list_field_defs_list_key_uq pattern. Soft-deleted groups are
    // exempt so a freed name can be reused after deletion.
    createdByNameUq: uniqueIndex('list_groups_created_by_name_uq')
      .on(t.createdBy, t.name)
      .where(sql`${t.deletedAt} is null`),
  }),
)

export type DbListGroup = typeof listGroups.$inferSelect
export type DbListGroupInsert = typeof listGroups.$inferInsert
