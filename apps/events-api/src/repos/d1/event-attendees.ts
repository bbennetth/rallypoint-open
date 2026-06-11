import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm'
import { eventAttendees } from '@rallypoint/events-db'
import type { AttendeeRecord, EventAttendeeRepo } from '../types.js'
import type { Db } from './db.js'

function rowToAttendee(row: typeof eventAttendees.$inferSelect): AttendeeRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    userId: row.userId,
    joinedAt: row.joinedAt,
    removedAt: row.removedAt ?? null,
  }
}

export class D1EventAttendeeRepo implements EventAttendeeRepo {
  constructor(private readonly db: Db) {}

  async upsert(input: {
    id: string
    eventId: string
    userId: string
  }): Promise<AttendeeRecord> {
    const now = new Date()
    // Re-attendance after a soft-remove clears removed_at and refreshes
    // joined_at. The app-side `now` avoids `now()` in SQLite expressions.
    const [row] = await this.db
      .insert(eventAttendees)
      .values(input)
      .onConflictDoUpdate({
        target: [eventAttendees.eventId, eventAttendees.userId],
        set: {
          removedAt: null,
          joinedAt: sql`CASE WHEN ${eventAttendees.removedAt} IS NULL
                             THEN ${eventAttendees.joinedAt}
                             ELSE ${now.getTime()} END`,
        },
      })
      .returning()
    return rowToAttendee(row!)
  }

  async findByEventAndUser(
    eventId: string,
    userId: string,
  ): Promise<AttendeeRecord | null> {
    const rows = await this.db
      .select()
      .from(eventAttendees)
      .where(and(eq(eventAttendees.eventId, eventId), eq(eventAttendees.userId, userId)))
      .limit(1)
    return rows[0] ? rowToAttendee(rows[0]) : null
  }

  async softRemove(eventId: string, userId: string, when: Date): Promise<void> {
    await this.db
      .update(eventAttendees)
      .set({ removedAt: when })
      .where(
        and(
          eq(eventAttendees.eventId, eventId),
          eq(eventAttendees.userId, userId),
          isNull(eventAttendees.removedAt),
        ),
      )
  }

  async listForEvent(
    eventId: string,
    opts: { limit: number; cursor: Date | null },
  ): Promise<{ items: AttendeeRecord[]; nextCursor: Date | null }> {
    const cursorFilter = opts.cursor
      ? gt(eventAttendees.joinedAt, opts.cursor)
      : undefined
    const rows = await this.db
      .select()
      .from(eventAttendees)
      .where(
        and(
          eq(eventAttendees.eventId, eventId),
          isNull(eventAttendees.removedAt),
          ...(cursorFilter ? [cursorFilter] : []),
        ),
      )
      .orderBy(asc(eventAttendees.joinedAt))
      .limit(opts.limit + 1)
    const items = rows.slice(0, opts.limit).map(rowToAttendee)
    const nextCursor =
      rows.length > opts.limit ? rows[opts.limit - 1]!.joinedAt : null
    return { items, nextCursor }
  }
}
