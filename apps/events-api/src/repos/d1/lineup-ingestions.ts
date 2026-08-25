import { and, desc, eq } from 'drizzle-orm'
import { lineupIngestions } from '@rallypoint/events-db'
import type {
  CreateLineupIngestionInput,
  LineupIngestionRecord,
  LineupIngestionRepo,
  LineupIngestionSourceKind,
  LineupIngestionStatus,
} from '../types.js'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // A row we wrote can't be unparseable, but never let a corrupt row
    // take the review queue down — surface the raw text instead.
    return text
  }
}

function rowToRecord(row: typeof lineupIngestions.$inferSelect): LineupIngestionRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    sourceKind: row.sourceKind as LineupIngestionSourceKind,
    sourceUrl: row.sourceUrl,
    sourceExcerpt: row.sourceExcerpt,
    model: row.model,
    extracted: parseJson(row.extracted),
    proposal: parseJson(row.proposal),
    status: row.status as LineupIngestionStatus,
    error: row.error,
    aiResponseId: row.aiResponseId,
    createdBy: row.createdBy,
    reviewedBy: row.reviewedBy,
    createdAt: row.createdAt,
    reviewedAt: row.reviewedAt,
  }
}

export class D1LineupIngestionRepo implements LineupIngestionRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateLineupIngestionInput): Promise<LineupIngestionRecord> {
    try {
      const [row] = await this.db
        .insert(lineupIngestions)
        .values({
          id: input.id,
          eventId: input.eventId,
          sourceKind: input.sourceKind,
          sourceUrl: input.sourceUrl ?? null,
          sourceExcerpt: input.sourceExcerpt,
          model: input.model,
          extracted: JSON.stringify(input.extracted),
          proposal: JSON.stringify(input.proposal),
          status: input.status ?? 'pending',
          error: input.error ?? null,
          aiResponseId: input.aiResponseId ?? null,
          createdBy: input.createdBy,
        })
        .returning()
      return rowToRecord(row!)
    } catch (err) {
      // Concurrent ingest lost the race on the one-pending-per-event
      // partial unique index.
      throw mapUniqueViolation(err)
    }
  }

  async findById(id: string): Promise<LineupIngestionRecord | null> {
    const rows = await this.db
      .select()
      .from(lineupIngestions)
      .where(eq(lineupIngestions.id, id))
      .limit(1)
    return rows[0] ? rowToRecord(rows[0]) : null
  }

  async listForEvent(
    eventId: string,
    opts: { status?: LineupIngestionStatus | undefined } = {},
  ): Promise<LineupIngestionRecord[]> {
    const where = opts.status
      ? and(eq(lineupIngestions.eventId, eventId), eq(lineupIngestions.status, opts.status))
      : eq(lineupIngestions.eventId, eventId)
    const rows = await this.db
      .select()
      .from(lineupIngestions)
      .where(where)
      .orderBy(desc(lineupIngestions.createdAt), desc(lineupIngestions.id))
    return rows.map(rowToRecord)
  }

  async markSuperseded(eventId: string, reviewedBy: string): Promise<number> {
    const updated = await this.db
      .update(lineupIngestions)
      .set({ status: 'superseded', reviewedBy, reviewedAt: new Date() })
      .where(
        and(eq(lineupIngestions.eventId, eventId), eq(lineupIngestions.status, 'pending')),
      )
      .returning({ id: lineupIngestions.id })
    return updated.length
  }

  async decide(
    id: string,
    status: 'approved' | 'rejected',
    reviewedBy: string,
  ): Promise<LineupIngestionRecord | null> {
    const [row] = await this.db
      .update(lineupIngestions)
      .set({ status, reviewedBy, reviewedAt: new Date() })
      .where(and(eq(lineupIngestions.id, id), eq(lineupIngestions.status, 'pending')))
      .returning()
    return row ? rowToRecord(row) : null
  }
}
