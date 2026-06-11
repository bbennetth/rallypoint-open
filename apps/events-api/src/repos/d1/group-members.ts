import { and, asc, count, eq } from 'drizzle-orm'
import { groupMembers } from '@rallypoint/events-db'
import type { GroupMemberRecord, GroupMemberRepo, GroupRole } from '../types.js'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'

function rowToMember(row: typeof groupMembers.$inferSelect): GroupMemberRecord {
  return {
    id: row.id,
    groupId: row.groupId,
    userId: row.userId,
    role: row.role as GroupRole,
    joinedAt: row.joinedAt,
  }
}

export class D1GroupMemberRepo implements GroupMemberRepo {
  constructor(private readonly db: Db) {}

  async add(input: {
    id: string
    groupId: string
    userId: string
    role: GroupRole
  }): Promise<GroupMemberRecord> {
    try {
      const [row] = await this.db.insert(groupMembers).values(input).returning()
      return rowToMember(row!)
    } catch (err) {
      throw mapUniqueViolation(err)
    }
  }

  async findByGroupAndUser(groupId: string, userId: string): Promise<GroupMemberRecord | null> {
    const rows = await this.db
      .select()
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
      .limit(1)
    return rows[0] ? rowToMember(rows[0]) : null
  }

  async listForGroup(groupId: string): Promise<GroupMemberRecord[]> {
    const rows = await this.db
      .select()
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId))
      .orderBy(asc(groupMembers.joinedAt))
    return rows.map(rowToMember)
  }

  async countForGroup(groupId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId))
    return row?.value ?? 0
  }

  async updateRole(groupId: string, userId: string, role: GroupRole): Promise<void> {
    await this.db
      .update(groupMembers)
      .set({ role })
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
  }

  async remove(groupId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .delete(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
      .returning({ id: groupMembers.id })
    return rows.length > 0
  }
}
