import { z } from 'zod'
import { type ReceiptMimeType } from './receipt-constraints.js'

// Cross-target validators for Rallypoint Money. apps/money-api
// validates request bodies with these; apps/money-web reuses the same
// schemas client-side so users see field errors before a network
// round trip. Evolve the rules HERE, never in two places. Mirrors
// @rallypoint/lists-shared's field-builder style.

// --- Currency (ISO-4217 static set) ----------------------------------

// A conservative static set of widely-traded currencies for slice 1.
// Expand in later slices or via a more complete ISO-4217 lookup.
// Multi-currency-per-ledger is deferred to v2; one code is stored on
// the ledger row at creation time and is immutable thereafter.
export const SUPPORTED_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY', 'NZD',
  'SEK', 'NOK', 'DKK', 'SGD', 'HKD', 'MXN', 'BRL', 'INR',
  'CNY', 'KRW', 'ZAR', 'PLN', 'CZK', 'HUF', 'RON', 'TRY',
  'ILS', 'SAR', 'AED', 'THB', 'IDR', 'MYR', 'PHP', 'TWD',
] as const

export type Currency = (typeof SUPPORTED_CURRENCIES)[number]

// ISO-4217 currency field. Accepts any string from the static set;
// returns it upper-cased (the DB column is char(3)).
export const currencyField = z.enum(SUPPORTED_CURRENCIES)

// --- Scope discriminator ---------------------------------------------

// Ledger scope types (locked scope decision 4). `group` references an
// Events group_id opaquely; `ledger_group` references a Money-local
// group row; `personal` is for single-owner use.
export const MONEY_SCOPE_TYPES = ['group', 'ledger_group', 'personal'] as const
export const moneyScopeTypeField = z.enum(MONEY_SCOPE_TYPES)
export type MoneyScopeType = (typeof MONEY_SCOPE_TYPES)[number]

// --- Field-level building blocks -------------------------------------

// Ledger display name. 1–100 chars after trimming.
export const ledgerNameField = z
  .string()
  .trim()
  .min(1, 'Ledger name is required.')
  .max(100, 'Ledger name must be at most 100 characters.')

// Opaque scope identifier. Validated as a non-empty bounded string
// here; cross-schema referential integrity is enforced at the app
// layer, not the DB (no cross-schema FKs).
export const moneyScopeIdField = z
  .string()
  .trim()
  .min(1, 'Scope id is required.')
  .max(64, 'Scope id must be at most 64 characters.')

// Optional ledger description. Empty string normalises to null.
export const ledgerDescriptionField = z
  .string()
  .trim()
  .max(1000, 'Description must be at most 1000 characters.')
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .optional()

// --- Request schemas -------------------------------------------------

// POST /api/v1/ui/ledgers — create a ledger.
export const CreateLedgerSchema = z.object({
  name: ledgerNameField,
  currency: currencyField,
  scopeType: moneyScopeTypeField,
  scopeId: moneyScopeIdField,
  description: ledgerDescriptionField,
})

export type CreateLedgerInput = z.infer<typeof CreateLedgerSchema>

// PATCH /api/v1/ui/ledgers/:id — patch a ledger. Only name and
// description are mutable in V1; scope and currency are immutable to
// keep settled balances coherent. At least one field is required.
export const PatchLedgerSchema = z
  .object({
    name: ledgerNameField.optional(),
    description: ledgerDescriptionField,
  })
  .refine(
    (v) => v.name !== undefined || v.description !== undefined,
    'At least one of name or description must be provided.',
  )

export type PatchLedgerInput = z.infer<typeof PatchLedgerSchema>

// --- Ledger member roles ---------------------------------------------

// The role column on ledger_members allows 'owner' | 'member'. V1 only
// inserts 'member' rows for non-owner collaborators; 'owner' is held
// implicitly on ledgers.owner_user_id. The 'owner' literal is preserved
// here for forward-compatibility (co-owners, ownership transfer).
export const LEDGER_ROLES = ['owner', 'member'] as const
export type LedgerRole = (typeof LEDGER_ROLES)[number]
export const ledgerRoleField = z.enum(LEDGER_ROLES)

// --- Invites ---------------------------------------------------------

// Raw invite token prefix. The full token shape is `rpm_inv_<base64url>`;
// the SHA-256 hash is stored at rest. Sub-prefixed under the wider
// `rpm_` family (session bearers use `rpm_sess_`) so the two never
// conflate at lookup time.
export const MONEY_INVITE_CODE_PREFIX = 'rpm_inv_'

// POST /api/v1/ui/ledgers/:id/invites — mint an invite. invitedEmail
// is optional (null = open-code invite that anyone with the link can
// accept). Role defaults to 'member'.
export const CreateLedgerInviteSchema = z.object({
  invitedEmail: z
    .string()
    .trim()
    .email('Must be a valid email.')
    .max(254)
    .nullable()
    .optional(),
  role: ledgerRoleField.optional(),
})

export type CreateLedgerInviteInput = z.infer<typeof CreateLedgerInviteSchema>

// POST /api/v1/ui/ledgers/join — accept an invite. The code is the
// raw `rpm_inv_…` token; the server hashes it and looks the row up.
export const JoinLedgerSchema = z.object({
  code: z
    .string()
    .trim()
    .min(MONEY_INVITE_CODE_PREFIX.length + 1, 'Invite code is required.')
    .max(256),
})

export type JoinLedgerInput = z.infer<typeof JoinLedgerSchema>

// POST /api/v1/ui/ledgers/:id/transfer — hand ownership to an
// existing member. newOwnerUserId must be a current ledger_members row
// for this ledger.
export const TransferLedgerSchema = z.object({
  newOwnerUserId: z.string().trim().min(1).max(128),
})

export type TransferLedgerInput = z.infer<typeof TransferLedgerSchema>

// --- Ledger groups ---------------------------------------------------

// Group display name. 1–100 chars after trimming.
export const ledgerGroupNameField = z
  .string()
  .trim()
  .min(1, 'Group name is required.')
  .max(100, 'Group name must be at most 100 characters.')

// Optional group description. Empty string normalises to null.
export const ledgerGroupDescriptionField = z
  .string()
  .trim()
  .max(1000, 'Description must be at most 1000 characters.')
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .optional()

// POST /api/v1/ui/ledger-groups — create a Money-local group. The
// creator is auto-enrolled as the 'owner' member.
export const CreateLedgerGroupSchema = z.object({
  name: ledgerGroupNameField,
  description: ledgerGroupDescriptionField,
})

export type CreateLedgerGroupInput = z.infer<typeof CreateLedgerGroupSchema>

// PATCH /api/v1/ui/ledger-groups/:id — patch a group. Only name +
// description are mutable. At least one field is required.
export const PatchLedgerGroupSchema = z
  .object({
    name: ledgerGroupNameField.optional(),
    description: ledgerGroupDescriptionField,
  })
  .refine(
    (v) => v.name !== undefined || v.description !== undefined,
    'At least one of name or description must be provided.',
  )

export type PatchLedgerGroupInput = z.infer<typeof PatchLedgerGroupSchema>

// --- Expenses --------------------------------------------------------

// Split mode literal — denormalised onto expenses.split_mode and
// gates the resolver in @rallypoint/money-shared engine.
export const SPLIT_MODES = ['equal', 'by_share', 'by_amount'] as const
export type SplitModeLiteral = (typeof SPLIT_MODES)[number]
export const splitModeField = z.enum(SPLIT_MODES)

// Expense description. 1–280 chars after trimming — enough for a
// Tweet-length note.
export const expenseDescriptionField = z
  .string()
  .trim()
  .min(1, 'Description is required.')
  .max(280, 'Description must be at most 280 characters.')

// Integer cents, non-negative. JS safe integer max is fine here
// (~$90T). 0 is allowed for tracked-but-free items (e.g. comp meal).
export const centsField = z
  .number()
  .int('Cents must be an integer.')
  .min(0, 'Cents must be non-negative.')
  .max(Number.MAX_SAFE_INTEGER, 'Cents value too large.')

// ISO calendar date (YYYY-MM-DD) — the day the expense was incurred.
// Time-of-day isn't carried in V1.
export const spentAtField = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'spent_at must be YYYY-MM-DD.')

// User id field for the split rows. Bounded so a payload of garbage
// can't blow up the row.
export const splitUserIdField = z.string().trim().min(1).max(128)

// Discriminated union on split_mode. Each variant constrains the
// per-row shape:
//   equal     → both amountCents + shareWeight absent on every row
//   by_share  → shareWeight ≥ 0 (int) on every row; no amountCents
//   by_amount → amountCents ≥ 0 (int) on every row; no shareWeight
// The deep numeric invariants (sum-to-total for by_amount; not-all-zero
// for by_share) live in @rallypoint/money-shared/engine — the route
// runs the resolver to catch them.

const equalSplitRow = z.object({
  userId: splitUserIdField,
})

const byShareSplitRow = z.object({
  userId: splitUserIdField,
  shareWeight: z
    .number()
    .int('share_weight must be an integer.')
    .min(0, 'share_weight must be non-negative.')
    .max(1_000_000, 'share_weight too large.'),
})

const byAmountSplitRow = z.object({
  userId: splitUserIdField,
  amountCents: centsField,
})

// Expense category linkage. Optional on create; null on patch
// explicitly unsets it. Bounded length matches `cat_<ulid>`.
export const expenseCategoryIdField = z
  .string()
  .trim()
  .min(1, 'category_id must not be empty.')
  .max(128, 'category_id too long.')

// Opaque idempotency key for upstream cascades (design §5/§7). When a
// caller supplies the same `ref` twice for one ledger, the server
// returns the existing expense rather than creating a duplicate.
// Bounded to keep the partial-unique index tidy.
export const expenseRefField = z
  .string()
  .trim()
  .min(1, 'ref must not be empty.')
  .max(256, 'ref must be at most 256 characters.')

const equalExpensePayload = z.object({
  splitMode: z.literal('equal'),
  paidByUserId: splitUserIdField,
  totalCents: centsField,
  description: expenseDescriptionField,
  spentAt: spentAtField,
  categoryId: expenseCategoryIdField.nullable().optional(),
  ref: expenseRefField.nullable().optional(),
  splits: z.array(equalSplitRow).min(1, 'At least one participant is required.'),
})

const byShareExpensePayload = z.object({
  splitMode: z.literal('by_share'),
  paidByUserId: splitUserIdField,
  totalCents: centsField,
  description: expenseDescriptionField,
  spentAt: spentAtField,
  categoryId: expenseCategoryIdField.nullable().optional(),
  ref: expenseRefField.nullable().optional(),
  splits: z.array(byShareSplitRow).min(1, 'At least one participant is required.'),
})

const byAmountExpensePayload = z.object({
  splitMode: z.literal('by_amount'),
  paidByUserId: splitUserIdField,
  totalCents: centsField,
  description: expenseDescriptionField,
  spentAt: spentAtField,
  categoryId: expenseCategoryIdField.nullable().optional(),
  ref: expenseRefField.nullable().optional(),
  splits: z.array(byAmountSplitRow).min(1, 'At least one participant is required.'),
})

// POST /api/v1/ui/ledgers/:id/expenses — create an expense. The split
// payload shape is discriminated on `splitMode`.
export const CreateExpenseSchema = z.discriminatedUnion('splitMode', [
  equalExpensePayload,
  byShareExpensePayload,
  byAmountExpensePayload,
])

export type CreateExpenseInput = z.infer<typeof CreateExpenseSchema>

// PATCH /api/v1/ui/ledgers/:id/expenses/:expenseId — patch the
// non-structural fields. Re-categorising or moving the spent date
// is allowed; changing the split mode or the splits themselves
// requires a delete + recreate so the historical balance projection
// stays consistent. At least one field is required.
// categoryId: pass a string to set, `null` to explicitly unset,
// or omit to leave unchanged.
export const PatchExpenseSchema = z
  .object({
    description: expenseDescriptionField.optional(),
    spentAt: spentAtField.optional(),
    categoryId: expenseCategoryIdField.nullable().optional(),
  })
  .refine(
    (v) =>
      v.description !== undefined ||
      v.spentAt !== undefined ||
      v.categoryId !== undefined,
    'At least one of description, spentAt, or categoryId must be provided.',
  )

export type PatchExpenseInput = z.infer<typeof PatchExpenseSchema>

// --- Expense categories ----------------------------------------------

// Category name: 1–50 chars after trim. Per-ledger unique (handled
// at the DB level via UniqueConstraintError).
export const expenseCategoryNameField = z
  .string()
  .trim()
  .min(1, 'Category name is required.')
  .max(50, 'Category name must be at most 50 characters.')

// Hex color string `#RRGGBB`, lower or upper-case. The UI renders the
// chip with this background; lighter / darker variants are derived
// in CSS, so the stored color is the source of truth.
export const expenseCategoryColorField = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex string like #1abc9c.')
  .transform((s) => s.toLowerCase())

// Explicit sort order — drag-to-reorder updates this integer; ties
// broken by id at query time. Bounded to fit a smallint comfortably.
export const expenseCategorySortOrderField = z
  .number()
  .int('sort_order must be an integer.')
  .min(-32_768, 'sort_order too small.')
  .max(32_767, 'sort_order too large.')

// POST /api/v1/ui/ledgers/:id/categories — create.
export const CreateExpenseCategorySchema = z.object({
  name: expenseCategoryNameField,
  color: expenseCategoryColorField,
  sortOrder: expenseCategorySortOrderField.optional(),
})

export type CreateExpenseCategoryInput = z.infer<typeof CreateExpenseCategorySchema>

// PATCH /api/v1/ui/ledgers/:id/categories/:categoryId — at least one
// field is required.
export const PatchExpenseCategorySchema = z
  .object({
    name: expenseCategoryNameField.optional(),
    color: expenseCategoryColorField.optional(),
    sortOrder: expenseCategorySortOrderField.optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.color !== undefined || v.sortOrder !== undefined,
    'At least one of name, color, or sortOrder must be provided.',
  )

export type PatchExpenseCategoryInput = z.infer<typeof PatchExpenseCategorySchema>

// --- Settlements -----------------------------------------------------

// Settlement note. Optional one-line memo ("Venmo'd you"). Empty
// string normalises to null at the validator boundary.
export const settlementNoteField = z
  .string()
  .trim()
  .max(280, 'Note must be at most 280 characters.')
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .optional()

// Settlement amount: positive integer cents. 0-cent settlements are
// rejected (nothing to record), unlike expense splits where 0 is
// allowed as a sentinel for "this participant has no share."
export const settlementAmountCentsField = z
  .number()
  .int('amount_cents must be an integer.')
  .min(1, 'amount_cents must be at least 1.')
  .max(Number.MAX_SAFE_INTEGER, 'amount_cents value too large.')

// POST /api/v1/ui/ledgers/:id/settlements — log a payment between
// two ledger members. The actor (created_by) need not be either
// party — any member can record a payment on behalf of two parties,
// matching Splitwise's trust model. The activity log captures the
// actor for accountability. from/to must differ; both must be
// current ledger members.
export const CreateSettlementSchema = z
  .object({
    fromUserId: splitUserIdField,
    toUserId: splitUserIdField,
    amountCents: settlementAmountCentsField,
    note: settlementNoteField,
    settledAt: spentAtField,
  })
  .refine(
    (v) => v.fromUserId !== v.toUserId,
    'from_user_id and to_user_id must differ.',
  )

export type CreateSettlementInput = z.infer<typeof CreateSettlementSchema>

// Re-export so apps/money-api can import the union without pulling
// in receipt-constraints.js directly.
export type { ReceiptMimeType }

// --- SDK (peer-app) surface ------------------------------------------

// POST /api/v1/sdk/money/ledgers/ensure-for-group — find-or-create the
// default ledger for a group. Called by events-api on group creation
// (and lazily on group detail) so a group always has a ledger attached.
// Idempotent: a second call with the same scope_id returns the same
// ledger. Currency defaults to USD if unspecified; the caller can
// pin a non-USD currency at first-create time only.
export const SdkEnsureGroupLedgerSchema = z.object({
  scopeId: moneyScopeIdField,
  ownerUserId: z.string().trim().min(1).max(128),
  name: ledgerNameField.optional(),
  currency: currencyField.optional(),
  description: ledgerDescriptionField,
})

export type SdkEnsureGroupLedgerInput = z.infer<typeof SdkEnsureGroupLedgerSchema>
