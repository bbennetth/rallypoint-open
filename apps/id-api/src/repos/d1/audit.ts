import { and, desc, eq, gte } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { UserId } from '@rallypoint/shared'
import { auditLog as table } from '@rallypoint/db'
import type { AuditEvent, AuditRepo } from '../types.js'
import type { Db } from './db.js'

function rowToAuditEvent(row: typeof table.$inferSelect): AuditEvent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    eventType: row.eventType,
    userId: (row.userId ?? null) as UserId | null,
    ipHash: row.ipHash,
    uaHash: row.uaHash,
    meta: (row.meta as Record<string, unknown>) ?? {},
    createdAt: row.createdAt,
  }
}

export class D1AuditRepo implements AuditRepo {
  constructor(private readonly db: Db) {}

  async write(event: {
    tenantId: string
    eventType: string
    userId: UserId | null
    ipHash: string
    uaHash: string
    meta?: Record<string, unknown>
  }): Promise<void> {
    await this.db.insert(table).values({
      id: ulid(),
      tenantId: event.tenantId,
      eventType: event.eventType,
      userId: event.userId,
      ipHash: event.ipHash,
      uaHash: event.uaHash,
      meta: event.meta ?? {},
    })
  }

  async list(opts: {
    tenantId: string
    userId?: UserId
    eventType?: string
    sinceMs?: number
    limit?: number
  }): Promise<AuditEvent[]> {
    const limit = Math.min(opts.limit ?? 100, 1000)
    const conditions = [eq(table.tenantId, opts.tenantId)]
    if (opts.userId) conditions.push(eq(table.userId, opts.userId))
    if (opts.eventType) conditions.push(eq(table.eventType, opts.eventType))
    if (opts.sinceMs) conditions.push(gte(table.createdAt, new Date(Date.now() - opts.sinceMs)))

    const rows = await this.db
      .select()
      .from(table)
      .where(and(...conditions))
      .orderBy(desc(table.createdAt))
      .limit(limit)
    return rows.map(rowToAuditEvent)
  }
}
