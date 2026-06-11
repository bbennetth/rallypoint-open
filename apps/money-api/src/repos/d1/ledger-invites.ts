import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import { ledgerInvites } from '@rallypoint/money-db'
import { UniqueConstraintError } from '../errors.js'
import { mapUniqueViolation } from './_errors.js'
import type {
  CreateLedgerInviteInput,
  LedgerInviteRecord,
  LedgerInviteRepo,
} from '../types.js'
import type { Db } from './db.js'

function rowToInvite(
  row: typeof ledgerInvites.$inferSelect,
): LedgerInviteRecord {
  return {
    id: row.id,
    ledgerId: row.ledgerId,
    codeHash: row.codeHash,
    invitedByUserId: row.invitedByUserId,
    invitedEmail: row.invitedEmail ?? null,
    role: row.role as 'owner' | 'member',
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    consumedByUserId: row.consumedByUserId ?? null,
  }
}

export class D1LedgerInviteRepo implements LedgerInviteRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateLedgerInviteInput): Promise<LedgerInviteRecord> {
    try {
      const rows = await this.db
        .insert(ledgerInvites)
        .values({
          id: input.id,
          ledgerId: input.ledgerId,
          codeHash: input.codeHash,
          invitedByUserId: input.invitedByUserId,
          invitedEmail: input.invitedEmail ?? null,
          role: input.role,
          expiresAt: input.expiresAt,
        })
        .returning()
      return rowToInvite(rows[0]!)
    } catch (err) {
      const mapped = mapUniqueViolation(err)
      if (mapped instanceof UniqueConstraintError) {
        throw new UniqueConstraintError('money_ledger_invites_code_hash_idx')
      }
      throw err
    }
  }

  async findByCodeHash(codeHash: string): Promise<LedgerInviteRecord | null> {
    const rows = await this.db
      .select()
      .from(ledgerInvites)
      .where(eq(ledgerInvites.codeHash, codeHash))
      .limit(1)
    return rows[0] ? rowToInvite(rows[0]) : null
  }

  async listActiveForLedger(ledgerId: string): Promise<LedgerInviteRecord[]> {
    const rows = await this.db
      .select()
      .from(ledgerInvites)
      .where(
        and(
          eq(ledgerInvites.ledgerId, ledgerId),
          isNull(ledgerInvites.consumedAt),
          gt(ledgerInvites.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(ledgerInvites.createdAt), desc(ledgerInvites.id))
    return rows.map(rowToInvite)
  }

  async markConsumed(
    id: string,
    consumedByUserId: string,
    when: Date,
  ): Promise<void> {
    await this.db
      .update(ledgerInvites)
      .set({ consumedAt: when, consumedByUserId })
      .where(eq(ledgerInvites.id, id))
  }
}
