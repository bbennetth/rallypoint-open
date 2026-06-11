import { desc, eq } from 'drizzle-orm'
import { eventPurgeLog } from '@rallypoint/events-db'
import type { EventPurgeLogRepo, PurgeLogRecord } from '../types.js'
import type { Db } from './db.js'

function rowToPurgeLog(row: typeof eventPurgeLog.$inferSelect): PurgeLogRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    ownerUserId: row.ownerUserId,
    tenantId: row.tenantId,
    deletedAt: row.deletedAt,
    purgedAt: row.purgedAt,
    daysAfterGrace: row.daysAfterGrace,
    objectsReaped: row.objectsReaped,
    objectsFailed: row.objectsFailed,
    meta: ((row.meta as Record<string, unknown> | null) ?? {}) as Record<string, unknown>,
  }
}

export class D1EventPurgeLogRepo implements EventPurgeLogRepo {
  constructor(private readonly db: Db) {}

  async record(input: {
    id: string
    eventId: string
    ownerUserId: string
    tenantId: string
    deletedAt: Date
    daysAfterGrace: number
    objectsReaped: number
    objectsFailed: number
    meta?: Record<string, unknown>
  }): Promise<void> {
    await this.db.insert(eventPurgeLog).values({
      id: input.id,
      eventId: input.eventId,
      ownerUserId: input.ownerUserId,
      tenantId: input.tenantId,
      deletedAt: input.deletedAt,
      daysAfterGrace: input.daysAfterGrace,
      objectsReaped: input.objectsReaped,
      objectsFailed: input.objectsFailed,
      meta: input.meta ?? {},
    })
  }

  async listForEvent(eventId: string): Promise<PurgeLogRecord[]> {
    const rows = await this.db
      .select()
      .from(eventPurgeLog)
      .where(eq(eventPurgeLog.eventId, eventId))
      .orderBy(desc(eventPurgeLog.purgedAt))
    return rows.map(rowToPurgeLog)
  }
}
