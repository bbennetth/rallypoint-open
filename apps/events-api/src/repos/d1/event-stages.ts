import { asc, eq } from 'drizzle-orm'
import { eventStages } from '@rallypoint/events-db'
import type { EventStageRepo, StageRecord } from '../types.js'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'

function rowToStage(row: typeof eventStages.$inferSelect): StageRecord {
  return { id: row.id, eventId: row.eventId, name: row.name, sortOrder: row.sortOrder }
}

export class D1EventStageRepo implements EventStageRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    id: string
    eventId: string
    name: string
    sortOrder?: number
  }): Promise<StageRecord> {
    try {
      const [row] = await this.db
        .insert(eventStages)
        .values({
          id: input.id,
          eventId: input.eventId,
          name: input.name,
          sortOrder: input.sortOrder ?? 0,
        })
        .returning()
      return rowToStage(row!)
    } catch (err) {
      throw mapUniqueViolation(err)
    }
  }

  async findById(id: string): Promise<StageRecord | null> {
    const rows = await this.db.select().from(eventStages).where(eq(eventStages.id, id)).limit(1)
    return rows[0] ? rowToStage(rows[0]) : null
  }

  async listForEvent(eventId: string): Promise<StageRecord[]> {
    const rows = await this.db
      .select()
      .from(eventStages)
      .where(eq(eventStages.eventId, eventId))
      .orderBy(asc(eventStages.sortOrder), asc(eventStages.name))
    return rows.map(rowToStage)
  }

  async update(
    id: string,
    fields: { name?: string; sortOrder?: number },
  ): Promise<StageRecord | null> {
    const set: Record<string, unknown> = {}
    if (fields.name !== undefined) set.name = fields.name
    if (fields.sortOrder !== undefined) set.sortOrder = fields.sortOrder
    if (Object.keys(set).length === 0) return this.findById(id)
    try {
      const [row] = await this.db
        .update(eventStages)
        .set(set)
        .where(eq(eventStages.id, id))
        .returning()
      return row ? rowToStage(row) : null
    } catch (err) {
      throw mapUniqueViolation(err)
    }
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(eventStages)
      .where(eq(eventStages.id, id))
      .returning({ id: eventStages.id })
    return rows.length > 0
  }
}
