import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { eventAttendees } from '@rallypoint/events-db'
import type {
  AttendeeCursor,
  AttendeeRecord,
  EventAttendeeRepo,
} from '../types.js'
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
    opts: { limit: number; cursor: AttendeeCursor | null },
  ): Promise<{ items: AttendeeRecord[]; nextCursor: AttendeeCursor | null }> {
    // Composite cursor filter (audit E3 #25):
    //   (joined_at, id) > (cursor.joinedAt, cursor.id)
    // Expressed as: joined_at > c.joinedAt
    //               OR (joined_at = c.joinedAt AND id > c.id)
    // Combined with the (joined_at, id) ASC ordering, this excludes the
    // cursor row itself but admits any later-id ties on c.joinedAt.
    // Use drizzle's typed comparators (not a raw `sql` template): joined_at is
    // stored as timestamp_ms, so gt()/eq() convert the Date cursor to epoch ms.
    // A raw `sql\`… > ${date}\`` would bind a Date object the D1 driver can't
    // serialize (500). id is text — gt() binds the string with SQLite's default
    // collation, preserving the '' legacy-heal boundary semantics.
    const cursorFilter = opts.cursor
      ? or(
          gt(eventAttendees.joinedAt, opts.cursor.joinedAt),
          and(
            eq(eventAttendees.joinedAt, opts.cursor.joinedAt),
            gt(eventAttendees.id, opts.cursor.id),
          ),
        )
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
      .orderBy(asc(eventAttendees.joinedAt), asc(eventAttendees.id))
      .limit(opts.limit + 1)
    const items = rows.slice(0, opts.limit).map(rowToAttendee)
    const nextCursor =
      rows.length > opts.limit
        ? { joinedAt: rows[opts.limit - 1]!.joinedAt, id: rows[opts.limit - 1]!.id }
        : null
    return { items, nextCursor }
  }
}
