import { and, eq, sql } from 'drizzle-orm'
import { eventPlannerPrefs } from '@rallypoint/events-db'
import type { EventPlannerPrefRepo } from '../types.js'
import type { Db } from './db.js'

export class D1EventPlannerPrefRepo implements EventPlannerPrefRepo {
  constructor(private readonly db: Db) {}

  async upsert(eventId: string, userId: string, show: boolean): Promise<void> {
    await this.db
      .insert(eventPlannerPrefs)
      .values({
        eventId,
        userId,
        showInPlanner: show,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [eventPlannerPrefs.eventId, eventPlannerPrefs.userId],
        set: {
          showInPlanner: show,
          updatedAt: sql`(unixepoch() * 1000)`,
        },
      })
  }

  async flaggedEventIdsForActor(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ eventId: eventPlannerPrefs.eventId })
      .from(eventPlannerPrefs)
      .where(
        and(
          eq(eventPlannerPrefs.userId, userId),
          eq(eventPlannerPrefs.showInPlanner, true),
        ),
      )
    return rows.map((r) => r.eventId)
  }
}
