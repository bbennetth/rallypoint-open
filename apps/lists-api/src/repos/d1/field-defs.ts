import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { listFieldDefs } from '@rallypoint/lists-db'
import type { FieldDefOptions, FieldType } from '@rallypoint/lists-shared'
import type {
  CreateFieldDefInput,
  FieldDefRecord,
  FieldDefRepo,
  UpdateFieldDefInput,
} from '../types.js'
import type { Db } from './db.js'

// Append-at-end position scalar subquery (mirrors pg impl; SQLite supports
// scalar subqueries in INSERT projections).
function appendPosition(listId: string) {
  return sql<number>`(select coalesce(max(${listFieldDefs.position}), -1) + 1 from ${listFieldDefs} where ${listFieldDefs.listId} = ${listId})`
}

function rowToDef(row: typeof listFieldDefs.$inferSelect): FieldDefRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    listId: row.listId,
    key: row.key,
    label: row.label,
    fieldType: row.fieldType as FieldType,
    options: (row.options ?? {}) as FieldDefOptions,
    required: row.required,
    defaultValue: row.defaultValue,
    position: row.position,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  }
}

export class D1FieldDefRepo implements FieldDefRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateFieldDefInput): Promise<FieldDefRecord> {
    const position = input.position ?? appendPosition(input.listId)
    const [row] = await this.db
      .insert(listFieldDefs)
      .values({
        id: input.id,
        tenantId: input.tenantId,
        listId: input.listId,
        key: input.key,
        label: input.label,
        fieldType: input.fieldType,
        options: input.options,
        required: input.required ?? false,
        defaultValue: input.defaultValue ?? null,
        position,
        createdBy: input.createdBy,
      })
      .returning()
    return rowToDef(row!)
  }

  async findById(id: string): Promise<FieldDefRecord | null> {
    const rows = await this.db
      .select()
      .from(listFieldDefs)
      .where(eq(listFieldDefs.id, id))
      .limit(1)
    return rows[0] ? rowToDef(rows[0]) : null
  }

  async listForList(
    listId: string,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<FieldDefRecord[]> {
    const conds = [eq(listFieldDefs.listId, listId)]
    if (!opts.includeDeleted) conds.push(isNull(listFieldDefs.deletedAt))
    const rows = await this.db
      .select()
      .from(listFieldDefs)
      .where(and(...conds))
      .orderBy(asc(listFieldDefs.position), asc(listFieldDefs.createdAt), asc(listFieldDefs.id))
    return rows.map(rowToDef)
  }

  async update(id: string, fields: UpdateFieldDefInput): Promise<FieldDefRecord | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (fields.label !== undefined) set.label = fields.label
    if (fields.options !== undefined) set.options = fields.options
    if (fields.required !== undefined) set.required = fields.required
    if (fields.position !== undefined) set.position = fields.position
    const [row] = await this.db
      .update(listFieldDefs)
      .set(set)
      .where(eq(listFieldDefs.id, id))
      .returning()
    return row ? rowToDef(row) : null
  }

  async softDelete(id: string, when: Date): Promise<void> {
    await this.db
      .update(listFieldDefs)
      .set({ deletedAt: when, updatedAt: new Date() })
      .where(eq(listFieldDefs.id, id))
  }
}
