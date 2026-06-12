import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { eventSessions } from '@rallypoint/events-db'
import type {
  BulkApplySessionsInput,
  BulkApplySessionsResult,
  CreateSessionInput,
  EventSessionRepo,
  ListSessionsOptions,
  PatchSessionInput,
  SessionApprovalStatus,
  SessionRecord,
  SessionVisibility,
} from '../types.js'
import type { Db } from './db.js'
import type { BatchItem } from 'drizzle-orm/batch'

function rowToSession(row: typeof eventSessions.$inferSelect): SessionRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    title: row.title,
    description: row.description ?? null,
    location: row.location ?? null,
    dayId: row.dayId ?? null,
    stageId: row.stageId ?? null,
    startTime: row.startTime ?? null,
    endTime: row.endTime ?? null,
    category: row.category ?? null,
    host: row.host ?? null,
    approvalStatus: row.approvalStatus as SessionApprovalStatus,
    visibility: row.visibility as SessionVisibility,
    groupId: row.groupId ?? null,
    sharedWith: (row.sharedWith as string[] | null) ?? null,
    createdByUserId: row.createdByUserId,
    submittedByUserId: row.submittedByUserId ?? null,
    approvedByUserId: row.approvedByUserId ?? null,
    approvedAt: row.approvedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
  }
}

function insertValues(c: CreateSessionInput, now: Date) {
  return {
    id: c.id,
    eventId: c.eventId,
    title: c.title,
    description: c.description ?? null,
    location: c.location ?? null,
    dayId: c.dayId ?? null,
    stageId: c.stageId ?? null,
    startTime: c.startTime ?? null,
    endTime: c.endTime ?? null,
    category: c.category ?? null,
    host: c.host ?? null,
    approvalStatus: c.approvalStatus,
    visibility: c.visibility,
    groupId: c.groupId ?? null,
    sharedWith: c.sharedWith ?? null,
    createdByUserId: c.createdByUserId,
    submittedByUserId: c.submittedByUserId ?? null,
    approvedByUserId: c.approvedByUserId ?? null,
    approvedAt: c.approvedAt ?? null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  }
}

function patchSet(fields: PatchSessionInput, now: Date): Record<string, unknown> {
  const set: Record<string, unknown> = { updatedAt: now }
  if (fields.title !== undefined) set.title = fields.title
  if (fields.description !== undefined) set.description = fields.description
  if (fields.location !== undefined) set.location = fields.location
  if (fields.dayId !== undefined) set.dayId = fields.dayId
  if (fields.stageId !== undefined) set.stageId = fields.stageId
  if (fields.startTime !== undefined) set.startTime = fields.startTime
  if (fields.endTime !== undefined) set.endTime = fields.endTime
  if (fields.category !== undefined) set.category = fields.category
  if (fields.host !== undefined) set.host = fields.host
  if (fields.visibility !== undefined) set.visibility = fields.visibility
  if (fields.groupId !== undefined) set.groupId = fields.groupId
  if (fields.sharedWith !== undefined) set.sharedWith = fields.sharedWith
  return set
}

export class D1EventSessionRepo implements EventSessionRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const now = new Date()
    const [row] = await this.db
      .insert(eventSessions)
      .values(insertValues(input, now))
      .returning()
    return rowToSession(row!)
  }

  async findById(id: string): Promise<SessionRecord | null> {
    const rows = await this.db
      .select()
      .from(eventSessions)
      .where(eq(eventSessions.id, id))
      .limit(1)
    return rows[0] ? rowToSession(rows[0]) : null
  }

  async listForEvent(eventId: string, opts?: ListSessionsOptions): Promise<SessionRecord[]> {
    const conds = [eq(eventSessions.eventId, eventId)]
    if (!opts?.includeDeleted) conds.push(isNull(eventSessions.deletedAt))
    if (opts?.approvalStatus) conds.push(eq(eventSessions.approvalStatus, opts.approvalStatus))
    if (opts?.dayId) conds.push(eq(eventSessions.dayId, opts.dayId))
    const rows = await this.db
      .select()
      .from(eventSessions)
      .where(and(...conds))
      .orderBy(desc(eventSessions.createdAt), desc(eventSessions.id))
    return rows.map(rowToSession)
  }

  async patch(id: string, fields: PatchSessionInput): Promise<SessionRecord | null> {
    const set = patchSet(fields, new Date())
    const [row] = await this.db
      .update(eventSessions)
      .set(set)
      .where(eq(eventSessions.id, id))
      .returning()
    return row ? rowToSession(row) : null
  }

  async setApproval(
    id: string,
    input: {
      status: SessionApprovalStatus
      approvedByUserId: string | null
      approvedAt: Date | null
      submittedByUserId?: string | null
    },
  ): Promise<SessionRecord | null> {
    const set: Record<string, unknown> = {
      approvalStatus: input.status,
      approvedByUserId: input.approvedByUserId,
      approvedAt: input.approvedAt,
      updatedAt: new Date(),
    }
    if (input.submittedByUserId !== undefined) set.submittedByUserId = input.submittedByUserId
    const [row] = await this.db
      .update(eventSessions)
      .set(set)
      .where(eq(eventSessions.id, id))
      .returning()
    return row ? rowToSession(row) : null
  }

  async softDelete(id: string, when: Date): Promise<void> {
    await this.db
      .update(eventSessions)
      .set({ deletedAt: when, updatedAt: new Date() })
      .where(eq(eventSessions.id, id))
  }

  async bulkApply(input: BulkApplySessionsInput): Promise<BulkApplySessionsResult> {
    // Static write-set → db.batch([...]). RETURNING works per-stmt in a batch;
    // create/update stmts come first so we can slice results at the boundary.
    const now = new Date()
    const stmts: BatchItem<'sqlite'>[] = []

    for (const c of input.creates) {
      stmts.push(this.db.insert(eventSessions).values(insertValues(c, now)).returning())
    }
    for (const u of input.updates) {
      stmts.push(
        this.db
          .update(eventSessions)
          .set(patchSet(u.patch, now))
          .where(
            and(
              eq(eventSessions.id, u.id),
              eq(eventSessions.eventId, input.eventId),
              isNull(eventSessions.deletedAt),
            ),
          )
          .returning(),
      )
    }
    for (const id of input.deletes) {
      stmts.push(
        this.db
          .update(eventSessions)
          .set({ deletedAt: now, updatedAt: now })
          .where(
            and(
              eq(eventSessions.id, id),
              eq(eventSessions.eventId, input.eventId),
              isNull(eventSessions.deletedAt),
            ),
          ),
      )
    }

    if (stmts.length === 0) return { created: [], updated: [] }

    const results = await this.db.batch(
      stmts as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]
    )
    const cEnd = input.creates.length
    const uEnd = cEnd + input.updates.length
    const created = (results.slice(0, cEnd) as (typeof eventSessions.$inferSelect)[][])
      .flatMap((r) => r)
      .map(rowToSession)
    const updated = (results.slice(cEnd, uEnd) as (typeof eventSessions.$inferSelect)[][])
      .flatMap((r) => r)
      .map(rowToSession)
    return { created, updated }
  }

  async restoreActive(
    eventId: string,
    rows: SessionRecord[],
    when: Date,
  ): Promise<SessionRecord[]> {
    // RELAXED ATOMICITY: the current active set is read OUTSIDE the batch so
    // the delete-delta can be computed in JS. A session created concurrently
    // between the pre-read and the batch execution will survive (its id was
    // not in `active` so it escapes the soft-delete list). This is an accepted
    // trade-off — snapshot restore is an infrequent operator action, and a
    // concurrently-added session remaining active is preferable to blocking.
    const keep = new Set(rows.map((r) => r.id))

    const active = await this.db
      .select({ id: eventSessions.id })
      .from(eventSessions)
      .where(and(eq(eventSessions.eventId, eventId), isNull(eventSessions.deletedAt)))
    const toDelete = active.map((a) => a.id).filter((id) => !keep.has(id))

    const stmts: BatchItem<'sqlite'>[] = []
    for (const r of rows) {
      const set = {
        eventId: r.eventId,
        title: r.title,
        description: r.description,
        location: r.location,
        dayId: r.dayId,
        stageId: r.stageId,
        startTime: r.startTime,
        endTime: r.endTime,
        category: r.category,
        host: r.host,
        approvalStatus: r.approvalStatus,
        visibility: r.visibility,
        groupId: r.groupId,
        sharedWith: r.sharedWith,
        submittedByUserId: r.submittedByUserId,
        approvedByUserId: r.approvedByUserId,
        approvedAt: r.approvedAt,
        createdByUserId: r.createdByUserId,
        createdAt: r.createdAt,
        updatedAt: when,
        deletedAt: null,
      }
      stmts.push(
        this.db
          .insert(eventSessions)
          .values({ id: r.id, ...set })
          .onConflictDoUpdate({ target: eventSessions.id, set }),
      )
    }
    if (toDelete.length > 0) {
      stmts.push(
        this.db
          .update(eventSessions)
          .set({ deletedAt: when, updatedAt: when })
          .where(and(eq(eventSessions.eventId, eventId), inArray(eventSessions.id, toDelete))),
      )
    }

    if (stmts.length > 0) {
      await this.db.batch(stmts as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
    }

    const final = await this.db
      .select()
      .from(eventSessions)
      .where(and(eq(eventSessions.eventId, eventId), isNull(eventSessions.deletedAt)))
      .orderBy(desc(eventSessions.createdAt), desc(eventSessions.id))
    return final.map(rowToSession)
  }
}
