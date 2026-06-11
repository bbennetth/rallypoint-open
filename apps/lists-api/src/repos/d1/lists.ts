import { and, desc, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { lists, listItems, listInvites, listShares } from '@rallypoint/lists-db'
import type { ListType, ScopeType, Visibility } from '@rallypoint/lists-shared'
import type { CreateListInput, ListRecord, ListRepo, ListScope } from '../types.js'
import type { Db } from './db.js'

type Stmt = BatchItem<'sqlite'>

function rowToList(
  row: typeof lists.$inferSelect & { incompleteCount?: number },
): ListRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    scopeType: row.scopeType as ScopeType,
    scopeId: row.scopeId,
    listType: row.listType as ListType,
    name: row.name,
    visibility: row.visibility as Visibility,
    color: row.color,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    incompleteCount: row.incompleteCount ?? 0,
  }
}

export class D1ListRepo implements ListRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateListInput): Promise<ListRecord> {
    const rows = await this.db
      .insert(lists)
      .values({
        id: input.id,
        tenantId: input.tenantId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        listType: input.listType,
        name: input.name,
        visibility: input.visibility,
        color: input.color ?? null,
        createdBy: input.createdBy,
      })
      .returning()
    return rowToList(rows[0]!)
  }

  async findById(id: string): Promise<ListRecord | null> {
    const rows = await this.db.select().from(lists).where(eq(lists.id, id)).limit(1)
    return rows[0] ? rowToList(rows[0]) : null
  }

  async findByIds(ids: string[]): Promise<(ListRecord | null)[]> {
    if (ids.length === 0) return []
    // Single query; result set may be in any order, so re-map to input order.
    // No chunking: SQLite/D1 caps bound parameters (~999 by default), so a
    // caller passing thousands of ids would error. Current callers are
    // bounded by a user's planner-flagged lists — nowhere near the limit.
    const rows = await this.db.select().from(lists).where(inArray(lists.id, ids))
    const byId = new Map<string, ListRecord>(rows.map((r) => [r.id, rowToList(r)]))
    return ids.map((id) => byId.get(id) ?? null)
  }

  async listForScope(scope: ListScope): Promise<ListRecord[]> {
    // Correlated subquery for incompleteCount: SQLite supports scalar
    // subqueries in a SELECT projection just like Postgres. The `${lists}.id`
    // fragment emits `"lists"."id"` (table-qualified) so the correlation
    // binds correctly.
    const rows = await this.db
      .select({
        ...getTableColumns(lists),
        incompleteCount: sql<number>`(
          select count(*) from ${listItems}
          where ${listItems.listId} = ${lists}.${sql.identifier('id')}
            and ${listItems.deletedAt} is null
            and ${listItems.completed} = 0
        )`,
      })
      .from(lists)
      .where(
        and(
          isNull(lists.deletedAt),
          eq(lists.tenantId, scope.tenantId),
          eq(lists.scopeType, scope.scopeType),
          eq(lists.scopeId, scope.scopeId),
        ),
      )
      .orderBy(desc(lists.createdAt), desc(lists.id))
    return rows.map(rowToList)
  }

  async softDelete(id: string, when: Date): Promise<void> {
    await this.db
      .update(lists)
      .set({ deletedAt: when, updatedAt: new Date() })
      .where(eq(lists.id, id))
  }

  async acceptInvite(input: {
    shareId: string
    inviteId: string
    listId: string
    userId: string
    addedByUserId: string
  }): Promise<
    | { ok: true }
    | { ok: false; reason: 'already_shared' | 'invite_already_consumed' }
  > {
    // D1 has no interactive db.transaction(). Use db.batch() for atomicity.
    //
    // Ordering matters under concurrent accept races by different users:
    //   1. CONSUME first via a conditional UPDATE (consumed_at IS NULL → set now).
    //      Returns a row only for the winner; the loser sees 0 RETURNING rows.
    //   2. INSERT the share with ON CONFLICT DO NOTHING.
    //
    // We use app-side new Date() instead of SQL now() because D1's
    // unixepoch()-based timestamps are integer milliseconds, and the schema
    // maps them via { mode: 'timestamp_ms' }.
    const now = new Date()

    const consumeInvite = this.db
      .update(listInvites)
      .set({ consumedAt: now, consumedByUserId: input.userId })
      .where(and(eq(listInvites.id, input.inviteId), isNull(listInvites.consumedAt)))
      .returning({ id: listInvites.id })

    const insertShare = this.db
      .insert(listShares)
      .values({
        id: input.shareId,
        listId: input.listId,
        userId: input.userId,
        addedByUserId: input.addedByUserId,
      })
      .onConflictDoNothing({ target: [listShares.listId, listShares.userId] })
      .returning({ id: listShares.id })

    const [consumeResult, shareResult] = await this.db.batch([
      consumeInvite as Stmt,
      insertShare as Stmt,
    ])

    // D1 batch is atomic and runs in submission order. Inspect RETURNING to
    // derive the outcome — same semantics as the Postgres tx but without an
    // interactive transaction.
    const consumed = (consumeResult as Awaited<typeof consumeInvite>)
    const inserted = (shareResult as Awaited<typeof insertShare>)

    if (consumed.length === 0) {
      return { ok: false as const, reason: 'invite_already_consumed' as const }
    }
    if (inserted.length === 0) {
      return { ok: false as const, reason: 'already_shared' as const }
    }
    return { ok: true as const }
  }
}
