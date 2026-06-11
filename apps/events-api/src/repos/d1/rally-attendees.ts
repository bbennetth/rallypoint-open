import { and, asc, eq, inArray } from 'drizzle-orm'
import { rallies, rallyAttendees } from '@rallypoint/events-db'
import type { RallyAttendeeRecord, RallyAttendeeRepo, RallyRsvpStatus } from '../types.js'
import type { Db } from './db.js'

function rowToAttendee(row: typeof rallyAttendees.$inferSelect): RallyAttendeeRecord {
  return {
    id: row.id,
    rallyId: row.rallyId,
    userId: row.userId,
    status: row.status as RallyRsvpStatus,
    respondedAt: row.respondedAt,
  }
}

export class D1RallyAttendeeRepo implements RallyAttendeeRepo {
  constructor(private readonly db: Db) {}

  async upsert(input: {
    id: string
    rallyId: string
    userId: string
    status: RallyRsvpStatus
  }): Promise<RallyAttendeeRecord> {
    const [row] = await this.db
      .insert(rallyAttendees)
      .values({
        id: input.id,
        rallyId: input.rallyId,
        userId: input.userId,
        status: input.status,
      })
      .onConflictDoUpdate({
        target: [rallyAttendees.rallyId, rallyAttendees.userId],
        set: { status: input.status, respondedAt: new Date() },
      })
      .returning()
    return rowToAttendee(row!)
  }

  async listForRally(rallyId: string): Promise<RallyAttendeeRecord[]> {
    const rows = await this.db
      .select()
      .from(rallyAttendees)
      .where(eq(rallyAttendees.rallyId, rallyId))
      .orderBy(asc(rallyAttendees.respondedAt))
    return rows.map(rowToAttendee)
  }

  async listForRallies(rallyIds: string[]): Promise<RallyAttendeeRecord[]> {
    if (rallyIds.length === 0) return []
    const rows = await this.db
      .select()
      .from(rallyAttendees)
      .where(inArray(rallyAttendees.rallyId, rallyIds))
      .orderBy(asc(rallyAttendees.respondedAt))
    return rows.map(rowToAttendee)
  }

  async deleteForUserInGroup(groupId: string, userId: string): Promise<number> {
    // Subquery: collect rally ids for the group, then delete the user's attendee rows.
    const groupRallies = this.db
      .select({ id: rallies.id })
      .from(rallies)
      .where(eq(rallies.groupId, groupId))
    const deleted = await this.db
      .delete(rallyAttendees)
      .where(
        and(
          eq(rallyAttendees.userId, userId),
          inArray(rallyAttendees.rallyId, groupRallies),
        ),
      )
      .returning({ id: rallyAttendees.id })
    return deleted.length
  }
}
