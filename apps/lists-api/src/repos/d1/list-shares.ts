import { and, asc, desc, eq } from 'drizzle-orm'
import { listShares } from '@rallypoint/lists-db'
import type { ListShareRecord, ListShareRepo } from '../types.js'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'
import { UniqueConstraintError } from '../errors.js'

function rowToShare(row: typeof listShares.$inferSelect): ListShareRecord {
  return {
    id: row.id,
    listId: row.listId,
    userId: row.userId,
    addedByUserId: row.addedByUserId,
    createdAt: row.createdAt,
  }
}

export class D1ListShareRepo implements ListShareRepo {
  constructor(private readonly db: Db) {}

  async add(input: {
    id: string
    listId: string
    userId: string
    addedByUserId: string
  }): Promise<ListShareRecord> {
    try {
      const [row] = await this.db.insert(listShares).values(input).returning()
      return rowToShare(row!)
    } catch (err) {
      const mapped = mapUniqueViolation(err)
      if (mapped instanceof UniqueConstraintError) throw mapped
      throw err
    }
  }

  async findByListAndUser(listId: string, userId: string): Promise<ListShareRecord | null> {
    const rows = await this.db
      .select()
      .from(listShares)
      .where(and(eq(listShares.listId, listId), eq(listShares.userId, userId)))
      .limit(1)
    return rows[0] ? rowToShare(rows[0]) : null
  }

  async listForList(listId: string): Promise<ListShareRecord[]> {
    const rows = await this.db
      .select()
      .from(listShares)
      .where(eq(listShares.listId, listId))
      .orderBy(asc(listShares.createdAt))
    return rows.map(rowToShare)
  }

  async listForUser(userId: string): Promise<ListShareRecord[]> {
    const rows = await this.db
      .select()
      .from(listShares)
      .where(eq(listShares.userId, userId))
      .orderBy(desc(listShares.createdAt))
    return rows.map(rowToShare)
  }

  async remove(listId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .delete(listShares)
      .where(and(eq(listShares.listId, listId), eq(listShares.userId, userId)))
      .returning({ id: listShares.id })
    return rows.length > 0
  }
}
