import { asc, eq, inArray } from 'drizzle-orm'
import { eventDays } from '@rallypoint/events-db'
import type { DayRecord, EventDayRepo } from '../types.js'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'
import type { BatchItem } from 'drizzle-orm/batch'

// PG `time` round-trips as 'HH:MM:SS'; SQLite stores it as text in the
// same format. Normalise to 'HH:MM' to match what callers send.
function toHm(t: string | null | undefined): string | null {
  return t == null ? null : t.slice(0, 5)
}

function rowToDay(row: typeof eventDays.$inferSelect): DayRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    dayLabel: row.dayLabel,
    date: row.date,
    startTime: toHm(row.startTime),
    endTime: toHm(row.endTime),
    sortOrder: row.sortOrder,
  }
}

export class D1EventDayRepo implements EventDayRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    id: string
    eventId: string
    dayLabel: string
    date: string
    startTime?: string | null
    endTime?: string | null
    sortOrder?: number
  }): Promise<DayRecord> {
    try {
      const [row] = await this.db
        .insert(eventDays)
        .values({
          id: input.id,
          eventId: input.eventId,
          dayLabel: input.dayLabel,
          date: input.date,
          startTime: input.startTime ?? null,
          endTime: input.endTime ?? null,
          sortOrder: input.sortOrder ?? 0,
        })
        .returning()
      return rowToDay(row!)
    } catch (err) {
      throw mapUniqueViolation(err)
    }
  }

  async createMany(
    rows: { id: string; eventId: string; dayLabel: string; date: string; sortOrder?: number }[],
  ): Promise<DayRecord[]> {
    if (rows.length === 0) return []
    // Static write-set → db.batch([...]) — atomic, no FOR UPDATE needed.
    try {
      const stmts: BatchItem<'sqlite'>[] = rows.map((r) =>
        this.db
          .insert(eventDays)
          .values({
            id: r.id,
            eventId: r.eventId,
            dayLabel: r.dayLabel,
            date: r.date,
            sortOrder: r.sortOrder ?? 0,
          })
          .returning(),
      )
      const results = await this.db.batch(
        stmts as unknown as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]
      )
      return (results as unknown as (typeof eventDays.$inferSelect)[][]).flat().map(rowToDay)
    } catch (err) {
      throw mapUniqueViolation(err)
    }
  }

  async findById(id: string): Promise<DayRecord | null> {
    const rows = await this.db.select().from(eventDays).where(eq(eventDays.id, id)).limit(1)
    return rows[0] ? rowToDay(rows[0]) : null
  }

  async listForEvent(eventId: string): Promise<DayRecord[]> {
    const rows = await this.db
      .select()
      .from(eventDays)
      .where(eq(eventDays.eventId, eventId))
      .orderBy(asc(eventDays.sortOrder), asc(eventDays.date))
    return rows.map(rowToDay)
  }

  async listForEventsIn(eventIds: string[]): Promise<DayRecord[]> {
    if (eventIds.length === 0) return []
    const rows = await this.db
      .select()
      .from(eventDays)
      .where(inArray(eventDays.eventId, eventIds))
      .orderBy(asc(eventDays.sortOrder), asc(eventDays.date))
    return rows.map(rowToDay)
  }

  async update(
    id: string,
    fields: {
      dayLabel?: string
      date?: string
      startTime?: string | null
      endTime?: string | null
      sortOrder?: number
    },
  ): Promise<DayRecord | null> {
    const set: Record<string, unknown> = {}
    if (fields.dayLabel !== undefined) set.dayLabel = fields.dayLabel
    if (fields.date !== undefined) set.date = fields.date
    if (fields.startTime !== undefined) set.startTime = fields.startTime
    if (fields.endTime !== undefined) set.endTime = fields.endTime
    if (fields.sortOrder !== undefined) set.sortOrder = fields.sortOrder
    if (Object.keys(set).length === 0) return this.findById(id)
    try {
      const [row] = await this.db.update(eventDays).set(set).where(eq(eventDays.id, id)).returning()
      return row ? rowToDay(row) : null
    } catch (err) {
      throw mapUniqueViolation(err)
    }
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(eventDays)
      .where(eq(eventDays.id, id))
      .returning({ id: eventDays.id })
    return rows.length > 0
  }
}
