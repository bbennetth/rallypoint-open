import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core'

// users — the core identity row. tenant_id defaults to
// 'rallypoint' for V1; Phase C lights up multi-tenancy without
// schema changes. The only unique constraint is (tenant_id, email);
// email is the sole login identifier. username is a non-unique,
// freely-editable display name.
//
// id is a prefix-tagged ULID (`user_<ulid>`) generated in the app
// layer so it sorts lexicographically.

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    email: text('email').notNull(),
    emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
    username: text('username').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    pictureUrl: text('picture_url'),
    // Object-store key of an uploaded avatar (e.g. avatars/<userId>/<ulid>.png).
    // The publicly exposed picture URL is computed from this (a stable id-api
    // route that 302-redirects to a short-lived presigned GET), never stored.
    avatarKey: text('avatar_key'),
    // Account-lockout bookkeeping. failed_signin_count is the number of
    // consecutive wrong-password /signin/start attempts; locked_until (ms
    // epoch, nullable) is set once the count crosses the threshold and the
    // account is refused — with a generic failure, so lockout stays
    // enumeration-safe. Both reset on a correct password.
    failedSigninCount: integer('failed_signin_count').notNull().default(0),
    lockedUntil: integer('locked_until', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    tenantEmailIdx: uniqueIndex('users_tenant_email_idx').on(t.tenantId, t.email),
  }),
)
