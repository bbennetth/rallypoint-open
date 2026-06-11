import { asc, eq } from 'drizzle-orm'
import { eventNoGoZones } from '@rallypoint/events-db'
import type { EventNoGoZoneRepo, PatchZoneInput, ZoneRecord, ZoneVertex } from '../types.js'
import type { Db } from './db.js'

function rowToZone(row: typeof eventNoGoZones.$inferSelect): ZoneRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    mapId: row.mapId,
    polygon: (row.polygon as ZoneVertex[]) ?? [],
  }
}

export class D1EventNoGoZoneRepo implements EventNoGoZoneRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    id: string
    eventId: string
    mapId: string
    polygon: ZoneVertex[]
  }): Promise<ZoneRecord> {
    const [row] = await this.db.insert(eventNoGoZones).values(input).returning()
    return rowToZone(row!)
  }

  async findById(id: string): Promise<ZoneRecord | null> {
    const rows = await this.db
      .select()
      .from(eventNoGoZones)
      .where(eq(eventNoGoZones.id, id))
      .limit(1)
    return rows[0] ? rowToZone(rows[0]) : null
  }

  async listForEvent(eventId: string): Promise<ZoneRecord[]> {
    const rows = await this.db
      .select()
      .from(eventNoGoZones)
      .where(eq(eventNoGoZones.eventId, eventId))
      .orderBy(asc(eventNoGoZones.id))
    return rows.map(rowToZone)
  }

  async update(id: string, fields: PatchZoneInput): Promise<ZoneRecord | null> {
    const set: Record<string, unknown> = {}
    if (fields.mapId !== undefined) set.mapId = fields.mapId
    if (fields.polygon !== undefined) set.polygon = fields.polygon
    if (Object.keys(set).length === 0) return this.findById(id)
    const [row] = await this.db
      .update(eventNoGoZones)
      .set(set)
      .where(eq(eventNoGoZones.id, id))
      .returning()
    return row ? rowToZone(row) : null
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(eventNoGoZones)
      .where(eq(eventNoGoZones.id, id))
      .returning({ id: eventNoGoZones.id })
    return rows.length > 0
  }
}
