import { desc, eq } from 'drizzle-orm'
import { groupInvites } from '@rallypoint/events-db'
import type { GroupInviteRecord, GroupInviteRepo } from '../types.js'
import type { Db } from './db.js'

function rowToInvite(row: typeof groupInvites.$inferSelect): GroupInviteRecord {
  return {
    id: row.id,
    groupId: row.groupId,
    codeHash: row.codeHash,
    invitedByUserId: row.invitedByUserId,
    invitedEmail: row.invitedEmail ?? null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt ?? null,
    consumedByUserId: row.consumedByUserId ?? null,
  }
}

export class D1GroupInviteRepo implements GroupInviteRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    id: string
    groupId: string
    codeHash: string
    invitedByUserId: string
    invitedEmail: string | null
    expiresAt: Date
  }): Promise<GroupInviteRecord> {
    const [row] = await this.db.insert(groupInvites).values(input).returning()
    return rowToInvite(row!)
  }

  async findByCodeHash(codeHash: string): Promise<GroupInviteRecord | null> {
    const rows = await this.db
      .select()
      .from(groupInvites)
      .where(eq(groupInvites.codeHash, codeHash))
      .limit(1)
    return rows[0] ? rowToInvite(rows[0]) : null
  }

  async markConsumed(id: string, consumedByUserId: string, when: Date): Promise<void> {
    await this.db
      .update(groupInvites)
      .set({ consumedAt: when, consumedByUserId })
      .where(eq(groupInvites.id, id))
  }

  async listForGroup(groupId: string): Promise<GroupInviteRecord[]> {
    const rows = await this.db
      .select()
      .from(groupInvites)
      .where(eq(groupInvites.groupId, groupId))
      .orderBy(desc(groupInvites.createdAt))
    return rows.map(rowToInvite)
  }
}
