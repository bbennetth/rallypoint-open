import { desc, eq } from 'drizzle-orm'
import { eventActivity } from '@rallypoint/events-db'
import type { ActivityRecord, EventActivityRepo } from '../types.js'
import type { Db } from './db.js'

function rowToActivity(row: typeof eventActivity.$inferSelect): ActivityRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    actorUserId: row.actorUserId,
    eventType: row.eventType,
    meta: ((row.meta as Record<string, unknown> | null) ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
  }
}

export class D1EventActivityRepo implements EventActivityRepo {
  constructor(private readonly db: Db) {}

  async record(input: {
    id: string
    eventId: string
    actorUserId: string
    eventType: string
    meta?: Record<string, unknown>
  }): Promise<void> {
    await this.db.insert(eventActivity).values({
      id: input.id,
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      eventType: input.eventType,
      meta: input.meta ?? {},
    })
  }

  async listForEvent(eventId: string): Promise<ActivityRecord[]> {
    const rows = await this.db
      .select()
      .from(eventActivity)
      .where(eq(eventActivity.eventId, eventId))
      .orderBy(desc(eventActivity.createdAt))
    return rows.map(rowToActivity)
  }
}
