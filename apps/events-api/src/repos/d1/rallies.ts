import { asc, eq } from 'drizzle-orm'
import { rallies } from '@rallypoint/events-db'
import type { CreateRallyInput, PatchRallyInput, RallyRecord, RallyRepo, RallyStatus } from '../types.js'
import type { Db } from './db.js'

function rowToRally(row: typeof rallies.$inferSelect): RallyRecord {
  return {
    id: row.id,
    groupId: row.groupId,
    eventId: row.eventId,
    title: row.title,
    description: row.description ?? null,
    dayId: row.dayId ?? null,
    startTime: row.startTime ?? null,
    poiId: row.poiId ?? null,
    locationLabel: row.locationLabel ?? null,
    lat: row.lat != null ? String(row.lat) : null,
    lng: row.lng != null ? String(row.lng) : null,
    status: row.status as RallyStatus,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export class D1RallyRepo implements RallyRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateRallyInput): Promise<RallyRecord> {
    // lat/lng arrive as string | null from the API contract; the schema
    // column is `real` (number | null). Parse them back to float.
    const latNum = input.lat != null ? parseFloat(input.lat) : null
    const lngNum = input.lng != null ? parseFloat(input.lng) : null
    const [row] = await this.db
      .insert(rallies)
      .values({
        id: input.id,
        groupId: input.groupId,
        eventId: input.eventId,
        title: input.title,
        description: input.description ?? null,
        dayId: input.dayId ?? null,
        startTime: input.startTime ?? null,
        poiId: input.poiId ?? null,
        locationLabel: input.locationLabel ?? null,
        lat: latNum,
        lng: lngNum,
        status: input.status ?? 'proposed',
        createdBy: input.createdBy,
      })
      .returning()
    return rowToRally(row!)
  }

  async findById(id: string): Promise<RallyRecord | null> {
    const rows = await this.db.select().from(rallies).where(eq(rallies.id, id)).limit(1)
    return rows[0] ? rowToRally(rows[0]) : null
  }

  async listForGroup(groupId: string): Promise<RallyRecord[]> {
    const rows = await this.db
      .select()
      .from(rallies)
      .where(eq(rallies.groupId, groupId))
      .orderBy(asc(rallies.createdAt))
    return rows.map(rowToRally)
  }

  async patch(id: string, fields: PatchRallyInput): Promise<RallyRecord | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (fields.title !== undefined) set.title = fields.title
    if (fields.description !== undefined) set.description = fields.description
    if (fields.dayId !== undefined) set.dayId = fields.dayId
    if (fields.startTime !== undefined) set.startTime = fields.startTime
    if (fields.poiId !== undefined) set.poiId = fields.poiId
    if (fields.locationLabel !== undefined) set.locationLabel = fields.locationLabel
    if (fields.lat !== undefined) set.lat = fields.lat != null ? parseFloat(fields.lat) : null
    if (fields.lng !== undefined) set.lng = fields.lng != null ? parseFloat(fields.lng) : null
    if (fields.status !== undefined) set.status = fields.status

    const [row] = await this.db.update(rallies).set(set).where(eq(rallies.id, id)).returning()
    return row ? rowToRally(row) : null
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db.delete(rallies).where(eq(rallies.id, id)).returning({ id: rallies.id })
    return rows.length > 0
  }
}
