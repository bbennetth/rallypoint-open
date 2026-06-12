import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { listItems, listStatuses } from '@rallypoint/lists-db'
import type { StatusCategory } from '@rallypoint/lists-shared'
import type {
  CreateListStatusInput,
  ListStatusRecord,
  ListStatusRepo,
  UpdateListStatusInput,
} from '../types.js'
import type { Db } from './db.js'

// Append-at-end position scalar subquery (mirrors field-defs; SQLite
// supports scalar subqueries in INSERT projections).
function appendPosition(listId: string) {
  return sql<number>`(select coalesce(max(${listStatuses.position}), -1) + 1 from ${listStatuses} where ${listStatuses.listId} = ${listId})`
}

function rowToStatus(row: typeof listStatuses.$inferSelect): ListStatusRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    listId: row.listId,
    name: row.name,
    color: row.color,
    category: row.category as StatusCategory,
    position: row.position,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  }
}

export class D1ListStatusRepo implements ListStatusRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateListStatusInput): Promise<ListStatusRecord> {
    const position = input.position ?? appendPosition(input.listId)
    const [row] = await this.db
      .insert(listStatuses)
      .values({
        id: input.id,
        tenantId: input.tenantId,
        listId: input.listId,
        name: input.name,
        color: input.color ?? null,
        category: input.category,
        position,
        createdBy: input.createdBy,
      })
      .returning()
    return rowToStatus(row!)
  }

  async findById(id: string): Promise<ListStatusRecord | null> {
    const rows = await this.db
      .select()
      .from(listStatuses)
      .where(eq(listStatuses.id, id))
      .limit(1)
    return rows[0] ? rowToStatus(rows[0]) : null
  }

  async listForList(
    listId: string,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<ListStatusRecord[]> {
    const conds = [eq(listStatuses.listId, listId)]
    if (!opts.includeDeleted) conds.push(isNull(listStatuses.deletedAt))
    const rows = await this.db
      .select()
      .from(listStatuses)
      .where(and(...conds))
      .orderBy(asc(listStatuses.position), asc(listStatuses.createdAt), asc(listStatuses.id))
    return rows.map(rowToStatus)
  }

  async seedDefaults(
    listId: string,
    tenantId: string,
    createdBy: string,
    seeds: { id: string; name: string; color: string; category: StatusCategory }[],
  ): Promise<ListStatusRecord[]> {
    if (seeds.length === 0) return []
    const rows = await this.db
      .insert(listStatuses)
      .values(
        seeds.map((s, i) => ({
          id: s.id,
          tenantId,
          listId,
          name: s.name,
          color: s.color,
          category: s.category,
          position: i,
          createdBy,
        })),
      )
      .returning()
    return rows.map(rowToStatus)
  }

  async update(id: string, fields: UpdateListStatusInput): Promise<ListStatusRecord | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (fields.name !== undefined) set.name = fields.name
    if (fields.color !== undefined) set.color = fields.color
    if (fields.category !== undefined) set.category = fields.category
    if (fields.position !== undefined) set.position = fields.position
    const [row] = await this.db
      .update(listStatuses)
      .set(set)
      .where(eq(listStatuses.id, id))
      .returning()
    return row ? rowToStatus(row) : null
  }

  async softDelete(id: string, when: Date): Promise<void> {
    await this.db
      .update(listStatuses)
      .set({ deletedAt: when, updatedAt: new Date() })
      .where(eq(listStatuses.id, id))
  }

  async reassignItems(
    listId: string,
    fromStatusId: string,
    to: { statusId: string | null; status: StatusCategory | null; completed: boolean },
  ): Promise<number> {
    const rows = await this.db
      .update(listItems)
      .set({
        statusId: to.statusId,
        status: to.status,
        completed: to.completed,
        completedAt: to.completed ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(listItems.listId, listId),
          eq(listItems.statusId, fromStatusId),
          isNull(listItems.deletedAt),
        ),
      )
      .returning({ id: listItems.id })
    return rows.length
  }
}
