import { asc, eq } from 'drizzle-orm'
import { personalTickets } from '@rallypoint/events-db'
import type { PersonalTicketRepo, PersonalTicketRecord, CreatePersonalTicketInput } from '../types.js'
import type { Db } from './db.js'

function rowToTicket(row: typeof personalTickets.$inferSelect): PersonalTicketRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    objectKey: row.objectKey,
    contentType: row.contentType,
    bytes: row.bytes,
    fileName: row.fileName ?? null,
    uploadedByUserId: row.uploadedByUserId,
    uploadedAt: row.uploadedAt,
  }
}

export class D1PersonalTicketRepo implements PersonalTicketRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreatePersonalTicketInput): Promise<PersonalTicketRecord> {
    const [row] = await this.db
      .insert(personalTickets)
      .values({
        id: input.id,
        eventId: input.eventId,
        objectKey: input.objectKey,
        contentType: input.contentType,
        bytes: input.bytes,
        fileName: input.fileName ?? null,
        uploadedByUserId: input.uploadedByUserId,
      })
      .returning()
    return rowToTicket(row!)
  }

  async findById(id: string): Promise<PersonalTicketRecord | null> {
    const rows = await this.db
      .select()
      .from(personalTickets)
      .where(eq(personalTickets.id, id))
      .limit(1)
    return rows[0] ? rowToTicket(rows[0]) : null
  }

  async listForEvent(eventId: string): Promise<PersonalTicketRecord[]> {
    const rows = await this.db
      .select()
      .from(personalTickets)
      .where(eq(personalTickets.eventId, eventId))
      .orderBy(asc(personalTickets.uploadedAt), asc(personalTickets.id))
    return rows.map(rowToTicket)
  }
}
