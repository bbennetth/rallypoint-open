import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  computeBalances,
  moneyScopeIdField,
  moneyScopeTypeField,
  SdkEnsureGroupLedgerSchema,
  type ExpenseLite,
} from '@rallypoint/money-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type {
  ExpenseSplitRecord,
  ExpenseWithSplits,
  LedgerRecord,
} from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { TENANT } from './_access.js'

// The /api/v1/sdk/money surface peer apps (events-api) call
// server-to-server. Gated by requireSdkKey in build-app — cookieless,
// key-authenticated. The caller asserts authorization for the
// requested scope (events-api checks group membership before
// proxying), since a group scope_id is opaque here.
//
// Shape matches @rallypoint/money-client: a flat camelCase DTO
// (NOT the UI surface's snake_case {items} envelope).

function serializeLedgerDto(l: LedgerRecord): Record<string, unknown> {
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

function serializeExpenseDto(e: ExpenseWithSplits): Record<string, unknown> {
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

function splitRecordsToLite(splits: ExpenseSplitRecord[]) {
  return splits.map((s) => ({
    userId: s.userId,
    amountCents: s.amountCents,
    shareWeight: s.shareWeight,
  }))
}

const DEFAULT_GROUP_LEDGER_CURRENCY = 'USD'

export const sdkMoneyRoutes = new Hono<HonoApp>()
  // --- list ledgers in a scope ---------------------------------------
  // Caller (events-api) checks scope authz before calling. We just
  // surface non-deleted rows that match.
  .get('/api/v1/sdk/money/ledgers', async (c) => {
    const scopeType = moneyScopeTypeField.safeParse(c.req.query('scope_type'))
    const scopeId = moneyScopeIdField.safeParse(c.req.query('scope_id'))
    if (!scopeType.success || !scopeId.success) {
      throw errors.validation({
        issues: [
          ...(scopeType.success ? [] : scopeType.error.issues),
          ...(scopeId.success ? [] : scopeId.error.issues),
        ],
      })
    }
    const rows = await c.var.repos.ledgers.listForScope({
      tenantId: TENANT,
      scopeType: scopeType.data,
      scopeId: scopeId.data,
    })
    return c.json(rows.map(serializeLedgerDto))
  })

  // --- find-or-create the default group ledger ------------------------
  // Idempotent: when a non-deleted ledger already exists for the given
  // group scope, return the oldest one (the "default"). Otherwise mint
  // a fresh ledger. Used by events-api on group creation so every group
  // has a money ledger by default, AND lazily on group-detail fetch
  // so a group created before money was available self-heals.
  //
  // Response includes `created: true|false` so the caller can
  // distinguish a freshly-created ledger from an existing one and
  // skip a duplicate activity log entry on the events side.
  .post('/api/v1/sdk/money/ledgers/ensure-for-group', async (c) => {
    const parsed = SdkEnsureGroupLedgerSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    const existing = await c.var.repos.ledgers.listForScope({
      tenantId: TENANT,
      scopeType: 'group',
      scopeId: body.scopeId,
    })
    if (existing.length > 0) {
      return c.json({ ...serializeLedgerDto(existing[0]!), created: false }, 200)
    }

    const ledger = await c.var.repos.ledgers.create({
      id: `led_${ulid()}`,
      tenantId: TENANT,
      scopeType: 'group',
      scopeId: body.scopeId,
      ownerUserId: body.ownerUserId,
      name: body.name ?? 'Group expenses',
      currency: body.currency ?? DEFAULT_GROUP_LEDGER_CURRENCY,
      description: body.description ?? null,
    })
    return c.json({ ...serializeLedgerDto(ledger), created: true }, 201)
  })

  // --- list expenses for a ledger (read-only) ------------------------
  // Caller has already confirmed the ledger belongs to a scope it is
  // authorized for; money-api only verifies the ledger is live.
  .get('/api/v1/sdk/money/ledgers/:ledgerId/expenses', async (c) => {
    const ledger = await c.var.repos.ledgers.findById(c.req.param('ledgerId'))
    if (!ledger || ledger.deletedAt) throw errors.ledgerNotFound()
    const rows = await c.var.repos.expenses.listForLedger(ledger.id)
    return c.json(rows.map(serializeExpenseDto))
  })

  // --- balances for a ledger (read-only) -----------------------------
  // Sign convention is "positive = they owe the viewer". On the SDK
  // surface the viewer must be supplied as a query param — the caller
  // (events-api) injects the actor's user_id after running the group
  // membership check.
  .get('/api/v1/sdk/money/ledgers/:ledgerId/balances', async (c) => {
    const ledger = await c.var.repos.ledgers.findById(c.req.param('ledgerId'))
    if (!ledger || ledger.deletedAt) throw errors.ledgerNotFound()
    const viewerUserId = c.req.query('viewer_user_id')
    if (!viewerUserId) {
      throw errors.validation({
        issues: [{ path: ['viewer_user_id'], message: 'viewer_user_id is required.' }],
      })
    }
    const [expenseRows, settlementRows] = await Promise.all([
      c.var.repos.expenses.listForLedger(ledger.id),
      c.var.repos.settlements.listForLedger(ledger.id),
    ])
    const expensesLite: ExpenseLite[] = expenseRows.map((e) => ({
      paidByUserId: e.paidByUserId,
      totalCents: e.totalCents,
      splitMode: e.splitMode,
      splits: splitRecordsToLite(e.splits),
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
    return c.json({
      ledgerId: ledger.id,
      currency: ledger.currency,
      viewerUserId,
      items: rows.map((r) => ({ userId: r.userId, netCents: r.netCents })),
    })
  })
