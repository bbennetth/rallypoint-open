import { and, asc, eq } from 'drizzle-orm'
import { groupMemberLocations } from '@rallypoint/events-db'
import type { GroupMemberLocationRecord, GroupMemberLocationRepo } from '../types.js'
import type { Db } from './db.js'

function rowToLocation(
  row: typeof groupMemberLocations.$inferSelect,
): GroupMemberLocationRecord {
  return {
    id: row.id,
    groupId: row.groupId,
    userId: row.userId,
    layer: row.layer,
    xPct: row.xPct,
    yPct: row.yPct,
    updatedAt: row.updatedAt,
  }
}

export class D1GroupMemberLocationRepo implements GroupMemberLocationRepo {
  constructor(private readonly db: Db) {}

  async upsertForMember(input: {
    id: string
    groupId: string
    userId: string
    layer: string
    xPct: number
    yPct: number
  }): Promise<GroupMemberLocationRecord> {
    const [row] = await this.db
      .insert(groupMemberLocations)
      .values(input)
      .onConflictDoUpdate({
        target: [groupMemberLocations.groupId, groupMemberLocations.userId],
        set: {
          layer: input.layer,
          xPct: input.xPct,
          yPct: input.yPct,
          updatedAt: new Date(),
        },
      })
      .returning()
    return rowToLocation(row!)
  }

  async deleteForMember(groupId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .delete(groupMemberLocations)
      .where(
        and(eq(groupMemberLocations.groupId, groupId), eq(groupMemberLocations.userId, userId)),
      )
      .returning({ id: groupMemberLocations.id })
    return rows.length > 0
  }

  async listForGroup(groupId: string): Promise<GroupMemberLocationRecord[]> {
    const rows = await this.db
      .select()
      .from(groupMemberLocations)
      .where(eq(groupMemberLocations.groupId, groupId))
      .orderBy(asc(groupMemberLocations.updatedAt))
    return rows.map(rowToLocation)
  }
}
