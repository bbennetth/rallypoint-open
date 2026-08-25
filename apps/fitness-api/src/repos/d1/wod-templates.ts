import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import { wodTemplates } from '@rallypoint/fitness-db'
import type { StrengthBody, WodBody } from '@rallypoint/fitness-shared'
import type {
  NewCustomWodTemplate,
  PatchWodTemplateFields,
  WodTemplateFilter,
  WodTemplateRecord,
  WodTemplateRepo,
  WodType,
} from '../types.js'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'

type WodTemplateRow = typeof wodTemplates.$inferSelect

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

function rowToRecord(row: WodTemplateRow): WodTemplateRecord {
  // Legacy rows have kind=null in D1 — surface them as 'wod' so callers
  // never see null. New strength templates write 'strength' explicitly.
  const kind = (row.kind ?? 'wod') as 'wod' | 'strength'
  // `body` is stored as the JSON-encoded form of the matching body
  // schema (wodBodySchema for kind=wod, strengthBodySchema for
  // kind=strength). It was validated by the route on write; we parse
  // opaquely here.
  const body = JSON.parse(row.body) as WodBody | StrengthBody
  if (kind === 'strength') {
    return {
      id: row.id,
      name: row.name,
      ownerUserId: row.ownerUserId ?? null,
      kind: 'strength',
      wodType: null,
      timeCapS: null,
      description: row.description ?? null,
      body: body as StrengthBody,
      isBenchmark: row.isBenchmark,
      ref: row.ref ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.ownerUserId ?? null,
    kind: 'wod',
    wodType: row.wodType as WodType,
    timeCapS: row.timeCapS ?? null,
    description: row.description ?? null,
    body: body as WodBody,
    isBenchmark: row.isBenchmark,
    ref: row.ref ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export class D1WodTemplateRepo implements WodTemplateRepo {
  constructor(private readonly db: Db) {}

  async listForActor(
    actorUserId: string,
    filter: WodTemplateFilter,
  ): Promise<WodTemplateRecord[]> {
    // Visible = curated global (owner NULL) OR the actor's own custom rows.
    // benchmarkOnly forces the global subset (isBenchmark = true on those).
    const visible = filter.benchmarkOnly
      ? and(isNull(wodTemplates.ownerUserId), eq(wodTemplates.isBenchmark, true))!
      : or(
          isNull(wodTemplates.ownerUserId),
          eq(wodTemplates.ownerUserId, actorUserId),
        )!
    const conds = [visible]
    if (filter.customOnly) conds.push(eq(wodTemplates.ownerUserId, actorUserId))
    if (filter.wodType) conds.push(eq(wodTemplates.wodType, filter.wodType))
    if (filter.kind) {
      // Legacy benchmark rows have kind=NULL in D1 and are surfaced as
      // kind='wod' by rowToRecord(). For a filter of 'wod' we need to
      // include those NULLs too (otherwise the benchmark seed
      // disappears from `?kind=wod` results).
      if (filter.kind === 'wod') {
        conds.push(or(isNull(wodTemplates.kind), eq(wodTemplates.kind, 'wod'))!)
      } else {
        conds.push(eq(wodTemplates.kind, filter.kind))
      }
    }
    if (filter.q && filter.q.trim()) {
      const needle = `%${escapeLike(filter.q.trim())}%`
      conds.push(sql`lower(${wodTemplates.name}) LIKE lower(${needle}) ESCAPE '\\'`)
    }
    const rows = await this.db
      .select()
      .from(wodTemplates)
      .where(and(...conds))
      .orderBy(asc(sql`lower(${wodTemplates.name})`))
    return rows.map(rowToRecord)
  }

  async getForActor(actorUserId: string, id: string): Promise<WodTemplateRecord | null> {
    const rows = await this.db
      .select()
      .from(wodTemplates)
      .where(
        and(
          eq(wodTemplates.id, id),
          or(
            isNull(wodTemplates.ownerUserId),
            eq(wodTemplates.ownerUserId, actorUserId),
          ),
        ),
      )
      .limit(1)
    const row = rows[0]
    return row ? rowToRecord(row) : null
  }

  async findCustomByName(
    actorUserId: string,
    name: string,
    kind: 'wod' | 'strength',
  ): Promise<WodTemplateRecord | null> {
    // Match the UNIQUE index (owner_user_id, kind, lower(name)) from
    // migration 0011 — a name collision across kinds is two distinct
    // rows, so the find-or-create on POST must scope to the same kind
    // as the incoming payload (code-review bugfix F1).
    const rows = await this.db
      .select()
      .from(wodTemplates)
      .where(
        and(
          eq(wodTemplates.ownerUserId, actorUserId),
          eq(wodTemplates.kind, kind),
          sql`lower(${wodTemplates.name}) = lower(${name})`,
        ),
      )
      .limit(1)
    const row = rows[0]
    return row ? rowToRecord(row) : null
  }

  async findByOwnerAndRef(actorUserId: string, ref: string): Promise<WodTemplateRecord | null> {
    const rows = await this.db
      .select()
      .from(wodTemplates)
      .where(and(eq(wodTemplates.ownerUserId, actorUserId), eq(wodTemplates.ref, ref)))
      .limit(1)
    const row = rows[0]
    return row ? rowToRecord(row) : null
  }

  async createCustom(input: NewCustomWodTemplate): Promise<WodTemplateRecord> {
    const now = new Date()
    // Strength templates leave wodType + timeCapS null in the DB; the
    // wodType column is NOT NULL in the schema, so we stuff the kind
    // string in there as a sentinel ("strength"). Reads use the `kind`
    // column to discriminate, not wodType, so this is just storage-side
    // bookkeeping that keeps the legacy NOT NULL constraint satisfied.
    const dbWodType = input.kind === 'strength' ? 'strength' : input.wodType
    const dbTimeCapS = input.kind === 'strength' ? null : input.timeCapS
    const ref = input.ref ?? null
    try {
      await this.db.insert(wodTemplates).values({
        id: input.id,
        name: input.name,
        ownerUserId: input.ownerUserId,
        kind: input.kind,
        wodType: dbWodType,
        timeCapS: dbTimeCapS,
        description: input.description,
        body: JSON.stringify(input.body),
        isBenchmark: false,
        ref,
        createdAt: now,
        updatedAt: now,
      })
    } catch (err) {
      throw mapUniqueViolation(err)
    }
    if (input.kind === 'strength') {
      return {
        id: input.id,
        name: input.name,
        ownerUserId: input.ownerUserId,
        kind: 'strength',
        wodType: null,
        timeCapS: null,
        description: input.description,
        body: input.body,
        isBenchmark: false,
        ref,
        createdAt: now,
        updatedAt: now,
      }
    }
    return {
      id: input.id,
      name: input.name,
      ownerUserId: input.ownerUserId,
      kind: 'wod',
      wodType: input.wodType,
      timeCapS: input.timeCapS,
      description: input.description,
      body: input.body,
      isBenchmark: false,
      ref,
      createdAt: now,
      updatedAt: now,
    }
  }

  async update(
    userId: string,
    id: string,
    fields: PatchWodTemplateFields,
  ): Promise<WodTemplateRecord | null> {
    const existing = await this.getForActor(userId, id)
    // Owner check: globally-owned rows aren't editable. Treat as not found
    // for the actor so we don't leak the existence of admin-side rows.
    if (!existing || existing.ownerUserId !== userId) return null

    const now = new Date()
    const updateVals: Partial<typeof wodTemplates.$inferInsert> & { updatedAt: Date } = {
      updatedAt: now,
    }
    if (fields.name !== undefined) updateVals.name = fields.name
    if ('description' in fields) updateVals.description = fields.description ?? null
    // timeCapS only applies to WOD-kind rows; ignore it on strength rows
    // so a stray field in the PATCH body doesn't accidentally set a
    // non-null timeCapS on a strength row.
    if ('timeCapS' in fields && existing.kind === 'wod') {
      updateVals.timeCapS = fields.timeCapS ?? null
    }
    // Body edits replace the JSON body wholesale. Strength rows take a
    // strength body; custom wod rows take a wod body (+ optional wodType
    // change from the composer's type chip). Route-gated on kind +
    // isBenchmark; the kind checks here are belt-and-braces.
    if (fields.strengthBody !== undefined && existing.kind === 'strength') {
      updateVals.body = JSON.stringify(fields.strengthBody)
    }
    if (fields.wodBody !== undefined && existing.kind === 'wod' && !existing.isBenchmark) {
      updateVals.body = JSON.stringify(fields.wodBody)
      if (fields.wodType !== undefined) updateVals.wodType = fields.wodType
    }

    try {
      // Scope the UPDATE to both id AND ownerUserId so a concurrent
      // owner-change or delete between the ownership check above and this
      // write cannot mutate a row the actor no longer owns. Without the
      // owner predicate, a TOCTOU race on the ownership pre-check lets
      // the UPDATE land on the wrong (or already-deleted) row.
      await this.db
        .update(wodTemplates)
        .set(updateVals)
        .where(and(eq(wodTemplates.id, id), eq(wodTemplates.ownerUserId, userId)))
    } catch (err) {
      throw mapUniqueViolation(err)
    }

    // Re-select the row from D1 so a concurrent delete (race between the
    // ownership check above and the UPDATE landing) returns null rather than
    // a stale in-memory view, letting the route 404 correctly.
    return this.getForActor(userId, id)
  }

  async delete(userId: string, id: string): Promise<boolean> {
    // Verify ownership before delete; a delete of a global benchmark from a
    // user request returns false (route maps to 404).
    const rows = await this.db
      .select({ id: wodTemplates.id })
      .from(wodTemplates)
      .where(and(eq(wodTemplates.id, id), eq(wodTemplates.ownerUserId, userId)))
      .limit(1)
    if (rows.length === 0) return false
    await this.db.delete(wodTemplates).where(eq(wodTemplates.id, id))
    return true
  }
}
