import { and, desc, eq, isNull } from 'drizzle-orm'
import { listInvites } from '@rallypoint/lists-db'
import type { ListInviteRecord, ListInviteRepo } from '../types.js'
import type { Db } from './db.js'

function rowToInvite(row: typeof listInvites.$inferSelect): ListInviteRecord {
  return {
    id: row.id,
    listId: row.listId,
    codeHash: row.codeHash,
    invitedByUserId: row.invitedByUserId,
    invitedEmail: row.invitedEmail,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    consumedByUserId: row.consumedByUserId,
  }
}

export class D1ListInviteRepo implements ListInviteRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    id: string
    listId: string
    codeHash: string
    invitedByUserId: string
    invitedEmail: string
    expiresAt: Date
  }): Promise<ListInviteRecord> {
    const [row] = await this.db.insert(listInvites).values(input).returning()
    return rowToInvite(row!)
  }

  async findByCodeHash(codeHash: string): Promise<ListInviteRecord | null> {
    const rows = await this.db
      .select()
      .from(listInvites)
      .where(eq(listInvites.codeHash, codeHash))
      .limit(1)
    return rows[0] ? rowToInvite(rows[0]) : null
  }

  async findById(id: string): Promise<ListInviteRecord | null> {
    const rows = await this.db
      .select()
      .from(listInvites)
      .where(eq(listInvites.id, id))
      .limit(1)
    return rows[0] ? rowToInvite(rows[0]) : null
  }

  async markConsumed(id: string, consumedByUserId: string, when: Date): Promise<void> {
    await this.db
      .update(listInvites)
      .set({ consumedAt: when, consumedByUserId })
      .where(eq(listInvites.id, id))
  }

  async listForList(listId: string): Promise<ListInviteRecord[]> {
    const rows = await this.db
      .select()
      .from(listInvites)
      .where(eq(listInvites.listId, listId))
      .orderBy(desc(listInvites.createdAt))
    return rows.map(rowToInvite)
  }

  async deletePending(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(listInvites)
      .where(and(eq(listInvites.id, id), isNull(listInvites.consumedAt)))
      .returning({ id: listInvites.id })
    return rows.length > 0
  }
}
