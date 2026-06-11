import { desc, eq } from 'drizzle-orm'
import { settlements } from '@rallypoint/money-db'
import type {
  CreateSettlementInput,
  SettlementRecord,
  SettlementRepo,
} from '../types.js'
import type { Db } from './db.js'

function rowToSettlement(row: typeof settlements.$inferSelect): SettlementRecord {
  return {
    id: row.id,
    ledgerId: row.ledgerId,
    fromUserId: row.fromUserId,
    toUserId: row.toUserId,
    amountCents: row.amountCents,
    note: row.note ?? null,
    settledAt: row.settledAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }
}

export class D1SettlementRepo implements SettlementRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateSettlementInput): Promise<SettlementRecord> {
    const rows = await this.db
      .insert(settlements)
      .values({
        id: input.id,
        ledgerId: input.ledgerId,
        fromUserId: input.fromUserId,
        toUserId: input.toUserId,
        amountCents: input.amountCents,
        note: input.note ?? null,
        settledAt: input.settledAt,
        createdBy: input.createdBy,
      })
      .returning()
    return rowToSettlement(rows[0]!)
  }

  async findById(id: string): Promise<SettlementRecord | null> {
    const rows = await this.db
      .select()
      .from(settlements)
      .where(eq(settlements.id, id))
      .limit(1)
    return rows[0] ? rowToSettlement(rows[0]) : null
  }

  async listForLedger(ledgerId: string): Promise<SettlementRecord[]> {
    const rows = await this.db
      .select()
      .from(settlements)
      .where(eq(settlements.ledgerId, ledgerId))
      .orderBy(desc(settlements.settledAt), desc(settlements.id))
    return rows.map(rowToSettlement)
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(settlements)
      .where(eq(settlements.id, id))
      .returning({ id: settlements.id })
    return rows.length > 0
  }
}
