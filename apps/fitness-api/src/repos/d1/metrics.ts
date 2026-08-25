import { and, desc, eq, gte, lte } from 'drizzle-orm'
import { metrics } from '@rallypoint/fitness-db'
import type {
  MetricListFilter,
  MetricRecord,
  MetricRepo,
  NewMetric,
  PatchMetricFields,
} from '../types.js'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'

type MetricRow = typeof metrics.$inferSelect

function rowToRecord(row: MetricRow): MetricRecord {
  return {
    id: row.id,
    userId: row.userId,
    recordedAt: row.recordedAt,
    kind: row.kind,
    value: row.value,
    unit: row.unit ?? null,
    note: row.note ?? null,
    ref: row.ref ?? null,
    createdAt: row.createdAt,
  }
}

export class D1MetricRepo implements MetricRepo {
  constructor(private readonly db: Db) {}

  async listForActor(userId: string, filter: MetricListFilter): Promise<MetricRecord[]> {
    const limit = Math.min(filter.limit ?? 200, 1000)

    const conds = [eq(metrics.userId, userId)]
    if (filter.kind) conds.push(eq(metrics.kind, filter.kind))
    if (filter.from) conds.push(gte(metrics.recordedAt, filter.from))
    if (filter.to) conds.push(lte(metrics.recordedAt, filter.to))

    const rows = await this.db
      .select()
      .from(metrics)
      .where(and(...conds))
      .orderBy(desc(metrics.recordedAt))
      .limit(limit)

    return rows.map(rowToRecord)
  }

  async getForActor(userId: string, id: string): Promise<MetricRecord | null> {
    const rows = await this.db
      .select()
      .from(metrics)
      .where(and(eq(metrics.id, id), eq(metrics.userId, userId)))
      .limit(1)

    const row = rows[0]
    return row ? rowToRecord(row) : null
  }

  async findByUserAndRef(userId: string, ref: string): Promise<MetricRecord | null> {
    const rows = await this.db
      .select()
      .from(metrics)
      .where(and(eq(metrics.userId, userId), eq(metrics.ref, ref)))
      .limit(1)
    const row = rows[0]
    return row ? rowToRecord(row) : null
  }

  async create(input: NewMetric): Promise<MetricRecord> {
    const now = new Date()
    const insertRow: typeof metrics.$inferInsert = {
      id: input.id,
      userId: input.userId,
      recordedAt: input.recordedAt,
      kind: input.kind,
      value: input.value,
      ref: input.ref ?? null,
      createdAt: now,
    }
    if (input.unit !== undefined) insertRow.unit = input.unit
    if (input.note !== undefined) insertRow.note = input.note

    try {
      await this.db.insert(metrics).values(insertRow)
    } catch (err) {
      throw mapUniqueViolation(err)
    }

    return {
      id: input.id,
      userId: input.userId,
      recordedAt: input.recordedAt,
      kind: input.kind,
      value: input.value,
      unit: input.unit ?? null,
      note: input.note ?? null,
      ref: input.ref ?? null,
      createdAt: now,
    }
  }

  async update(
    userId: string,
    id: string,
    fields: PatchMetricFields,
  ): Promise<MetricRecord | null> {
    // Verify ownership first.
    const existing = await this.getForActor(userId, id)
    if (!existing) return null

    const updateVals: Partial<typeof metrics.$inferInsert> = {}
    if (fields.recordedAt !== undefined) updateVals.recordedAt = fields.recordedAt
    if (fields.value !== undefined) updateVals.value = fields.value
    if ('unit' in fields) updateVals.unit = fields.unit ?? null
    if ('note' in fields) updateVals.note = fields.note ?? null

    await this.db.update(metrics).set(updateVals).where(eq(metrics.id, id))

    return {
      ...existing,
      ...(fields.recordedAt !== undefined ? { recordedAt: fields.recordedAt } : {}),
      ...(fields.value !== undefined ? { value: fields.value } : {}),
      ...('unit' in fields ? { unit: fields.unit ?? null } : {}),
      ...('note' in fields ? { note: fields.note ?? null } : {}),
    }
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: metrics.id })
      .from(metrics)
      .where(and(eq(metrics.id, id), eq(metrics.userId, userId)))
      .limit(1)
    if (rows.length === 0) return false

    await this.db.delete(metrics).where(eq(metrics.id, id))
    return true
  }
}
