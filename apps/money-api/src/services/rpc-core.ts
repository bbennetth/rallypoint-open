import { ulid } from 'ulid'
import {
  computeBalances,
  type ExpenseLite,
} from '@rallypoint/money-shared'
import type { Env } from '../env.js'
import type { Logger } from '../logger.js'
import type { Repos, LedgerRecord, ExpenseWithSplits, ExpenseSplitRecord } from '../repos/types.js'
import type { LedgerActorRole } from '../routes/_access.js'
import { TENANT } from '../routes/_access.js'

// Cross-Worker RPC core for the money-api SDK surface (feat/rpc-bindings
// PR 1). The HTTP handler at `routes/sdk-money.ts` and the `MoneyRPC`
// WorkerEntrypoint at `rpc.ts` both call these fns — kept in lockstep so
// the legacy HTTP path stays correct until PR 3 deletes it.
//
// The membership gate (#4 from the 2026-06-24 audit) is enforced here
// rather than left to the caller: viewer_user_id must be a live ledger
// member, and the failure mode is the opaque `not_found` (mirroring the
// route's 404 anti-enumeration posture).

const DEFAULT_GROUP_LEDGER_CURRENCY = 'USD'

export interface MoneyRpcDeps {
  env: Env
  logger: Logger
  repos: Repos
}

// Result discriminator. `not_found` covers "ledger gone, viewer is not
// a member, or membership check failed" — the route translates it to
// errors.ledgerNotFound() (a 404). Splitting branches here would
// reintroduce the existence-leak fingerprint the audit closed.
export type LedgerNotFound = { kind: 'not_found' }
export type Ok<T> = { kind: 'ok'; data: T }

export interface LedgerDto {
  id: string
  scopeType: string
  scopeId: string
  ownerUserId: string
  name: string
  currency: string
  description: string | null
  createdAt: string
  updatedAt: string
}

export interface ExpenseDto {
  id: string
  ledgerId: string
  paidByUserId: string
  totalCents: number
  description: string | null
  splitMode: string
  categoryId: string | null
  ref: string | null
  spentAt: string | null
  createdAt: string
  updatedAt: string
  // amountCents / shareWeight are nullable to match
  // packages/money-shared::SplitRow — `by_amount` splits set
  // amountCents and leave shareWeight null, `by_share` does the
  // inverse, and `equal` leaves both null.
  splits: Array<{ userId: string; amountCents: number | null; shareWeight: number | null }>
}

export interface BalanceDto {
  ledgerId: string
  currency: string
  viewerUserId: string
  items: Array<{ userId: string; netCents: number }>
}

export interface EnsureGroupLedgerInput {
  scopeId: string
  ownerUserId: string
  name?: string | undefined
  currency?: string | undefined
  description?: string | null | undefined
}

export interface EnsureGroupLedgerResult extends LedgerDto {
  created: boolean
}

export async function listLedgersCore(
  scopeType: string,
  scopeId: string,
  deps: MoneyRpcDeps,
): Promise<LedgerDto[]> {
  const rows = await deps.repos.ledgers.listForScope({
    tenantId: TENANT,
    scopeType: scopeType as LedgerRecord['scopeType'],
    scopeId,
  })
  return rows.map(serializeLedger)
}

export async function ensureGroupLedgerCore(
  input: EnsureGroupLedgerInput,
  deps: MoneyRpcDeps,
): Promise<EnsureGroupLedgerResult> {
  const existing = await deps.repos.ledgers.listForScope({
    tenantId: TENANT,
    scopeType: 'group',
    scopeId: input.scopeId,
  })
  if (existing.length > 0) {
    return { ...serializeLedger(existing[0]!), created: false }
  }

  const ledger = await deps.repos.ledgers.create({
    id: `led_${ulid()}`,
    tenantId: TENANT,
    scopeType: 'group',
    scopeId: input.scopeId,
    ownerUserId: input.ownerUserId,
    name: input.name ?? 'Group expenses',
    currency: input.currency ?? DEFAULT_GROUP_LEDGER_CURRENCY,
    description: input.description ?? null,
  })
  return { ...serializeLedger(ledger), created: true }
}

export async function listExpensesCore(
  ledgerId: string,
  viewerUserId: string,
  deps: MoneyRpcDeps,
): Promise<Ok<ExpenseDto[]> | LedgerNotFound> {
  const ledger = await deps.repos.ledgers.findById(ledgerId)
  if (!ledger || ledger.deletedAt) return { kind: 'not_found' }
  const role = await resolveRole(deps, ledger, viewerUserId)
  if (role === null) return { kind: 'not_found' }
  const rows = await deps.repos.expenses.listForLedger(ledger.id)
  return { kind: 'ok', data: rows.map(serializeExpense) }
}

export async function getBalancesCore(
  ledgerId: string,
  viewerUserId: string,
  deps: MoneyRpcDeps,
): Promise<Ok<BalanceDto> | LedgerNotFound> {
  const ledger = await deps.repos.ledgers.findById(ledgerId)
  if (!ledger || ledger.deletedAt) return { kind: 'not_found' }
  const role = await resolveRole(deps, ledger, viewerUserId)
  if (role === null) return { kind: 'not_found' }
  const [expenseRows, settlementRows] = await Promise.all([
    deps.repos.expenses.listForLedger(ledger.id),
    deps.repos.settlements.listForLedger(ledger.id),
  ])
  const expensesLite: ExpenseLite[] = expenseRows.map((e) => ({
    paidByUserId: e.paidByUserId,
    totalCents: e.totalCents,
    splitMode: e.splitMode,
    splits: splitsLite(e.splits),
  }))
  const rows = computeBalances(
    expensesLite,
    settlementRows.map((s) => ({
      fromUserId: s.fromUserId,
      toUserId: s.toUserId,
      amountCents: s.amountCents,
    })),
    viewerUserId,
  )
  return {
    kind: 'ok',
    data: {
      ledgerId: ledger.id,
      currency: ledger.currency,
      viewerUserId,
      items: rows.map((r) => ({ userId: r.userId, netCents: r.netCents })),
    },
  }
}

// Pure repo-only port of `routes/_access.ts::actorRole`. The Hono helper
// reads `c.var.repos.ledgerMembers`, but the RPC core fn already carries
// `deps.repos` — so we can sit on the same data path without dragging
// the Hono context in.
async function resolveRole(
  deps: MoneyRpcDeps,
  ledger: LedgerRecord,
  userId: string,
): Promise<LedgerActorRole | null> {
  if (ledger.ownerUserId === userId) return 'owner'
  const member = await deps.repos.ledgerMembers.findByLedgerAndUser(ledger.id, userId)
  if (!member) return null
  return member.role === 'owner' ? 'owner' : 'member'
}

function serializeLedger(l: LedgerRecord): LedgerDto {
  return {
    id: l.id,
    scopeType: l.scopeType,
    scopeId: l.scopeId,
    ownerUserId: l.ownerUserId,
    name: l.name,
    currency: l.currency,
    description: l.description,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  }
}

function serializeExpense(e: ExpenseWithSplits): ExpenseDto {
  return {
    id: e.id,
    ledgerId: e.ledgerId,
    paidByUserId: e.paidByUserId,
    totalCents: e.totalCents,
    description: e.description,
    splitMode: e.splitMode,
    categoryId: e.categoryId,
    ref: e.ref,
    spentAt: e.spentAt,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    splits: e.splits.map((s) => ({
      userId: s.userId,
      amountCents: s.amountCents,
      shareWeight: s.shareWeight,
    })),
  }
}

function splitsLite(splits: ExpenseSplitRecord[]): ExpenseLite['splits'] {
  return splits.map((s) => ({
    userId: s.userId,
    amountCents: s.amountCents,
    shareWeight: s.shareWeight,
  }))
}
