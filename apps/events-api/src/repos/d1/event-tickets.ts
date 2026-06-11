import { and, asc, eq, isNull } from 'drizzle-orm'
import { eventTickets } from '@rallypoint/events-db'
import type {
  CreateTicketInput,
  EventTicketRepo,
  PatchTicketInput,
  TicketRecord,
} from '../types.js'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'

function rowToTicket(row: typeof eventTickets.$inferSelect): TicketRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    name: row.name,
    description: row.description ?? null,
    priceCents: row.priceCents,
    quantity: row.quantity ?? null,
    soldCount: row.soldCount,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
  }
}

export class D1EventTicketRepo implements EventTicketRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateTicketInput): Promise<TicketRecord> {
    try {
      const [row] = await this.db
        .insert(eventTickets)
        .values({
          id: input.id,
          eventId: input.eventId,
          name: input.name,
          description: input.description ?? null,
          priceCents: input.priceCents,
          quantity: input.quantity ?? null,
          sortOrder: input.sortOrder ?? 0,
        })
        .returning()
      return rowToTicket(row!)
    } catch (err) {
      throw mapUniqueViolation(err)
    }
  }

  async findById(id: string): Promise<TicketRecord | null> {
    const rows = await this.db
      .select()
      .from(eventTickets)
      .where(eq(eventTickets.id, id))
      .limit(1)
    return rows[0] ? rowToTicket(rows[0]) : null
  }

  async listForEvent(eventId: string): Promise<TicketRecord[]> {
    const rows = await this.db
      .select()
      .from(eventTickets)
      .where(eq(eventTickets.eventId, eventId))
      .orderBy(asc(eventTickets.sortOrder), asc(eventTickets.createdAt))
    return rows.map(rowToTicket)
  }

  async patch(id: string, fields: PatchTicketInput): Promise<TicketRecord | null> {
    const updates: Partial<typeof eventTickets.$inferInsert> = {}
    if (fields.name !== undefined) updates.name = fields.name
    if (fields.description !== undefined) updates.description = fields.description
    if (fields.priceCents !== undefined) updates.priceCents = fields.priceCents
    if (fields.quantity !== undefined) updates.quantity = fields.quantity
    if (fields.sortOrder !== undefined) updates.sortOrder = fields.sortOrder
    updates.updatedAt = new Date()
    try {
      const [row] = await this.db
        .update(eventTickets)
        .set(updates)
        .where(eq(eventTickets.id, id))
        .returning()
      return row ? rowToTicket(row) : null
    } catch (err) {
      throw mapUniqueViolation(err)
    }
  }

  async softDelete(id: string, when: Date): Promise<'ok' | 'sold' | 'not_found'> {
    const result = await this.db
      .update(eventTickets)
      .set({ deletedAt: when, updatedAt: new Date() })
      .where(
        and(
          eq(eventTickets.id, id),
          isNull(eventTickets.deletedAt),
          eq(eventTickets.soldCount, 0),
        ),
      )
      .returning({ id: eventTickets.id })
    if (result.length > 0) return 'ok'
    const row = await this.findById(id)
    if (!row) return 'not_found'
    if (row.deletedAt !== null) return 'not_found'
    if (row.soldCount > 0) return 'sold'
    return 'not_found'
  }

  async restore(id: string): Promise<TicketRecord | null> {
    const [row] = await this.db
      .update(eventTickets)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(eq(eventTickets.id, id))
      .returning()
    return row ? rowToTicket(row) : null
  }
}
