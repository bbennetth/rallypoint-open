import { asc, eq } from 'drizzle-orm'
import { eventPois } from '@rallypoint/events-db'
import type { EventPoiRepo, PatchPoiInput, PoiRecord } from '../types.js'
import type { Db } from './db.js'

function num(n: number | null | undefined): number | null {
  return n === null || n === undefined ? null : n
}

function rowToPoi(row: typeof eventPois.$inferSelect): PoiRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    mapId: row.mapId ?? null,
    categoryId: row.categoryId,
    name: row.name,
    description: row.description ?? null,
    // SQLite stores xPct/yPct/lat/lng as real; surface as strings to match
    // the types.ts contract (numeric(8,5)/(9,6) came back as strings in PG).
    xPct: row.xPct != null ? String(row.xPct) : '0',
    yPct: row.yPct != null ? String(row.yPct) : '0',
    lat: row.lat != null ? String(row.lat) : null,
    lng: row.lng != null ? String(row.lng) : null,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export class D1EventPoiRepo implements EventPoiRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    id: string
    eventId: string
    mapId?: string | null
    categoryId: string
    name: string
    description?: string | null
    xPct: number
    yPct: number
    lat?: number | null
    lng?: number | null
    sortOrder?: number | undefined
  }): Promise<PoiRecord> {
    const [row] = await this.db
      .insert(eventPois)
      .values({
        id: input.id,
        eventId: input.eventId,
        mapId: input.mapId ?? null,
        categoryId: input.categoryId,
        name: input.name,
        description: input.description ?? null,
        xPct: input.xPct,
        yPct: input.yPct,
        lat: num(input.lat),
        lng: num(input.lng),
        sortOrder: input.sortOrder ?? 0,
      })
      .returning()
    return rowToPoi(row!)
  }

  async findById(id: string): Promise<PoiRecord | null> {
    const rows = await this.db.select().from(eventPois).where(eq(eventPois.id, id)).limit(1)
    return rows[0] ? rowToPoi(rows[0]) : null
  }

  async listForEvent(eventId: string): Promise<PoiRecord[]> {
    const rows = await this.db
      .select()
      .from(eventPois)
      .where(eq(eventPois.eventId, eventId))
      .orderBy(asc(eventPois.sortOrder), asc(eventPois.createdAt))
    return rows.map(rowToPoi)
  }

  async update(id: string, fields: PatchPoiInput): Promise<PoiRecord | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (fields.mapId !== undefined) set.mapId = fields.mapId
    if (fields.categoryId !== undefined) set.categoryId = fields.categoryId
    if (fields.name !== undefined) set.name = fields.name
    if (fields.description !== undefined) set.description = fields.description
    if (fields.xPct !== undefined) set.xPct = fields.xPct
    if (fields.yPct !== undefined) set.yPct = fields.yPct
    if (fields.lat !== undefined) set.lat = num(fields.lat)
    if (fields.lng !== undefined) set.lng = num(fields.lng)
    if (fields.sortOrder !== undefined) set.sortOrder = fields.sortOrder
    const [row] = await this.db
      .update(eventPois)
      .set(set)
      .where(eq(eventPois.id, id))
      .returning()
    return row ? rowToPoi(row) : null
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(eventPois)
      .where(eq(eventPois.id, id))
      .returning({ id: eventPois.id })
    return rows.length > 0
  }
}
