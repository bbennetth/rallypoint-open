import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { ledgerGroupMembers, ledgerGroups } from '@rallypoint/money-db'
import { UniqueConstraintError } from '../errors.js'
import { mapUniqueViolation } from './_errors.js'
import type { BatchItem } from 'drizzle-orm/batch'
import type {
  AddLedgerGroupMemberInput,
  CreateLedgerGroupInput,
  LedgerGroupMemberRecord,
  LedgerGroupRecord,
  LedgerGroupRepo,
  PatchLedgerGroupInput,
} from '../types.js'
import type { Db } from './db.js'

function rowToGroup(row: typeof ledgerGroups.$inferSelect): LedgerGroupRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  }
}

function rowToMember(
  row: typeof ledgerGroupMembers.$inferSelect,
): LedgerGroupMemberRecord {
  return {
    id: row.id,
    groupId: row.groupId,
    userId: row.userId,
    role: row.role as 'owner' | 'sidekick' | 'member',
    joinedAt: row.joinedAt,
  }
}

export class D1LedgerGroupRepo implements LedgerGroupRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateLedgerGroupInput): Promise<LedgerGroupRecord> {
    // Create the group + owner-member row atomically using D1 batch()
    // so a half-built group is impossible.
    const now = new Date()
    const stmts: [BatchItem<'sqlite'>, BatchItem<'sqlite'>] = [
      this.db
        .insert(ledgerGroups)
        .values({
          id: input.id,
          tenantId: input.tenantId,
          name: input.name,
          description: input.description ?? null,
          createdBy: input.createdBy,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
      this.db
        .insert(ledgerGroupMembers)
        .values({
          id: input.ownerMemberId,
          groupId: input.id,
          userId: input.createdBy,
          role: 'owner',
          joinedAt: now,
        })
        .returning(),
    ]
    const [groupRows] = await this.db.batch(stmts)
    return rowToGroup((groupRows as typeof ledgerGroups.$inferSelect[])[0]!)
  }

  async findById(id: string): Promise<LedgerGroupRecord | null> {
    const rows = await this.db
      .select()
      .from(ledgerGroups)
      .where(eq(ledgerGroups.id, id))
      .limit(1)
    return rows[0] ? rowToGroup(rows[0]) : null
  }

  async listForUser(userId: string): Promise<LedgerGroupRecord[]> {
    const rows = await this.db
      .select({ g: ledgerGroups, joinedAt: ledgerGroupMembers.joinedAt })
      .from(ledgerGroupMembers)
      .innerJoin(ledgerGroups, eq(ledgerGroups.id, ledgerGroupMembers.groupId))
      .where(
        and(
          eq(ledgerGroupMembers.userId, userId),
          isNull(ledgerGroups.deletedAt),
        ),
      )
      .orderBy(desc(ledgerGroupMembers.joinedAt), desc(ledgerGroupMembers.id))
    return rows.map((r) => rowToGroup(r.g))
  }

  async patch(
    id: string,
    fields: PatchLedgerGroupInput,
  ): Promise<LedgerGroupRecord | null> {
    const set: Partial<typeof ledgerGroups.$inferInsert> = { updatedAt: new Date() }
    if (fields.name !== undefined) set.name = fields.name
    if (fields.description !== undefined) set.description = fields.description
    const rows = await this.db
      .update(ledgerGroups)
      .set(set)
      .where(and(eq(ledgerGroups.id, id), isNull(ledgerGroups.deletedAt)))
      .returning()
    return rows[0] ? rowToGroup(rows[0]) : null
  }

  async softDelete(id: string, when: Date): Promise<boolean> {
    const rows = await this.db
      .update(ledgerGroups)
      .set({ deletedAt: when, updatedAt: when })
      .where(and(eq(ledgerGroups.id, id), isNull(ledgerGroups.deletedAt)))
      .returning({ id: ledgerGroups.id })
    return rows.length > 0
  }

  async findMembership(
    groupId: string,
    userId: string,
  ): Promise<LedgerGroupMemberRecord | null> {
    const rows = await this.db
      .select()
      .from(ledgerGroupMembers)
      .where(
        and(
          eq(ledgerGroupMembers.groupId, groupId),
          eq(ledgerGroupMembers.userId, userId),
        ),
      )
      .limit(1)
    return rows[0] ? rowToMember(rows[0]) : null
  }

  async listMembers(groupId: string): Promise<LedgerGroupMemberRecord[]> {
    const rows = await this.db
      .select()
      .from(ledgerGroupMembers)
      .where(eq(ledgerGroupMembers.groupId, groupId))
      .orderBy(asc(ledgerGroupMembers.joinedAt), asc(ledgerGroupMembers.id))
    return rows.map(rowToMember)
  }

  async addMember(
    input: AddLedgerGroupMemberInput,
  ): Promise<LedgerGroupMemberRecord> {
    try {
      const rows = await this.db
        .insert(ledgerGroupMembers)
        .values({
          id: input.id,
          groupId: input.groupId,
          userId: input.userId,
          role: input.role,
        })
        .returning()
      return rowToMember(rows[0]!)
    } catch (err) {
      const mapped = mapUniqueViolation(err)
      if (mapped instanceof UniqueConstraintError) {
        throw new UniqueConstraintError('money_ledger_group_members_group_user_uq')
      }
      throw err
    }
  }

  async removeMember(groupId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .delete(ledgerGroupMembers)
      .where(
        and(
          eq(ledgerGroupMembers.groupId, groupId),
          eq(ledgerGroupMembers.userId, userId),
        ),
      )
      .returning({ id: ledgerGroupMembers.id })
    return rows.length > 0
  }
}
