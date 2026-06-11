import { and, asc, eq } from 'drizzle-orm'
import { eventMembers } from '@rallypoint/events-db'
import type { EventMemberRepo, MemberRecord, MemberRole } from '../types.js'
import type { Db } from './db.js'

function rowToMember(row: typeof eventMembers.$inferSelect): MemberRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    userId: row.userId,
    role: row.role as MemberRole,
    joinedAt: row.joinedAt,
  }
}

export class D1EventMemberRepo implements EventMemberRepo {
  constructor(private readonly db: Db) {}

  async add(input: {
    id: string
    eventId: string
    userId: string
    role: MemberRole
  }): Promise<MemberRecord> {
    const [row] = await this.db.insert(eventMembers).values(input).returning()
    return rowToMember(row!)
  }

  async findByEventAndUser(eventId: string, userId: string): Promise<MemberRecord | null> {
    const rows = await this.db
      .select()
      .from(eventMembers)
      .where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.userId, userId)))
      .limit(1)
    return rows[0] ? rowToMember(rows[0]) : null
  }

  async updateRole(eventId: string, userId: string, role: MemberRole): Promise<void> {
    await this.db
      .update(eventMembers)
      .set({ role })
      .where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.userId, userId)))
  }

  async listForEvent(eventId: string): Promise<MemberRecord[]> {
    const rows = await this.db
      .select()
      .from(eventMembers)
      .where(eq(eventMembers.eventId, eventId))
      .orderBy(asc(eventMembers.joinedAt))
    return rows.map(rowToMember)
  }
}
