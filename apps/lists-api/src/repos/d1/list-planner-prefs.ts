import { and, eq, sql } from 'drizzle-orm'
import { listPlannerPrefs } from '@rallypoint/lists-db'
import type { ListPlannerPrefRepo } from '../types.js'
import type { Db } from './db.js'

export class D1ListPlannerPrefRepo implements ListPlannerPrefRepo {
  constructor(private readonly db: Db) {}

  async upsert(userId: string, listId: string, show: boolean): Promise<void> {
    await this.db
      .insert(listPlannerPrefs)
      .values({
        listId,
        userId,
        showInPlanner: show,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [listPlannerPrefs.listId, listPlannerPrefs.userId],
        set: {
          showInPlanner: show,
          updatedAt: sql`(unixepoch() * 1000)`,
        },
      })
  }

  async flaggedListIdsForActor(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ listId: listPlannerPrefs.listId })
      .from(listPlannerPrefs)
      .where(
        and(
          eq(listPlannerPrefs.userId, userId),
          eq(listPlannerPrefs.showInPlanner, true),
        ),
      )
    return rows.map((r) => r.listId)
  }
}
