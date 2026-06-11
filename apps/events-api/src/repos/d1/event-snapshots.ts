import { and, desc, eq, notInArray } from 'drizzle-orm'
import { eventSnapshots } from '@rallypoint/events-db'
import type {
  CreateSnapshotInput,
  EventSnapshotRepo,
  SnapshotKind,
  SnapshotRecord,
  SnapshotSummary,
} from '../types.js'
import type { Db } from './db.js'

function rowToSnapshot(row: typeof eventSnapshots.$inferSelect): SnapshotRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    kind: row.kind as SnapshotKind,
    data: row.data,
    reason: row.reason,
    itemCount: row.itemCount,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
  }
}

export class D1EventSnapshotRepo implements EventSnapshotRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateSnapshotInput): Promise<SnapshotRecord> {
    const [row] = await this.db
      .insert(eventSnapshots)
      .values({
        id: input.id,
        eventId: input.eventId,
        kind: input.kind,
        data: input.data as unknown[],
        reason: input.reason,
        itemCount: input.itemCount,
        createdByUserId: input.createdByUserId,
      })
      .returning()
    return rowToSnapshot(row!)
  }

  async findById(id: string): Promise<SnapshotRecord | null> {
    const rows = await this.db
      .select()
      .from(eventSnapshots)
      .where(eq(eventSnapshots.id, id))
      .limit(1)
    return rows[0] ? rowToSnapshot(rows[0]) : null
  }

  async listForEvent(eventId: string, kind: SnapshotKind): Promise<SnapshotSummary[]> {
    const rows = await this.db
      .select({
        id: eventSnapshots.id,
        eventId: eventSnapshots.eventId,
        kind: eventSnapshots.kind,
        reason: eventSnapshots.reason,
        itemCount: eventSnapshots.itemCount,
        createdByUserId: eventSnapshots.createdByUserId,
        createdAt: eventSnapshots.createdAt,
      })
      .from(eventSnapshots)
      .where(and(eq(eventSnapshots.eventId, eventId), eq(eventSnapshots.kind, kind)))
      .orderBy(desc(eventSnapshots.createdAt), desc(eventSnapshots.id))
    return rows.map((r) => ({ ...r, kind: r.kind as SnapshotKind }))
  }

  async prune(eventId: string, kind: SnapshotKind, keep: number): Promise<number> {
    const newest = await this.db
      .select({ id: eventSnapshots.id })
      .from(eventSnapshots)
      .where(and(eq(eventSnapshots.eventId, eventId), eq(eventSnapshots.kind, kind)))
      .orderBy(desc(eventSnapshots.createdAt), desc(eventSnapshots.id))
      .limit(keep)
    if (newest.length < keep) return 0
    const keepIds = newest.map((r) => r.id)
    const deleted = await this.db
      .delete(eventSnapshots)
      .where(
        and(
          eq(eventSnapshots.eventId, eventId),
          eq(eventSnapshots.kind, kind),
          notInArray(eventSnapshots.id, keepIds),
        ),
      )
      .returning({ id: eventSnapshots.id })
    return deleted.length
  }
}
