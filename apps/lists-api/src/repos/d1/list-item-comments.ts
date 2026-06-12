import { and, asc, eq, isNull } from 'drizzle-orm'
import { listItemComments } from '@rallypoint/lists-db'
import type {
  CreateListItemCommentInput,
  ListItemCommentRecord,
  ListItemCommentRepo,
  UpdateListItemCommentInput,
} from '../types.js'
import type { Db } from './db.js'

function rowToComment(row: typeof listItemComments.$inferSelect): ListItemCommentRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    itemId: row.itemId,
    authorId: row.authorId,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  }
}

export class D1ListItemCommentRepo implements ListItemCommentRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateListItemCommentInput): Promise<ListItemCommentRecord> {
    const [row] = await this.db
      .insert(listItemComments)
      .values({
        id: input.id,
        tenantId: input.tenantId,
        itemId: input.itemId,
        authorId: input.authorId,
        body: input.body,
      })
      .returning()
    return rowToComment(row!)
  }

  async findById(id: string): Promise<ListItemCommentRecord | null> {
    const rows = await this.db
      .select()
      .from(listItemComments)
      .where(eq(listItemComments.id, id))
      .limit(1)
    return rows[0] ? rowToComment(rows[0]) : null
  }

  async listForItem(
    itemId: string,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<ListItemCommentRecord[]> {
    const conds = [eq(listItemComments.itemId, itemId)]
    if (!opts.includeDeleted) conds.push(isNull(listItemComments.deletedAt))
    const rows = await this.db
      .select()
      .from(listItemComments)
      .where(and(...conds))
      .orderBy(asc(listItemComments.createdAt), asc(listItemComments.id))
    return rows.map(rowToComment)
  }

  async update(id: string, fields: UpdateListItemCommentInput): Promise<ListItemCommentRecord | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (fields.body !== undefined) set.body = fields.body
    const [row] = await this.db
      .update(listItemComments)
      .set(set)
      .where(eq(listItemComments.id, id))
      .returning()
    return row ? rowToComment(row) : null
  }

  async softDelete(id: string, when: Date): Promise<void> {
    await this.db
      .update(listItemComments)
      .set({ deletedAt: when, updatedAt: new Date() })
      .where(eq(listItemComments.id, id))
  }
}
