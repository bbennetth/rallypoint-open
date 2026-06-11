import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'
import { groups } from './groups.js'

// group_invites — single-use group invite (design doc §5.5; renamed
// from `crew_invites` in Phase R). id is `gri_<ulid>`. code_hash =
// SHA-256('rpj_<base64url-256>') hex — same prefix as the standing
// group join code; the resolver checks groups.join_code_hash FIRST
// then group_invites.code_hash (§5.5). The raw token leaves the API
// exactly once (create response). Accept always lands the joiner as
// 'member' — there is no role column; promotion is a separate role
// action. invited_email nullable = open-code invite.
//
// timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).

export const groupInvites = sqliteTable(
  'group_invites',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    invitedByUserId: text('invited_by_user_id').notNull(),
    invitedEmail: text('invited_email'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
    consumedByUserId: text('consumed_by_user_id'),
  },
  (t) => ({
    codeHashIdx: uniqueIndex('group_invites_code_hash_idx').on(t.codeHash),
    groupIdx: index('group_invites_group_idx').on(t.groupId),
  }),
)

export type DbGroupInvite = typeof groupInvites.$inferSelect
export type DbGroupInviteInsert = typeof groupInvites.$inferInsert
