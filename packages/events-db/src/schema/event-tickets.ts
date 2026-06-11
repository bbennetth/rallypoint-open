import { sql } from 'drizzle-orm'
import { sqliteTable, check, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { events } from './events.js'

// event_tickets — ticket tiers per event (Phase T of platform/v-1.1
// per #16). Phase T ships only the data model + owner admin CRUD; the
// selling integration (Stripe / Money) lands as a follow-up.
//
// id is `evt_<ulid>`. event_id CASCADEs on event delete. name is
// unique-per-event (a free-tier event and a GA tier can't both be
// called "General Admission"). price_cents is integer (allow 0 for
// free tiers / RSVP-only); quantity NULL means unlimited; sold_count
// is a denormalised counter the future selling code increments
// atomically.
//
// CHECK constraint: sold_count <= quantity when quantity is set.
//
// Soft-delete via deleted_at preserves audit trail (a sold tier
// cannot disappear from the historical ledger). The DELETE route
// returns 409 when sold_count > 0.

export const eventTickets = sqliteTable(
  'event_tickets',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    priceCents: integer('price_cents').notNull().default(0),
    quantity: integer('quantity'),
    soldCount: integer('sold_count').notNull().default(0),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    eventNameIdx: uniqueIndex('event_tickets_event_name_idx').on(t.eventId, t.name),
    soldQuantityCk: check(
      'event_tickets_sold_lte_quantity_ck',
      sql`${t.quantity} IS NULL OR ${t.soldCount} <= ${t.quantity}`,
    ),
  }),
)

export type DbEventTicket = typeof eventTickets.$inferSelect
export type DbEventTicketInsert = typeof eventTickets.$inferInsert
