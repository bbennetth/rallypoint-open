import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { listViews } from '@rallypoint/lists-db'
import { normalizeViewConfig } from '@rallypoint/lists-shared'
import type {
  CreateListViewInput,
  ListViewRecord,
  ListViewRepo,
  UpdateListViewInput,
} from '../types.js'
import type { Db } from './db.js'

// Append-at-end position scalar subquery (mirrors pg impl).
function appendPosition(listId: string) {
  return sql<number>`(select coalesce(max(${listViews.position}), -1) + 1 from ${listViews} where ${listViews.listId} = ${listId})`
}

function rowToView(row: typeof listViews.$inferSelect): ListViewRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    listId: row.listId,
    name: row.name,
    // config is a JSON column; normalize fills keys any older blob predates.
    config: normalizeViewConfig(row.config as Record<string, unknown>),
    position: row.position,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  }
}

export class D1ListViewRepo implements ListViewRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateListViewInput): Promise<ListViewRecord> {
    const position = input.position ?? appendPosition(input.listId)
    const [row] = await this.db
      .insert(listViews)
      .values({
        id: input.id,
        tenantId: input.tenantId,
        listId: input.listId,
        name: input.name,
        config: input.config,
        position,
        createdBy: input.createdBy,
      })
      .returning()
    return rowToView(row!)
  }

  async findById(id: string): Promise<ListViewRecord | null> {
    const rows = await this.db.select().from(listViews).where(eq(listViews.id, id)).limit(1)
    return rows[0] ? rowToView(rows[0]) : null
  }

  async listForList(
    listId: string,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<ListViewRecord[]> {
    const conds = [eq(listViews.listId, listId)]
    if (!opts.includeDeleted) conds.push(isNull(listViews.deletedAt))
    const rows = await this.db
      .select()
      .from(listViews)
      .where(and(...conds))
      .orderBy(asc(listViews.position), asc(listViews.createdAt), asc(listViews.id))
    return rows.map(rowToView)
  }

  async update(id: string, fields: UpdateListViewInput): Promise<ListViewRecord | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (fields.name !== undefined) set.name = fields.name
    if (fields.config !== undefined) set.config = fields.config
    if (fields.position !== undefined) set.position = fields.position
    const [row] = await this.db
      .update(listViews)
      .set(set)
      .where(eq(listViews.id, id))
      .returning()
    return row ? rowToView(row) : null
  }

  async softDelete(id: string, when: Date): Promise<void> {
    await this.db
      .update(listViews)
      .set({ deletedAt: when, updatedAt: new Date() })
      .where(eq(listViews.id, id))
  }
}
