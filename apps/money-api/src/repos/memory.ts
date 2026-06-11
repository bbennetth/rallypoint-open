import { InMemoryRateLimitRepo } from '@rallypoint/rate-limit'
import { UniqueConstraintError } from './errors.js'
import type {
  AddLedgerGroupMemberInput,
  AddLedgerMemberInput,
  CreateExpenseCategoryInput,
  CreateExpenseInput,
  CreateLedgerGroupInput,
  CreateLedgerInput,
  CreateLedgerInviteInput,
  CreateSettlementInput,
  ExpenseCategoryRecord,
  ExpenseCategoryRepo,
  ExpenseRecord,
  ExpenseRepo,
  ExpenseSplitRecord,
  ExpenseWithSplits,
  LedgerActivityRecord,
  LedgerActivityRepo,
  LedgerGroupMemberRecord,
  LedgerGroupRecord,
  LedgerGroupRepo,
  LedgerInviteRecord,
  LedgerInviteRepo,
  LedgerMemberRecord,
  LedgerMemberRepo,
  LedgerRecord,
  LedgerRepo,
  MoneySessionRecord,
  MoneySessionRepo,
  PatchExpenseCategoryInput,
  PatchExpenseInput,
  PatchLedgerGroupInput,
  PatchLedgerInput,
  RecordLedgerActivityInput,
  Repos,
  SettlementRecord,
  SettlementRepo,
} from './types.js'

// In-memory repo impls for unit tests and local stubbing. They mirror
// the d1 impls' observable behaviour (soft-delete filtering,
// newest-first ordering, unique-key collisions) but hold everything in
// Maps. Integration tests run the d1 impls under
// @cloudflare/vitest-pool-workers (Miniflare D1); these are for fast
// logic-level tests.

function sortByCreatedAtDesc<T extends { createdAt: Date; id: string }>(rows: T[]): T[] {
  return [...rows]
    .sort((a, b) => {
      const at = a.createdAt.getTime()
      const bt = b.createdAt.getTime()
      if (at !== bt) return bt - at
      return a.id < b.id ? 1 : -1
    })
}

export class MemoryLedgerRepo implements LedgerRepo {
  byId = new Map<string, LedgerRecord>()

  async create(input: CreateLedgerInput): Promise<LedgerRecord> {
    const now = new Date()
    const rec: LedgerRecord = {
      id: input.id,
      tenantId: input.tenantId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      ownerUserId: input.ownerUserId,
      name: input.name,
      currency: input.currency,
      description: input.description ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    this.byId.set(rec.id, rec)
    return { ...rec }
  }

  async findById(id: string): Promise<LedgerRecord | null> {
    const r = this.byId.get(id)
    return r ? { ...r } : null
  }

  async listForOwner(ownerUserId: string): Promise<LedgerRecord[]> {
    const rows = [...this.byId.values()].filter(
      (l) => l.deletedAt === null && l.ownerUserId === ownerUserId,
    )
    return sortByCreatedAtDesc(rows).map((l) => ({ ...l }))
  }

  async listForScope(input: {
    tenantId: string
    scopeType: string
    scopeId: string
  }): Promise<LedgerRecord[]> {
    const rows = [...this.byId.values()]
      .filter(
        (l) =>
          l.deletedAt === null &&
          l.tenantId === input.tenantId &&
          l.scopeType === input.scopeType &&
          l.scopeId === input.scopeId,
      )
      // Oldest first: the "default" group ledger is the first one ever
      // attached. Drives the events→money auto-attach idempotency.
      .sort((a, b) => {
        const at = a.createdAt.getTime()
        const bt = b.createdAt.getTime()
        if (at !== bt) return at - bt
        return a.id < b.id ? -1 : 1
      })
    return rows.map((l) => ({ ...l }))
  }

  async patch(id: string, fields: PatchLedgerInput): Promise<LedgerRecord | null> {
    const r = this.byId.get(id)
    if (!r || r.deletedAt) return null
    if (fields.name !== undefined) r.name = fields.name
    if (fields.description !== undefined) r.description = fields.description
    r.updatedAt = new Date()
    return { ...r }
  }

  async softDelete(id: string, when: Date): Promise<boolean> {
    const r = this.byId.get(id)
    if (!r) return false
    if (!r.deletedAt) r.deletedAt = when
    r.updatedAt = when
    return true
  }

  async transferOwnership(input: {
    ledgerId: string
    newOwnerUserId: string
  }): Promise<LedgerRecord | null> {
    const r = this.byId.get(input.ledgerId)
    if (!r || r.deletedAt) return null
    r.ownerUserId = input.newOwnerUserId
    r.updatedAt = new Date()
    return { ...r }
  }
}

export class MemoryLedgerMemberRepo implements LedgerMemberRepo {
  rows: LedgerMemberRecord[] = []
  constructor(private readonly ledgers: MemoryLedgerRepo) {}

  async add(input: AddLedgerMemberInput): Promise<LedgerMemberRecord> {
    if (this.rows.some((m) => m.ledgerId === input.ledgerId && m.userId === input.userId)) {
      throw new UniqueConstraintError('money_ledger_members_ledger_user_uq')
    }
    const rec: LedgerMemberRecord = { ...input, joinedAt: new Date() }
    this.rows.push(rec)
    return { ...rec }
  }

  async findByLedgerAndUser(
    ledgerId: string,
    userId: string,
  ): Promise<LedgerMemberRecord | null> {
    const r = this.rows.find((m) => m.ledgerId === ledgerId && m.userId === userId)
    return r ? { ...r } : null
  }

  async listForLedger(ledgerId: string): Promise<LedgerMemberRecord[]> {
    return this.rows
      .filter((m) => m.ledgerId === ledgerId)
      .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())
      .map((m) => ({ ...m }))
  }

  async remove(ledgerId: string, userId: string): Promise<boolean> {
    const i = this.rows.findIndex((m) => m.ledgerId === ledgerId && m.userId === userId)
    if (i < 0) return false
    this.rows.splice(i, 1)
    return true
  }

  async listLedgersForUser(userId: string): Promise<LedgerRecord[]> {
    const memberships = this.rows
      .filter((m) => m.userId === userId)
      .sort((a, b) => b.joinedAt.getTime() - a.joinedAt.getTime())
    const out: LedgerRecord[] = []
    for (const m of memberships) {
      const led = this.ledgers.byId.get(m.ledgerId)
      if (led && !led.deletedAt) out.push({ ...led })
    }
    return out
  }
}

export class MemoryLedgerGroupRepo implements LedgerGroupRepo {
  groups = new Map<string, LedgerGroupRecord>()
  members: LedgerGroupMemberRecord[] = []

  async create(input: CreateLedgerGroupInput): Promise<LedgerGroupRecord> {
    const now = new Date()
    const rec: LedgerGroupRecord = {
      id: input.id,
      tenantId: input.tenantId,
      name: input.name,
      description: input.description ?? null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    this.groups.set(rec.id, rec)
    this.members.push({
      id: input.ownerMemberId,
      groupId: rec.id,
      userId: input.createdBy,
      role: 'owner',
      joinedAt: now,
    })
    return { ...rec }
  }

  async findById(id: string): Promise<LedgerGroupRecord | null> {
    const r = this.groups.get(id)
    return r ? { ...r } : null
  }

  async listForUser(userId: string): Promise<LedgerGroupRecord[]> {
    const memberships = this.members
      .filter((m) => m.userId === userId)
      .sort((a, b) => b.joinedAt.getTime() - a.joinedAt.getTime())
    const out: LedgerGroupRecord[] = []
    for (const m of memberships) {
      const g = this.groups.get(m.groupId)
      if (g && !g.deletedAt) out.push({ ...g })
    }
    return out
  }

  async patch(
    id: string,
    fields: PatchLedgerGroupInput,
  ): Promise<LedgerGroupRecord | null> {
    const r = this.groups.get(id)
    if (!r || r.deletedAt) return null
    if (fields.name !== undefined) r.name = fields.name
    if (fields.description !== undefined) r.description = fields.description
    r.updatedAt = new Date()
    return { ...r }
  }

  async softDelete(id: string, when: Date): Promise<boolean> {
    const r = this.groups.get(id)
    if (!r) return false
    if (!r.deletedAt) r.deletedAt = when
    r.updatedAt = when
    return true
  }

  async findMembership(
    groupId: string,
    userId: string,
  ): Promise<LedgerGroupMemberRecord | null> {
    const r = this.members.find((m) => m.groupId === groupId && m.userId === userId)
    return r ? { ...r } : null
  }

  async listMembers(groupId: string): Promise<LedgerGroupMemberRecord[]> {
    return this.members
      .filter((m) => m.groupId === groupId)
      .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())
      .map((m) => ({ ...m }))
  }

  async addMember(
    input: AddLedgerGroupMemberInput,
  ): Promise<LedgerGroupMemberRecord> {
    if (this.members.some((m) => m.groupId === input.groupId && m.userId === input.userId)) {
      throw new UniqueConstraintError('money_ledger_group_members_group_user_uq')
    }
    const rec: LedgerGroupMemberRecord = { ...input, joinedAt: new Date() }
    this.members.push(rec)
    return { ...rec }
  }

  async removeMember(groupId: string, userId: string): Promise<boolean> {
    const i = this.members.findIndex(
      (m) => m.groupId === groupId && m.userId === userId,
    )
    if (i < 0) return false
    this.members.splice(i, 1)
    return true
  }
}

export class MemoryLedgerInviteRepo implements LedgerInviteRepo {
  byId = new Map<string, LedgerInviteRecord>()

  async create(input: CreateLedgerInviteInput): Promise<LedgerInviteRecord> {
    if ([...this.byId.values()].some((i) => i.codeHash === input.codeHash)) {
      throw new UniqueConstraintError('money_ledger_invites_code_hash_idx')
    }
    const rec: LedgerInviteRecord = {
      id: input.id,
      ledgerId: input.ledgerId,
      codeHash: input.codeHash,
      invitedByUserId: input.invitedByUserId,
      invitedEmail: input.invitedEmail ?? null,
      role: input.role,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
      consumedAt: null,
      consumedByUserId: null,
    }
    this.byId.set(rec.id, rec)
    return { ...rec }
  }

  async findByCodeHash(codeHash: string): Promise<LedgerInviteRecord | null> {
    const r = [...this.byId.values()].find((i) => i.codeHash === codeHash)
    return r ? { ...r } : null
  }

  async listActiveForLedger(ledgerId: string): Promise<LedgerInviteRecord[]> {
    const now = Date.now()
    return [...this.byId.values()]
      .filter(
        (i) =>
          i.ledgerId === ledgerId && i.consumedAt === null && i.expiresAt.getTime() > now,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((i) => ({ ...i }))
  }

  async markConsumed(
    id: string,
    consumedByUserId: string,
    when: Date,
  ): Promise<void> {
    const r = this.byId.get(id)
    if (!r) return
    r.consumedAt = when
    r.consumedByUserId = consumedByUserId
  }
}

export class MemoryLedgerActivityRepo implements LedgerActivityRepo {
  rows: LedgerActivityRecord[] = []

  async record(input: RecordLedgerActivityInput): Promise<void> {
    this.rows.push({
      id: input.id,
      ledgerId: input.ledgerId,
      actorUserId: input.actorUserId,
      eventType: input.eventType,
      meta: input.meta ?? {},
      createdAt: new Date(),
    })
  }

  async listForLedger(
    ledgerId: string,
    opts?: { limit?: number },
  ): Promise<LedgerActivityRecord[]> {
    const rows = this.rows
      .filter((r) => r.ledgerId === ledgerId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    const limit = opts?.limit ?? rows.length
    return rows.slice(0, limit).map((r) => ({ ...r }))
  }
}

export class MemoryExpenseRepo implements ExpenseRepo {
  byId = new Map<string, ExpenseRecord>()
  splitsByExpense = new Map<string, ExpenseSplitRecord[]>()

  async create(input: CreateExpenseInput): Promise<ExpenseWithSplits> {
    // Mirror the PG partial-unique on (ledger_id, ref).
    if (input.ref != null) {
      for (const e of this.byId.values()) {
        if (e.ledgerId === input.ledgerId && e.ref === input.ref) {
          throw new UniqueConstraintError('money_expenses_ledger_ref_uq')
        }
      }
    }
    const now = new Date()
    const rec: ExpenseRecord = {
      id: input.id,
      ledgerId: input.ledgerId,
      paidByUserId: input.paidByUserId,
      totalCents: input.totalCents,
      description: input.description,
      splitMode: input.splitMode,
      categoryId: input.categoryId ?? null,
      ref: input.ref ?? null,
      receiptObjectKey: null,
      receiptContentType: null,
      receiptBytes: null,
      spentAt: input.spentAt,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    this.byId.set(rec.id, rec)
    const splits: ExpenseSplitRecord[] = input.splits.map((s) => ({
      expenseId: input.id,
      userId: s.userId,
      amountCents: s.amountCents,
      shareWeight: s.shareWeight,
    }))
    this.splitsByExpense.set(input.id, splits)
    return { ...rec, splits: splits.map((s) => ({ ...s })) }
  }

  async findByIdActive(id: string): Promise<ExpenseWithSplits | null> {
    const r = this.byId.get(id)
    if (!r || r.deletedAt) return null
    const splits = (this.splitsByExpense.get(id) ?? []).map((s) => ({ ...s }))
    return { ...r, splits }
  }

  async findByLedgerAndRef(
    ledgerId: string,
    ref: string,
  ): Promise<ExpenseWithSplits | null> {
    for (const r of this.byId.values()) {
      if (r.ledgerId === ledgerId && r.ref === ref) {
        const splits = (this.splitsByExpense.get(r.id) ?? []).map((s) => ({ ...s }))
        return { ...r, splits }
      }
    }
    return null
  }

  async listForLedger(ledgerId: string): Promise<ExpenseWithSplits[]> {
    const rows = [...this.byId.values()].filter(
      (e) => e.ledgerId === ledgerId && e.deletedAt === null,
    )
    rows.sort((a, b) => {
      if (a.spentAt !== b.spentAt) return a.spentAt < b.spentAt ? 1 : -1
      return a.id < b.id ? 1 : -1
    })
    return rows.map((r) => ({
      ...r,
      splits: (this.splitsByExpense.get(r.id) ?? []).map((s) => ({ ...s })),
    }))
  }

  async patch(id: string, fields: PatchExpenseInput): Promise<ExpenseRecord | null> {
    const r = this.byId.get(id)
    if (!r || r.deletedAt) return null
    if (fields.description !== undefined) r.description = fields.description
    if (fields.spentAt !== undefined) r.spentAt = fields.spentAt
    if (fields.categoryId !== undefined) r.categoryId = fields.categoryId
    r.updatedAt = new Date()
    return { ...r }
  }

  async softDelete(id: string, when: Date): Promise<boolean> {
    const r = this.byId.get(id)
    if (!r) return false
    if (!r.deletedAt) r.deletedAt = when
    r.updatedAt = when
    return true
  }

  async setReceipt(
    id: string,
    receipt: { objectKey: string; contentType: string; bytes: number },
  ): Promise<ExpenseRecord | null> {
    const r = this.byId.get(id)
    if (!r || r.deletedAt) return null
    r.receiptObjectKey = receipt.objectKey
    r.receiptContentType = receipt.contentType
    r.receiptBytes = receipt.bytes
    r.updatedAt = new Date()
    return { ...r }
  }

  async clearReceipt(id: string): Promise<{ priorObjectKey: string | null } | null> {
    const r = this.byId.get(id)
    if (!r) return null
    const priorObjectKey = r.receiptObjectKey
    r.receiptObjectKey = null
    r.receiptContentType = null
    r.receiptBytes = null
    r.updatedAt = new Date()
    return { priorObjectKey }
  }
}

export class MemoryExpenseCategoryRepo implements ExpenseCategoryRepo {
  byId = new Map<string, ExpenseCategoryRecord>()
  constructor(private readonly expenses: MemoryExpenseRepo) {}

  async create(input: CreateExpenseCategoryInput): Promise<ExpenseCategoryRecord> {
    for (const c of this.byId.values()) {
      if (c.ledgerId === input.ledgerId && c.name === input.name) {
        throw new UniqueConstraintError('money_expense_categories_ledger_name_uq')
      }
    }
    const now = new Date()
    const rec: ExpenseCategoryRecord = {
      id: input.id,
      ledgerId: input.ledgerId,
      name: input.name,
      color: input.color,
      sortOrder: input.sortOrder,
      createdAt: now,
      updatedAt: now,
    }
    this.byId.set(rec.id, rec)
    return { ...rec }
  }

  async findById(id: string): Promise<ExpenseCategoryRecord | null> {
    const r = this.byId.get(id)
    return r ? { ...r } : null
  }

  async listForLedger(ledgerId: string): Promise<ExpenseCategoryRecord[]> {
    const rows = [...this.byId.values()].filter((c) => c.ledgerId === ledgerId)
    rows.sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
      return a.id < b.id ? -1 : 1
    })
    return rows.map((r) => ({ ...r }))
  }

  async patch(
    id: string,
    fields: PatchExpenseCategoryInput,
  ): Promise<ExpenseCategoryRecord | null> {
    const r = this.byId.get(id)
    if (!r) return null
    if (fields.name !== undefined) {
      for (const c of this.byId.values()) {
        if (
          c.id !== id &&
          c.ledgerId === r.ledgerId &&
          c.name === fields.name
        ) {
          throw new UniqueConstraintError('money_expense_categories_ledger_name_uq')
        }
      }
      r.name = fields.name
    }
    if (fields.color !== undefined) r.color = fields.color
    if (fields.sortOrder !== undefined) r.sortOrder = fields.sortOrder
    r.updatedAt = new Date()
    return { ...r }
  }

  async delete(id: string): Promise<boolean> {
    const deleted = this.byId.delete(id)
    if (!deleted) return false
    // Mirror the PG FK's set-null behaviour for expenses.
    for (const e of this.expenses.byId.values()) {
      if (e.categoryId === id) e.categoryId = null
    }
    return true
  }
}

export class MemorySettlementRepo implements SettlementRepo {
  byId = new Map<string, SettlementRecord>()

  async create(input: CreateSettlementInput): Promise<SettlementRecord> {
    const rec: SettlementRecord = {
      id: input.id,
      ledgerId: input.ledgerId,
      fromUserId: input.fromUserId,
      toUserId: input.toUserId,
      amountCents: input.amountCents,
      note: input.note ?? null,
      settledAt: input.settledAt,
      createdBy: input.createdBy,
      createdAt: new Date(),
    }
    this.byId.set(rec.id, rec)
    return { ...rec }
  }

  async findById(id: string): Promise<SettlementRecord | null> {
    const r = this.byId.get(id)
    return r ? { ...r } : null
  }

  async listForLedger(ledgerId: string): Promise<SettlementRecord[]> {
    const rows = [...this.byId.values()].filter((s) => s.ledgerId === ledgerId)
    rows.sort((a, b) => {
      if (a.settledAt !== b.settledAt) return a.settledAt < b.settledAt ? 1 : -1
      return a.id < b.id ? 1 : -1
    })
    return rows.map((r) => ({ ...r }))
  }

  async delete(id: string): Promise<boolean> {
    return this.byId.delete(id)
  }
}

export class MemoryMoneySessionRepo implements MoneySessionRepo {
  private byIdHash = new Map<string, MoneySessionRecord>()

  async create(
    record: Omit<MoneySessionRecord, 'createdAt' | 'lastSeenAt'> & {
      createdAt?: Date
      lastSeenAt?: Date
    },
  ): Promise<void> {
    const now = new Date()
    this.byIdHash.set(record.idHash, {
      ...record,
      createdAt: record.createdAt ?? now,
      lastSeenAt: record.lastSeenAt ?? now,
    })
  }

  async findByIdHash(idHash: string): Promise<MoneySessionRecord | null> {
    const r = this.byIdHash.get(idHash)
    return r ? { ...r } : null
  }

  async touchLastSeen(idHash: string, when: Date): Promise<void> {
    const r = this.byIdHash.get(idHash)
    if (r) r.lastSeenAt = when
  }

  async deleteByIdHash(idHash: string): Promise<void> {
    this.byIdHash.delete(idHash)
  }
}

export function buildMemoryRepos(): Repos {
  const ledgers = new MemoryLedgerRepo()
  const expenses = new MemoryExpenseRepo()
  return {
    ledgers,
    ledgerMembers: new MemoryLedgerMemberRepo(ledgers),
    ledgerGroups: new MemoryLedgerGroupRepo(),
    ledgerInvites: new MemoryLedgerInviteRepo(),
    ledgerActivity: new MemoryLedgerActivityRepo(),
    expenses,
    expenseCategories: new MemoryExpenseCategoryRepo(expenses),
    settlements: new MemorySettlementRepo(),
    sessions: new MemoryMoneySessionRepo(),
    rateLimit: new InMemoryRateLimitRepo(),
  }
}
