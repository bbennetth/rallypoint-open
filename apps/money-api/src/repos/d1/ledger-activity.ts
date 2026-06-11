import { desc, eq } from 'drizzle-orm'
import { ledgerActivity } from '@rallypoint/money-db'
import type {
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
    opts?: { limit?: number },
  ): Promise<LedgerActivityRecord[]> {
    const q = this.db
      .select()
      .from(ledgerActivity)
      .where(eq(ledgerActivity.ledgerId, ledgerId))
      .orderBy(desc(ledgerActivity.createdAt), desc(ledgerActivity.id))
    const rows = opts?.limit !== undefined ? await q.limit(opts.limit) : await q
    return rows.map(rowToActivity)
  }
}
