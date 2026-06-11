import { and, eq, gte, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { listItemSeries, listItems } from '@rallypoint/lists-db'
import {
  materializeOccurrences,
  occurrenceDueDate,
  MAX_INSTANCES_PER_SERIES,
  type DayCode,
  type RecurrenceFreq,
} from '@rallypoint/lists-shared'
import { ulid } from 'ulid'
import type {
  CreateListItemSeriesInput,
  ListItemSeriesRecord,
  ListItemSeriesRepo,
  UpdateListItemSeriesInput,
} from '../types.js'
import type { Db } from './db.js'

type Stmt = BatchItem<'sqlite'>

// Append-at-end position scalar subquery (mirrors pg impl;
// SQLite supports scalar subqueries in INSERT projections).
function appendPosition(listId: string) {
  return sql<number>`(select coalesce(max(${listItems.position}), -1) + 1 from ${listItems} where ${listItems.listId} = ${listId})`
}

function rowToRecord(row: typeof listItemSeries.$inferSelect): ListItemSeriesRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    listId: row.listId,
    title: row.title,
    notes: row.notes,
    assignedTo: row.assignedTo,
    priority: row.priority,
    freq: row.freq as RecurrenceFreq,
    interval: row.interval,
    byDay: row.byDay as DayCode[] | null,
    dtstart: row.dtstart,
    until: row.until,
    count: row.count,
    timeOfDay: row.timeOfDay,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  }
}

export class D1ListItemSeriesRepo implements ListItemSeriesRepo {
  constructor(private readonly db: Db) {}

  async create(
    listId: string,
    input: CreateListItemSeriesInput,
    actor: string,
    tenantId: string,
  ): Promise<ListItemSeriesRecord> {
    const seriesId = `lse_${ulid()}`
    const todayISO = new Date().toISOString().slice(0, 10)

    const rule = {
      freq: input.freq,
      interval: input.interval,
      byDay: input.byDay ?? null,
      dtstart: input.dtstart,
      until: input.until ?? null,
      count: input.count ?? null,
    }

    const dates = materializeOccurrences(rule, {
      from: todayISO,
      limit: MAX_INSTANCES_PER_SERIES,
    })

    // D1 has no interactive db.transaction(). Use db.batch() for atomicity.
    // Batch: [insertSeries, ...occurrenceInserts] — all land together or none.
    // D1 batch limit is ~100 statements; MAX_INSTANCES_PER_SERIES is 50, so
    // 1 series + ≤50 occurrences = ≤51 statements — well within the limit.
    const insertSeries = this.db
      .insert(listItemSeries)
      .values({
        id: seriesId,
        tenantId,
        listId,
        title: input.title,
        notes: input.notes ?? null,
        assignedTo: input.assignedTo ?? null,
        priority: input.priority ?? null,
        freq: input.freq,
        interval: input.interval,
        byDay: input.byDay ?? null,
        dtstart: input.dtstart,
        until: input.until ?? null,
        count: input.count ?? null,
        timeOfDay: input.timeOfDay ?? null,
        createdBy: actor,
      })
      .returning() as Stmt

    const occurrenceInserts: Stmt[] = dates.map((dateStr) =>
      this.db.insert(listItems).values({
        id: `lit_${ulid()}`,
        tenantId,
        listId,
        seriesId,
        occurrenceDate: dateStr,
        dueDate: new Date(occurrenceDueDate(dateStr, input.timeOfDay ?? null)),
        title: input.title,
        notes: input.notes ?? null,
        assignedTo: input.assignedTo ?? null,
        priority: input.priority ?? null,
        status: 'todo',
        position: appendPosition(listId),
        createdBy: actor,
      }) as Stmt,
    )

    const stmts: [Stmt, ...Stmt[]] = [insertSeries, ...occurrenceInserts]
    const results = await this.db.batch(stmts)

    const seriesRows = results[0] as (typeof listItemSeries.$inferSelect)[]
    return rowToRecord(seriesRows[0]!)
  }

  async findById(id: string): Promise<ListItemSeriesRecord | null> {
    const rows = await this.db
      .select()
      .from(listItemSeries)
      .where(eq(listItemSeries.id, id))
      .limit(1)
    return rows[0] ? rowToRecord(rows[0]) : null
  }

  async list(listId: string): Promise<ListItemSeriesRecord[]> {
    const rows = await this.db
      .select()
      .from(listItemSeries)
      .where(and(eq(listItemSeries.listId, listId), isNull(listItemSeries.deletedAt)))
      .orderBy(listItemSeries.createdAt)
    return rows.map(rowToRecord)
  }

  async update(
    id: string,
    patch: UpdateListItemSeriesInput,
    _actor: string,
  ): Promise<ListItemSeriesRecord | null> {
    const todayISO = new Date().toISOString().slice(0, 10)

    // D1 has no interactive db.transaction(). We use a READ-DRIVEN approach:
    // 1. Pre-read the live series row + protected occurrence dates OUTSIDE the
    //    batch (D1 doesn't allow reads inside batch()).
    // 2. Compute the occurrence set in JS.
    // 3. Issue db.batch([updateSeries, softDeleteFutureLive, ...newInserts]).
    //
    // The batch is atomic; if updateSeries returns zero rows (series was
    // deleted concurrently) we treat that as 404 — same semantics as the
    // Postgres impl (which checks RETURNING inside the transaction).

    // Step 1a: Read the current live series row.
    const existingRows = await this.db
      .select()
      .from(listItemSeries)
      .where(and(eq(listItemSeries.id, id), isNull(listItemSeries.deletedAt)))
      .limit(1)
    if (!existingRows[0]) return null

    const existing = existingRows[0]

    // Build the merged series fields (what we will write).
    const merged = {
      freq: (patch.freq ?? existing.freq) as RecurrenceFreq,
      interval: patch.interval ?? existing.interval,
      byDay: (patch.byDay !== undefined ? patch.byDay : existing.byDay) as DayCode[] | null,
      dtstart: patch.dtstart ?? existing.dtstart,
      until: patch.until !== undefined ? patch.until : existing.until,
      count: patch.count !== undefined ? patch.count : existing.count,
      title: patch.title ?? existing.title,
      notes: patch.notes !== undefined ? patch.notes : existing.notes,
      assignedTo: patch.assignedTo !== undefined ? patch.assignedTo : existing.assignedTo,
      priority: patch.priority !== undefined ? patch.priority : existing.priority,
      timeOfDay: patch.timeOfDay !== undefined ? patch.timeOfDay : existing.timeOfDay,
    }

    // Step 1b: Read protected occurrence dates.
    // Protected = live exception rows OR soft-deleted non-exception rows
    // (same logic as the pg impl).
    const protectedRows = await this.db
      .select({ occurrenceDate: listItems.occurrenceDate })
      .from(listItems)
      .where(
        and(
          eq(listItems.seriesId, id),
          gte(listItems.occurrenceDate, todayISO),
          or(
            and(eq(listItems.isException, true), isNull(listItems.deletedAt)),
            and(eq(listItems.isException, false), isNotNull(listItems.deletedAt)),
          ),
        ),
      )
    const excluded = new Set(protectedRows.map((r) => r.occurrenceDate).filter(Boolean) as string[])

    // Step 2: Compute new occurrence dates in JS.
    const rule = {
      freq: merged.freq,
      interval: merged.interval,
      byDay: merged.byDay,
      dtstart: merged.dtstart,
      until: merged.until ?? null,
      count: merged.count ?? null,
    }
    const dates = materializeOccurrences(rule, {
      from: todayISO,
      limit: MAX_INSTANCES_PER_SERIES,
    })

    // Step 3: Build the batch.
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (patch.title !== undefined) set.title = patch.title
    if (patch.notes !== undefined) set.notes = patch.notes
    if (patch.assignedTo !== undefined) set.assignedTo = patch.assignedTo
    if (patch.priority !== undefined) set.priority = patch.priority
    if (patch.freq !== undefined) set.freq = patch.freq
    if (patch.interval !== undefined) set.interval = patch.interval
    if (patch.byDay !== undefined) set.byDay = patch.byDay
    if (patch.dtstart !== undefined) set.dtstart = patch.dtstart
    if (patch.until !== undefined) set.until = patch.until
    if (patch.count !== undefined) set.count = patch.count
    if (patch.timeOfDay !== undefined) set.timeOfDay = patch.timeOfDay

    const updateSeries = this.db
      .update(listItemSeries)
      .set(set)
      .where(and(eq(listItemSeries.id, id), isNull(listItemSeries.deletedAt)))
      .returning() as Stmt

    const softDeleteFutureLive = this.db
      .update(listItems)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(listItems.seriesId, id),
          gte(listItems.occurrenceDate, todayISO),
          eq(listItems.isException, false),
          isNull(listItems.deletedAt),
        ),
      ) as Stmt

    const newInserts: Stmt[] = dates
      .filter((dateStr) => !excluded.has(dateStr))
      .map((dateStr) =>
        this.db.insert(listItems).values({
          id: `lit_${ulid()}`,
          tenantId: existing.tenantId,
          listId: existing.listId,
          seriesId: id,
          occurrenceDate: dateStr,
          dueDate: new Date(occurrenceDueDate(dateStr, merged.timeOfDay)),
          title: merged.title,
          notes: merged.notes,
          assignedTo: merged.assignedTo,
          priority: merged.priority,
          status: 'todo',
          position: appendPosition(existing.listId),
          createdBy: existing.createdBy,
        }) as Stmt,
      )

    const stmts: [Stmt, ...Stmt[]] = [updateSeries, softDeleteFutureLive, ...newInserts]
    const results = await this.db.batch(stmts)

    // updateSeries is first; zero RETURNING rows ⇒ series was deleted
    // concurrently between our pre-read and the batch — treat as 404.
    const updatedRows = results[0] as (typeof listItemSeries.$inferSelect)[]
    if (!updatedRows[0]) return null

    return rowToRecord(updatedRows[0])
  }

  async softDelete(id: string, _actor: string): Promise<boolean> {
    const todayISO = new Date().toISOString().slice(0, 10)
    const now = new Date()

    // D1 has no interactive db.transaction(). Use db.batch() for atomicity.
    // Batch: [softDeleteSeries, softDeleteOccurrences]. Inspect the first
    // stmt's RETURNING: zero rows ⇒ series was already deleted (bail = false).
    const softDeleteSeries = this.db
      .update(listItemSeries)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(listItemSeries.id, id), isNull(listItemSeries.deletedAt)))
      .returning({ id: listItemSeries.id }) as Stmt

    const softDeleteOccurrences = this.db
      .update(listItems)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(listItems.seriesId, id),
          gte(listItems.occurrenceDate, todayISO),
          eq(listItems.isException, false),
          isNull(listItems.deletedAt),
        ),
      ) as Stmt

    const [seriesResult] = await this.db.batch([softDeleteSeries, softDeleteOccurrences])
    const deletedSeries = seriesResult as { id: string }[]

    // Zero RETURNING rows ⇒ already deleted.
    return deletedSeries.length > 0
  }
}
