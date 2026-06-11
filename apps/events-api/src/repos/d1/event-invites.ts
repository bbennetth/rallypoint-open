import { and, desc, eq, isNull } from 'drizzle-orm'
import { eventInvites } from '@rallypoint/events-db'
import type { AssignableRole, EventInviteRepo, InviteRecord, MemberRole } from '../types.js'
import type { Db } from './db.js'

function rowToInvite(row: typeof eventInvites.$inferSelect): InviteRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    codeHash: row.codeHash,
    invitedByUserId: row.invitedByUserId,
    invitedEmail: row.invitedEmail ?? null,
    role: row.role as MemberRole,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt ?? null,
    consumedByUserId: row.consumedByUserId ?? null,
  }
}

export class D1EventInviteRepo implements EventInviteRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    id: string
    eventId: string
    codeHash: string
    invitedByUserId: string
    invitedEmail: string | null
    role: AssignableRole
    expiresAt: Date
  }): Promise<InviteRecord> {
    const [row] = await this.db.insert(eventInvites).values(input).returning()
    return rowToInvite(row!)
  }

  async findByCodeHash(codeHash: string): Promise<InviteRecord | null> {
    const rows = await this.db
      .select()
      .from(eventInvites)
      .where(eq(eventInvites.codeHash, codeHash))
      .limit(1)
    return rows[0] ? rowToInvite(rows[0]) : null
  }

  async markConsumed(id: string, consumedByUserId: string, when: Date): Promise<void> {
    await this.db
      .update(eventInvites)
      .set({ consumedAt: when, consumedByUserId })
      .where(eq(eventInvites.id, id))
  }

  async listForEvent(eventId: string): Promise<InviteRecord[]> {
    const rows = await this.db
      .select()
      .from(eventInvites)
      .where(eq(eventInvites.eventId, eventId))
      .orderBy(desc(eventInvites.createdAt))
    return rows.map(rowToInvite)
  }

  async findById(id: string): Promise<InviteRecord | null> {
    const rows = await this.db
      .select()
      .from(eventInvites)
      .where(eq(eventInvites.id, id))
      .limit(1)
    return rows[0] ? rowToInvite(rows[0]) : null
  }

  async deletePending(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(eventInvites)
      .where(and(eq(eventInvites.id, id), isNull(eventInvites.consumedAt)))
      .returning({ id: eventInvites.id })
    return rows.length > 0
  }
}
