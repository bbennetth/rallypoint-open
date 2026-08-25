import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { ledgers, ledgerMembers } from '@rallypoint/money-db'
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

  // Atomic ownership swap (audit E2 #6): demote the new owner's
  // existing member row, hand the role over on the ledger, and add the
  // old owner back as a member — all in one db.batch so D1 either
  // commits everything or nothing. Replaces the previous 3-await
  // sequence in the route handler, which on a mid-flow crash could
  // leave the old owner without ledger access AND without a member
  // row (zero recoverability short of an admin DB poke).
  //
  // Returns the updated ledger row from the UPDATE leg of the batch.
  async transferOwnershipAtomic(input: {
    ledgerId: string
    newOwnerUserId: string
    oldOwnerUserId: string
    oldOwnerMemberId: string
  }): Promise<LedgerRecord | null> {
    const results = await this.db.batch([
      this.db
        .delete(ledgerMembers)
        .where(
          and(
            eq(ledgerMembers.ledgerId, input.ledgerId),
            eq(ledgerMembers.userId, input.newOwnerUserId),
          ),
        ),
      this.db
        .update(ledgers)
        .set({ ownerUserId: input.newOwnerUserId, updatedAt: new Date() })
        .where(and(eq(ledgers.id, input.ledgerId), isNull(ledgers.deletedAt)))
        .returning(),
      this.db.insert(ledgerMembers).values({
        id: input.oldOwnerMemberId,
        ledgerId: input.ledgerId,
        userId: input.oldOwnerUserId,
        role: 'member',
      }),
    ])
    // The UPDATE is the 2nd statement; its .returning() result is at
    // index 1 of the batch results array. D1 rolls the whole batch
    // back if any one statement fails, so a missing/empty result here
    // means the ledger didn't exist (or was soft-deleted) — return
    // null and let the route surface a ledger_not_found.
    const updated = results[1] as Array<typeof ledgers.$inferSelect>
    return updated[0] ? rowToLedger(updated[0]) : null
  }
}
