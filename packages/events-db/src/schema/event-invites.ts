import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'
import { events } from './events.js'

// event_invites — single-use collaborator invite (design doc §5.1).
// id is `evi_<ulid>`. code_hash = SHA-256('rpe_<base64url-256>') hex;
// the raw token leaves the API exactly once (create response) and is
// never re-derivable. role is the membership granted on accept.
// invited_email nullable = open-code invite. 14-day default TTL.

export const eventInvites = sqliteTable(
  'event_invites',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    invitedByUserId: text('invited_by_user_id').notNull(),
    invitedEmail: text('invited_email'),
    role: text('role').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
    consumedByUserId: text('consumed_by_user_id'),
  },
  (t) => ({
    codeHashIdx: uniqueIndex('event_invites_code_hash_idx').on(t.codeHash),
    eventIdx: index('event_invites_event_idx').on(t.eventId),
  }),
)

export type DbEventInvite = typeof eventInvites.$inferSelect
export type DbEventInviteInsert = typeof eventInvites.$inferInsert
