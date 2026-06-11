import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

// audit_log — append-only event stream for every auth-relevant
// event. user_id is nullable because some events (signup.attempt
// rejected at validation, login attempts on a non-existent user)
// have no associated user row.
//
// meta is intentionally jsonb (not a typed column per event-type)
// because the event-type set will grow and the audit table
// shouldn't gate that growth on a migration. The writer guarantees
// no raw tokens / codes / passwords end up in meta.

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(), // ULID
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    eventType: text('event_type').notNull(), // 'signup.success', 'signin.failure', etc.
    userId: text('user_id'), // tombstoned to 'deleted_<ulid>' on GDPR purge
    ipHash: text('ip_hash').notNull(), // SHA-256(ip + DAILY_SALT)
    uaHash: text('ua_hash').notNull(),
    meta: text('meta', { mode: 'json' }).notNull().default(sql`'{}'`),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantUserIdx: index('audit_log_tenant_user_idx').on(t.tenantId, t.userId),
    tenantEventIdx: index('audit_log_tenant_event_idx').on(t.tenantId, t.eventType),
    createdIdx: index('audit_log_created_idx').on(t.createdAt),
  }),
)

export type DbAuditEvent = typeof auditLog.$inferSelect
export type DbAuditEventInsert = typeof auditLog.$inferInsert
