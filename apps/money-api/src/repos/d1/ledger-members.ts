import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { ledgerMembers, ledgers } from '@rallypoint/money-db'
import { UniqueConstraintError } from '../errors.js'
import { mapUniqueViolation } from './_errors.js'
import type {
  AddLedgerMemberInput,
  LedgerMemberRecord,
  LedgerMemberRepo,
  LedgerRecord,
} from '../types.js'
import type { Db } from './db.js'

function rowToMember(row: typeof ledgerMembers.$inferSelect): LedgerMemberRecord {
  return {
    id: row.id,
    ledgerId: row.ledgerId,
    userId: row.userId,
    role: row.role as 'owner' | 'member',
    joinedAt: row.joinedAt,
  }
}

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

export class D1LedgerMemberRepo implements LedgerMemberRepo {
  constructor(private readonly db: Db) {}

  async add(input: AddLedgerMemberInput): Promise<LedgerMemberRecord> {
    try {
      const rows = await this.db
        .insert(ledgerMembers)
        .values({
          id: input.id,
          ledgerId: input.ledgerId,
          userId: input.userId,
          role: input.role,
        })
        .returning()
      return rowToMember(rows[0]!)
    } catch (err) {
      const mapped = mapUniqueViolation(err)
      if (mapped instanceof UniqueConstraintError) {
        throw new UniqueConstraintError('money_ledger_members_ledger_user_uq')
      }
      throw err
    }
  }

  async findByLedgerAndUser(
    ledgerId: string,
    userId: string,
  ): Promise<LedgerMemberRecord | null> {
    const rows = await this.db
      .select()
      .from(ledgerMembers)
      .where(and(eq(ledgerMembers.ledgerId, ledgerId), eq(ledgerMembers.userId, userId)))
      .limit(1)
    return rows[0] ? rowToMember(rows[0]) : null
  }

  async listForLedger(ledgerId: string): Promise<LedgerMemberRecord[]> {
    const rows = await this.db
      .select()
      .from(ledgerMembers)
      .where(eq(ledgerMembers.ledgerId, ledgerId))
      .orderBy(asc(ledgerMembers.joinedAt), asc(ledgerMembers.id))
    return rows.map(rowToMember)
  }

  async remove(ledgerId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .delete(ledgerMembers)
      .where(and(eq(ledgerMembers.ledgerId, ledgerId), eq(ledgerMembers.userId, userId)))
      .returning({ id: ledgerMembers.id })
    return rows.length > 0
  }

  async listLedgersForUser(userId: string): Promise<LedgerRecord[]> {
    const rows = await this.db
      .select({ ledger: ledgers, joinedAt: ledgerMembers.joinedAt })
      .from(ledgerMembers)
      .innerJoin(ledgers, eq(ledgers.id, ledgerMembers.ledgerId))
      .where(and(eq(ledgerMembers.userId, userId), isNull(ledgers.deletedAt)))
      .orderBy(desc(ledgerMembers.joinedAt), desc(ledgerMembers.id))
    return rows.map((r) => rowToLedger(r.ledger))
  }
}
