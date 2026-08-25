import { and, desc, eq, lt, or } from 'drizzle-orm'
import { ledgerActivity } from '@rallypoint/money-db'
import type {
  LedgerActivityPage,
  LedgerActivityRecord,
  LedgerActivityRepo,
  RecordLedgerActivityInput,
} from '../types.js'
import type { Db } from './db.js'

function rowToActivity(
  row: typeof ledgerActivity.$inferSelect,
): LedgerActivityRecord {
  return {
    id: row.id,
    ledgerId: row.ledgerId,
    actorUserId: row.actorUserId,
    eventType: row.eventType,
    // meta is stored as text JSON in the SQLite schema (text {mode:'json'}).
    // Drizzle sqlite-core with mode:'json' returns the parsed object directly.
    meta: (row.meta ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
  }
}

export class D1LedgerActivityRepo implements LedgerActivityRepo {
  constructor(private readonly db: Db) {}

  async record(input: RecordLedgerActivityInput): Promise<void> {
    await this.db.insert(ledgerActivity).values({
      id: input.id,
      ledgerId: input.ledgerId,
      actorUserId: input.actorUserId,
      eventType: input.eventType,
      meta: input.meta ?? {},
    })
  }

  async listForLedger(
    ledgerId: string,
    opts?: { limit?: number; cursor?: string | null },
  ): Promise<LedgerActivityPage> {
    const limit = opts?.limit ?? 50
    const conds = [eq(ledgerActivity.ledgerId, ledgerId)]
    const cursor = opts?.cursor ? decodeCursor(opts.cursor) : null
    if (cursor) {
      conds.push(
        or(
          lt(ledgerActivity.createdAt, cursor.at),
          and(eq(ledgerActivity.createdAt, cursor.at), lt(ledgerActivity.id, cursor.id)),
        )!,
      )
    }
    const rows = await this.db
      .select()
      .from(ledgerActivity)
      .where(and(...conds))
      .orderBy(desc(ledgerActivity.createdAt), desc(ledgerActivity.id))
      .limit(limit + 1)

    const mapped = rows.map(rowToActivity)
    const hasMore = mapped.length > limit
    const items = hasMore ? mapped.slice(0, limit) : mapped
    const nextCursor = hasMore && items.length > 0 ? encodeCursor(items[items.length - 1]!) : null
    return { items, nextCursor }
  }
}

function encodeCursor(r: LedgerActivityRecord): string {
  return Buffer.from(`${r.createdAt.toISOString()}|${r.id}`, 'utf8').toString('base64url')
}
function decodeCursor(c: string): { at: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(c, 'base64url').toString('utf8').split('|')
    if (!iso || !id) return null
    const at = new Date(iso)
    return Number.isNaN(at.getTime()) ? null : { at, id }
  } catch {
    return null
  }
}
