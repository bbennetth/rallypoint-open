import { sql } from 'drizzle-orm'
import { sqliteTable, index, integer, text } from 'drizzle-orm/sqlite-core'
import { events } from './events.js'

// personal_tickets — file attachments for personal (planner-owned) events.
// id is `pkt_<ulid>`. Cascades when the parent event is hard-purged; the
// pruner additionally reaps the object-store bytes before the row delete
// (design §5.1.1 order). object_key is opaque
// (`personal-tickets/<event_id>/<ticket_id>.<ext>`) so listing the bucket
// reveals no PII.
//
// bigint('bytes', { mode: 'number' }) → integer('bytes', { mode: 'number' }).
// bytes is a file size; values safely < 2^53, so integer(mode:'number') is fine.
// timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).

export const personalTickets = sqliteTable(
  'personal_tickets',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    objectKey: text('object_key').notNull(),
    contentType: text('content_type').notNull(),
    // bigint(mode:'number') → integer(mode:'number'): file size safely < 2^53.
    bytes: integer('bytes', { mode: 'number' }).notNull(),
    fileName: text('file_name'),
    uploadedByUserId: text('uploaded_by_user_id').notNull(),
    uploadedAt: integer('uploaded_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    eventIdx: index('personal_tickets_event_idx').on(t.eventId),
  }),
)

export type DbPersonalTicket = typeof personalTickets.$inferSelect
export type DbPersonalTicketInsert = typeof personalTickets.$inferInsert
