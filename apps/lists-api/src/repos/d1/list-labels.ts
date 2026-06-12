import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { listItemLabels, listLabels } from '@rallypoint/lists-db'
import type { CreateLabelInput, ListLabelRecord, ListLabelRepo, UpdateLabelInput } from '../types.js'
import type { Db } from './db.js'

// Append-at-end position scalar subquery (mirrors list-statuses.ts).
function appendPosition(listId: string) {
  return sql<number>`(select coalesce(max(${listLabels.position}), -1) + 1 from ${listLabels} where ${listLabels.listId} = ${listId})`
}

function rowToLabel(row: typeof listLabels.$inferSelect): ListLabelRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    listId: row.listId,
    name: row.name,
    color: row.color,
    position: row.position,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  }
}

export class D1ListLabelRepo implements ListLabelRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateLabelInput): Promise<ListLabelRecord> {
    const position = input.position ?? appendPosition(input.listId)
    const [row] = await this.db
      .insert(listLabels)
      .values({
        id: input.id,
        tenantId: input.tenantId,
        listId: input.listId,
        name: input.name,
        color: input.color ?? null,
        position,
      })
      .returning()
    return rowToLabel(row!)
  }

  async findById(id: string): Promise<ListLabelRecord | null> {
    const rows = await this.db
      .select()
      .from(listLabels)
      .where(eq(listLabels.id, id))
      .limit(1)
    return rows[0] ? rowToLabel(rows[0]) : null
  }

  async listForList(
    listId: string,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<ListLabelRecord[]> {
    const conds = [eq(listLabels.listId, listId)]
    if (!opts.includeDeleted) conds.push(isNull(listLabels.deletedAt))
    const rows = await this.db
      .select()
      .from(listLabels)
      .where(and(...conds))
      .orderBy(asc(listLabels.position), asc(listLabels.createdAt), asc(listLabels.id))
    return rows.map(rowToLabel)
  }

  async update(id: string, fields: UpdateLabelInput): Promise<ListLabelRecord | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (fields.name !== undefined) set.name = fields.name
    if (fields.color !== undefined) set.color = fields.color
    if (fields.position !== undefined) set.position = fields.position
    const [row] = await this.db
      .update(listLabels)
      .set(set)
      .where(eq(listLabels.id, id))
      .returning()
    return row ? rowToLabel(row) : null
  }

  async softDelete(id: string, when: Date): Promise<void> {
    await this.db
      .update(listLabels)
      .set({ deletedAt: when, updatedAt: new Date() })
      .where(eq(listLabels.id, id))
  }

  // Replace the full label set for one item. Delete-then-insert so the
  // join table stays consistent (no partial updates).
  async setItemLabels(itemId: string, labelIds: string[]): Promise<void> {
    await this.db
      .delete(listItemLabels)
      .where(eq(listItemLabels.itemId, itemId))
    if (labelIds.length === 0) return
    await this.db
      .insert(listItemLabels)
      .values(labelIds.map((labelId) => ({ itemId, labelId })))
  }

  // Batch: map itemId → label ids for the given items. One query via
  // inArray so a list GET doesn't fan out per item. Joins to listLabels and
  // filters soft-deleted labels so a stale join row (e.g. if a label is ever
  // soft-deleted without the route's join-purge) can't leak a dead id; rows
  // are ordered by the label's position for a stable per-item chip order.
  async labelsForItems(itemIds: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>()
    if (itemIds.length === 0) return result
    const rows = await this.db
      .select({ itemId: listItemLabels.itemId, labelId: listItemLabels.labelId })
      .from(listItemLabels)
      .innerJoin(listLabels, eq(listItemLabels.labelId, listLabels.id))
      .where(and(inArray(listItemLabels.itemId, itemIds), isNull(listLabels.deletedAt)))
      .orderBy(asc(listLabels.position), asc(listLabels.id))
    for (const row of rows) {
      const arr = result.get(row.itemId) ?? []
      arr.push(row.labelId)
      result.set(row.itemId, arr)
    }
    return result
  }

  // Hard-purge join rows when a label is soft-deleted so it stops
  // appearing on items immediately.
  async removeLabelFromAllItems(labelId: string): Promise<void> {
    await this.db
      .delete(listItemLabels)
      .where(eq(listItemLabels.labelId, labelId))
  }
}
