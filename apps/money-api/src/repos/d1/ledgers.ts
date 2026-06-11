import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { ledgers } from '@rallypoint/money-db'
import type {
  CreateLedgerInput,
  LedgerRecord,
  LedgerRepo,
  PatchLedgerInput,
} from '../types.js'
import type { Db } from './db.js'

function rowToLedger(row: typeof ledgers.$inferSelect): LedgerRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    ownerUserId: row.ownerUserId,
    name: row.name,
    currency: row.currency,
    description: row.description ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  }
}

export class D1LedgerRepo implements LedgerRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateLedgerInput): Promise<LedgerRecord> {
    const rows = await this.db
      .insert(ledgers)
      .values({
        id: input.id,
        tenantId: input.tenantId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        ownerUserId: input.ownerUserId,
        name: input.name,
        currency: input.currency,
        description: input.description ?? null,
      })
      .returning()
    return rowToLedger(rows[0]!)
  }

  async findById(id: string): Promise<LedgerRecord | null> {
    const rows = await this.db.select().from(ledgers).where(eq(ledgers.id, id)).limit(1)
    return rows[0] ? rowToLedger(rows[0]) : null
  }

  async listForOwner(ownerUserId: string): Promise<LedgerRecord[]> {
    const rows = await this.db
      .select()
      .from(ledgers)
      .where(and(isNull(ledgers.deletedAt), eq(ledgers.ownerUserId, ownerUserId)))
      .orderBy(desc(ledgers.createdAt), desc(ledgers.id))
    return rows.map(rowToLedger)
  }

  async listForScope(input: {
    tenantId: string
    scopeType: string
    scopeId: string
  }): Promise<LedgerRecord[]> {
    const rows = await this.db
      .select()
      .from(ledgers)
      .where(
        and(
          isNull(ledgers.deletedAt),
          eq(ledgers.tenantId, input.tenantId),
          eq(ledgers.scopeType, input.scopeType),
          eq(ledgers.scopeId, input.scopeId),
        ),
      )
      // Oldest first: a group's "default" ledger is the first one attached.
      .orderBy(asc(ledgers.createdAt), asc(ledgers.id))
    return rows.map(rowToLedger)
  }

  async patch(id: string, fields: PatchLedgerInput): Promise<LedgerRecord | null> {
    const set: Partial<typeof ledgers.$inferInsert> = { updatedAt: new Date() }
    if (fields.name !== undefined) set.name = fields.name
    if (fields.description !== undefined) set.description = fields.description
    const rows = await this.db
      .update(ledgers)
      .set(set)
      .where(and(eq(ledgers.id, id), isNull(ledgers.deletedAt)))
      .returning()
    return rows[0] ? rowToLedger(rows[0]) : null
  }

  async softDelete(id: string, when: Date): Promise<boolean> {
    const rows = await this.db
      .update(ledgers)
      .set({ deletedAt: when, updatedAt: when })
      .where(and(eq(ledgers.id, id), isNull(ledgers.deletedAt)))
      .returning({ id: ledgers.id })
    return rows.length > 0
  }

  async transferOwnership(input: {
    ledgerId: string
    newOwnerUserId: string
  }): Promise<LedgerRecord | null> {
    const rows = await this.db
      .update(ledgers)
      .set({ ownerUserId: input.newOwnerUserId, updatedAt: new Date() })
      .where(and(eq(ledgers.id, input.ledgerId), isNull(ledgers.deletedAt)))
      .returning()
    return rows[0] ? rowToLedger(rows[0]) : null
  }
}
