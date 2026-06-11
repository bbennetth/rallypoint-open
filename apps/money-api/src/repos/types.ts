// Locked repo shapes for money-api. Each interface has a D1 impl
// (repos/d1/*) and an in-memory impl (repos/memory.ts) for unit tests.
// money-api owns its own D1 database — it takes no dependency
// on @rallypoint/db; the RPID side is reached over HTTP via the
// services layer.

import type { RateLimitRepo } from '@rallypoint/rate-limit'
export type { RateLimitRepo }

// --- ledgers ---------------------------------------------------------

// owner_user_id holds a Rallypoint ID `user_<ulid>`; scope_id holds an
// Events group_id (scope_type=group) or a Money-local group id
// (scope_type=ledger_group) or 'personal'. Neither is a cross-schema FK.
export interface LedgerRecord {
  id: string
  tenantId: string
  scopeType: string
  scopeId: string
  ownerUserId: string
  name: string
  currency: string
  description: string | null
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

export interface CreateLedgerInput {
  id: string
  tenantId: string
  scopeType: string
  scopeId: string
  ownerUserId: string
  name: string
  currency: string
  description?: string | null
}

export interface PatchLedgerInput {
  name?: string | undefined
  description?: string | null | undefined
}

export interface LedgerRepo {
  create(input: CreateLedgerInput): Promise<LedgerRecord>
  // Any row by id, ignoring soft-delete state. Callers that want to
  // 404 a tombstoned ledger should check `deletedAt`.
  findById(id: string): Promise<LedgerRecord | null>
  // Active (non-deleted) ledgers owned by a user, newest first.
  listForOwner(ownerUserId: string): Promise<LedgerRecord[]>
  // Active (non-deleted) ledgers matching a scope, oldest first so
  // the "default" ledger for a group is deterministically the first
  // one (drives the events→money auto-attach idempotency).
  listForScope(input: {
    tenantId: string
    scopeType: string
    scopeId: string
  }): Promise<LedgerRecord[]>
  // Patch name/description. Returns null when the row is gone.
  patch(id: string, fields: PatchLedgerInput): Promise<LedgerRecord | null>
  // Soft-delete: stamp deletedAt. Idempotent — re-soft-deleting a
  // tombstone is a no-op. Returns true when the row was found.
  softDelete(id: string, when: Date): Promise<boolean>
  // Hand owner_user_id over to a new user.
  transferOwnership(input: {
    ledgerId: string
    newOwnerUserId: string
  }): Promise<LedgerRecord | null>
}

// --- ledger_members --------------------------------------------------

// Non-owner collaborators on a ledger. The owner is held implicitly on
// ledgers.owner_user_id and is NOT mirrored here in V1.
export interface LedgerMemberRecord {
  id: string
  ledgerId: string
  userId: string
  role: 'owner' | 'member'
  joinedAt: Date
}

export interface AddLedgerMemberInput {
  id: string
  ledgerId: string
  userId: string
  role: 'owner' | 'member'
}

export interface LedgerMemberRepo {
  add(input: AddLedgerMemberInput): Promise<LedgerMemberRecord>
  findByLedgerAndUser(
    ledgerId: string,
    userId: string,
  ): Promise<LedgerMemberRecord | null>
  listForLedger(ledgerId: string): Promise<LedgerMemberRecord[]>
  // True when the row existed and was removed.
  remove(ledgerId: string, userId: string): Promise<boolean>
  // Ledgers I've been added to as a non-owner collaborator (newest
  // joined first). Drives the "shared with me" tab on the web UI.
  listLedgersForUser(userId: string): Promise<LedgerRecord[]>
}

// --- ledger_groups + ledger_group_members ----------------------------

export interface LedgerGroupRecord {
  id: string
  tenantId: string
  name: string
  description: string | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

export interface LedgerGroupMemberRecord {
  id: string
  groupId: string
  userId: string
  role: 'owner' | 'sidekick' | 'member'
  joinedAt: Date
}

export interface CreateLedgerGroupInput {
  id: string
  tenantId: string
  name: string
  description?: string | null
  createdBy: string
  // The creator is auto-enrolled as the first member with role
  // 'owner'. The caller mints both ids — the repo writes them in one
  // transaction so a half-built group is impossible.
  ownerMemberId: string
}

export interface PatchLedgerGroupInput {
  name?: string | undefined
  description?: string | null | undefined
}

export interface AddLedgerGroupMemberInput {
  id: string
  groupId: string
  userId: string
  role: 'owner' | 'sidekick' | 'member'
}

export interface LedgerGroupRepo {
  create(input: CreateLedgerGroupInput): Promise<LedgerGroupRecord>
  findById(id: string): Promise<LedgerGroupRecord | null>
  // Groups the user belongs to, newest joined first.
  listForUser(userId: string): Promise<LedgerGroupRecord[]>
  patch(
    id: string,
    fields: PatchLedgerGroupInput,
  ): Promise<LedgerGroupRecord | null>
  softDelete(id: string, when: Date): Promise<boolean>
  // Membership APIs.
  findMembership(
    groupId: string,
    userId: string,
  ): Promise<LedgerGroupMemberRecord | null>
  listMembers(groupId: string): Promise<LedgerGroupMemberRecord[]>
  addMember(
    input: AddLedgerGroupMemberInput,
  ): Promise<LedgerGroupMemberRecord>
  removeMember(groupId: string, userId: string): Promise<boolean>
}

// --- ledger_invites --------------------------------------------------

export interface LedgerInviteRecord {
  id: string
  ledgerId: string
  codeHash: string
  invitedByUserId: string
  invitedEmail: string | null
  role: 'owner' | 'member'
  createdAt: Date
  expiresAt: Date
  consumedAt: Date | null
  consumedByUserId: string | null
}

export interface CreateLedgerInviteInput {
  id: string
  ledgerId: string
  codeHash: string
  invitedByUserId: string
  invitedEmail?: string | null
  role: 'owner' | 'member'
  expiresAt: Date
}

export interface LedgerInviteRepo {
  create(input: CreateLedgerInviteInput): Promise<LedgerInviteRecord>
  findByCodeHash(codeHash: string): Promise<LedgerInviteRecord | null>
  // Active (unconsumed, unexpired) invites for a ledger, newest first.
  listActiveForLedger(ledgerId: string): Promise<LedgerInviteRecord[]>
  markConsumed(
    id: string,
    consumedByUserId: string,
    when: Date,
  ): Promise<void>
}

// --- ledger_activity -------------------------------------------------

export interface LedgerActivityRecord {
  id: string
  ledgerId: string
  actorUserId: string
  eventType: string
  meta: Record<string, unknown>
  createdAt: Date
}

export interface RecordLedgerActivityInput {
  id: string
  ledgerId: string
  actorUserId: string
  eventType: string
  meta?: Record<string, unknown>
}

export interface LedgerActivityRepo {
  record(input: RecordLedgerActivityInput): Promise<void>
  // Newest first. Used by the owner-facing audit view.
  listForLedger(
    ledgerId: string,
    opts?: { limit?: number },
  ): Promise<LedgerActivityRecord[]>
}

// --- expenses + expense_splits --------------------------------------

export type ExpenseSplitMode = 'equal' | 'by_share' | 'by_amount'

export interface ExpenseSplitRecord {
  expenseId: string
  userId: string
  amountCents: number | null
  shareWeight: number | null
}

export interface ExpenseRecord {
  id: string
  ledgerId: string
  paidByUserId: string
  totalCents: number
  description: string
  splitMode: ExpenseSplitMode
  categoryId: string | null
  ref: string | null
  receiptObjectKey: string | null
  receiptContentType: string | null
  receiptBytes: number | null
  spentAt: string // YYYY-MM-DD
  createdBy: string
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

export interface ExpenseWithSplits extends ExpenseRecord {
  splits: ExpenseSplitRecord[]
}

export interface CreateExpenseInput {
  id: string
  ledgerId: string
  paidByUserId: string
  totalCents: number
  description: string
  splitMode: ExpenseSplitMode
  categoryId?: string | null
  ref?: string | null
  spentAt: string
  createdBy: string
  // Split rows are inserted in one transaction with the parent row.
  // Each row's amount_cents/share_weight nullability must match the
  // split_mode contract — the caller is responsible for that shape;
  // the repo just persists what it's given.
  splits: Array<{
    userId: string
    amountCents: number | null
    shareWeight: number | null
  }>
}

export interface PatchExpenseInput {
  description?: string | undefined
  spentAt?: string | undefined
  // null = explicit unset (drop the category linkage); undefined =
  // leave the column unchanged.
  categoryId?: string | null | undefined
}

export interface ExpenseRepo {
  // Creates expense + splits atomically.
  create(input: CreateExpenseInput): Promise<ExpenseWithSplits>
  // Returns null for non-existent or already soft-deleted rows.
  findByIdActive(id: string): Promise<ExpenseWithSplits | null>
  // Find by (ledger_id, ref) ignoring soft-delete state. Used by the
  // idempotent-create path so callers see the existing row (active
  // OR tombstoned) on a partial-unique collision. Returns null when
  // no row matches.
  findByLedgerAndRef(
    ledgerId: string,
    ref: string,
  ): Promise<ExpenseWithSplits | null>
  // Active expenses for a ledger, newest spent_at first then newest id.
  listForLedger(ledgerId: string): Promise<ExpenseWithSplits[]>
  patch(id: string, fields: PatchExpenseInput): Promise<ExpenseRecord | null>
  softDelete(id: string, when: Date): Promise<boolean>
  // Receipt-binding (slice 7). Sets the three receipt_* columns
  // atomically. Returns null when the row is gone or already
  // soft-deleted (we don't bind to tombstones).
  setReceipt(
    id: string,
    receipt: {
      objectKey: string
      contentType: string
      bytes: number
    },
  ): Promise<ExpenseRecord | null>
  // Drops the receipt columns back to null. Returns the prior
  // object_key so the caller can asynchronously delete the bytes
  // (or null if there was no receipt to clear). null if the row
  // is gone.
  clearReceipt(id: string): Promise<{ priorObjectKey: string | null } | null>
}

// --- expense_categories ---------------------------------------------

export interface ExpenseCategoryRecord {
  id: string
  ledgerId: string
  name: string
  color: string
  sortOrder: number
  createdAt: Date
  updatedAt: Date
}

export interface CreateExpenseCategoryInput {
  id: string
  ledgerId: string
  name: string
  color: string
  sortOrder: number
}

export interface PatchExpenseCategoryInput {
  name?: string | undefined
  color?: string | undefined
  sortOrder?: number | undefined
}

export interface ExpenseCategoryRepo {
  create(input: CreateExpenseCategoryInput): Promise<ExpenseCategoryRecord>
  findById(id: string): Promise<ExpenseCategoryRecord | null>
  // Categories for a ledger, ordered by (sort_order asc, id asc).
  listForLedger(ledgerId: string): Promise<ExpenseCategoryRecord[]>
  patch(
    id: string,
    fields: PatchExpenseCategoryInput,
  ): Promise<ExpenseCategoryRecord | null>
  // Hard delete — the FK on expenses.category_id is `set null`, so
  // expenses referencing this category survive with their linkage
  // dropped.
  delete(id: string): Promise<boolean>
}

// --- settlements -----------------------------------------------------

export interface SettlementRecord {
  id: string
  ledgerId: string
  fromUserId: string
  toUserId: string
  amountCents: number
  note: string | null
  settledAt: string // YYYY-MM-DD
  createdBy: string
  createdAt: Date
}

export interface CreateSettlementInput {
  id: string
  ledgerId: string
  fromUserId: string
  toUserId: string
  amountCents: number
  note?: string | null
  settledAt: string
  createdBy: string
}

export interface SettlementRepo {
  create(input: CreateSettlementInput): Promise<SettlementRecord>
  findById(id: string): Promise<SettlementRecord | null>
  // All settlements for a ledger, newest settled_at first.
  listForLedger(ledgerId: string): Promise<SettlementRecord[]>
  // Hard delete — settlements have no soft-delete column. The
  // activity log retains the create + delete pair for audit.
  delete(id: string): Promise<boolean>
}

// --- sessions (money-side session store) ---

export interface MoneySessionRecord {
  idHash: string
  userId: string
  rpidBearerCiphertext: Buffer
  rpidBearerNonce: Buffer
  rpidBearerKeyVersion: number
  createdAt: Date
  lastSeenAt: Date
  absoluteExpiresAt: Date
  ipHash: string
  uaHash: string
}

export interface MoneySessionRepo {
  create(record: Omit<MoneySessionRecord, 'createdAt' | 'lastSeenAt'> & {
    createdAt?: Date
    lastSeenAt?: Date
  }): Promise<void>
  findByIdHash(idHash: string): Promise<MoneySessionRecord | null>
  touchLastSeen(idHash: string, when: Date): Promise<void>
  deleteByIdHash(idHash: string): Promise<void>
}

// --- repo bag -------------------------------------------------------

export interface Repos {
  ledgers: LedgerRepo
  ledgerMembers: LedgerMemberRepo
  ledgerGroups: LedgerGroupRepo
  ledgerInvites: LedgerInviteRepo
  ledgerActivity: LedgerActivityRepo
  expenses: ExpenseRepo
  expenseCategories: ExpenseCategoryRepo
  settlements: SettlementRepo
  sessions: MoneySessionRepo
  rateLimit: RateLimitRepo
}
