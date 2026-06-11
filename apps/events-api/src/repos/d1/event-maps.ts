import { asc, eq } from 'drizzle-orm'
import { eventMaps } from '@rallypoint/events-db'
import type { EventMapRepo, MapRecord } from '../types.js'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'

function rowToMap(row: typeof eventMaps.$inferSelect): MapRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    layer: row.layer,
    objectKey: row.objectKey,
    contentType: row.contentType,
    bytes: row.bytes,
    widthPx: row.widthPx,
    heightPx: row.heightPx,
    uploadedByUserId: row.uploadedByUserId,
    uploadedAt: row.uploadedAt,
  }
}

export class D1EventMapRepo implements EventMapRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    id: string
    eventId: string
    layer: string
    objectKey: string
    contentType: string
    bytes: number
    widthPx: number
    heightPx: number
    uploadedByUserId: string
  }): Promise<MapRecord> {
    try {
      const [row] = await this.db.insert(eventMaps).values(input).returning()
      return rowToMap(row!)
    } catch (err) {
      throw mapUniqueViolation(err)
    }
  }

  async findById(id: string): Promise<MapRecord | null> {
    const rows = await this.db.select().from(eventMaps).where(eq(eventMaps.id, id)).limit(1)
    return rows[0] ? rowToMap(rows[0]) : null
  }

  async listForEvent(eventId: string): Promise<MapRecord[]> {
    const rows = await this.db
      .select()
      .from(eventMaps)
      .where(eq(eventMaps.eventId, eventId))
      .orderBy(asc(eventMaps.layer))
    return rows.map(rowToMap)
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(eventMaps)
      .where(eq(eventMaps.id, id))
      .returning({ id: eventMaps.id })
    return rows.length > 0
  }
}
