import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  CreateExpenseSchema,
  PatchExpenseSchema,
  computeBalances,
  resolveSplit,
  SplitInvariantError,
  type ExpenseLite,
  type SettlementLite,
  type SplitRow,
} from '@rallypoint/money-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type {
  ExpenseSplitRecord,
  ExpenseWithSplits,
  LedgerRecord,
} from '../repos/types.js'
import { UniqueConstraintError } from '../repos/errors.js'
import { readJsonBody } from './_body.js'
import { envelope, ledgerChannel } from '../realtime/channels.js'
import { publish } from '../realtime/publish.js'
import { loadLedgerForAction, recordActivity } from './_access.js'

function serializeExpense(e: ExpenseWithSplits): Record<string, unknown> {
  return {
    id: e.id,
    ledger_id: e.ledgerId,
    paid_by_user_id: e.paidByUserId,
    total_cents: e.totalCents,
    description: e.description,
    split_mode: e.splitMode,
    category_id: e.categoryId,
    ref: e.ref,
    receipt_object_key: e.receiptObjectKey,
    receipt_content_type: e.receiptContentType,
    receipt_bytes: e.receiptBytes,
    spent_at: e.spentAt,
    created_by: e.createdBy,
    created_at: e.createdAt.toISOString(),
    updated_at: e.updatedAt.toISOString(),
    // Only present when the row has been soft-deleted — surfaces in
    // the idempotent-tombstone response so callers can detect that
    // state without a follow-up GET.
    ...(e.deletedAt !== null ? { deleted_at: e.deletedAt.toISOString() } : {}),
    splits: e.splits.map((s) => ({
      user_id: s.userId,
      amount_cents: s.amountCents,
      share_weight: s.shareWeight,
    })),
  }
}

// Confirm a category_id belongs to the given ledger. null is allowed
// (means "no category"). Throws `category_wrong_ledger` for missing
// or cross-ledger refs.
async function assertCategoryOnLedger(
  c: Parameters<typeof loadLedgerForAction>[0],
  ledgerId: string,
  categoryId: string | null | undefined,
): Promise<void> {
  if (!categoryId) return
  const cat = await c.var.repos.expenseCategories.findById(categoryId)
  if (!cat || cat.ledgerId !== ledgerId) throw errors.categoryWrongLedger()
}

// Build the set of acceptable participant user IDs for a ledger:
// the owner + every member row.
async function ledgerParticipantSet(
  c: Parameters<typeof loadLedgerForAction>[0],
  ledger: LedgerRecord,
): Promise<Set<string>> {
  const members = await c.var.repos.ledgerMembers.listForLedger(ledger.id)
  return new Set<string>([ledger.ownerUserId, ...members.map((m) => m.userId)])
}

// Translate a SplitInvariantError thrown by the engine into the
// `split_invalid` API error. Keeps the engine pure (it doesn't know
// about HTTP).
function rethrowAsSplitInvalid(err: unknown): never {
  if (err instanceof SplitInvariantError) {
    throw errors.splitInvalid({ violation: err.code, ...err.detail })
  }
  throw err
}

// Map the validated zod payload into the unified SplitRow shape the
// engine expects.
function payloadToSplits(body: {
  splitMode: 'equal' | 'by_share' | 'by_amount'
  splits: ReadonlyArray<{
    userId: string
    amountCents?: number
    shareWeight?: number
  }>
}): SplitRow[] {
  switch (body.splitMode) {
    case 'equal':
      return body.splits.map((s) => ({
        userId: s.userId,
        amountCents: null,
        shareWeight: null,
      }))
    case 'by_share':
      return body.splits.map((s) => ({
        userId: s.userId,
        amountCents: null,
        shareWeight: s.shareWeight!,
      }))
    case 'by_amount':
      return body.splits.map((s) => ({
        userId: s.userId,
        amountCents: s.amountCents!,
        shareWeight: null,
      }))
  }
}

function splitRecordsToLite(splits: ExpenseSplitRecord[]): SplitRow[] {
  return splits.map((s) => ({
    userId: s.userId,
    amountCents: s.amountCents,
    shareWeight: s.shareWeight,
  }))
}

export const expensesRoutes = new Hono<HonoApp>()
  // --- create expense (any member or owner) --------------------------
  .post('/api/v1/ui/ledgers/:id/expenses', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'member')
    const parsed = CreateExpenseSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    // Authz: paid_by + every participant must be a current ledger
    // member (or the owner). Catches "alice expensed something for
    // bob's debt" payloads.
    const participants = await ledgerParticipantSet(c, ledger)
    if (!participants.has(body.paidByUserId)) {
      throw errors.splitInvalid({
        violation: 'paid_by_not_member',
        user_id: body.paidByUserId,
      })
    }
    for (const s of body.splits) {
      if (!participants.has(s.userId)) {
        throw errors.splitInvalid({
          violation: 'participant_not_member',
          user_id: s.userId,
        })
      }
    }

    // Run the engine to validate the split shape before persistence.
    // This catches by_amount sum mismatch and by_share all-zero.
    const splitRows = payloadToSplits(body)
    try {
      resolveSplit(
        { splitMode: body.splitMode, totalCents: body.totalCents },
        splitRows,
      )
    } catch (err) {
      rethrowAsSplitInvalid(err)
    }

    // Cross-ledger category guard runs BEFORE the row is built.
    await assertCategoryOnLedger(c, ledger.id, body.categoryId ?? null)

    const userId = c.var.session!.userId
    const ref = body.ref ?? null

    // Idempotent-create on (ledger_id, ref): if the caller supplied a
    // ref and we've seen it before, return the existing row instead
    // of inserting again. Pre-flight check avoids the optimistic
    // insert when a steady-state cascade replays the same ref.
    if (ref !== null) {
      const existing = await c.var.repos.expenses.findByLedgerAndRef(ledger.id, ref)
      if (existing) {
        if (existing.deletedAt !== null) {
          throw errors.expenseRefTakenByDeleted({
            ref,
            expense_id: existing.id,
            deleted_at: existing.deletedAt.toISOString(),
          })
        }
        return c.json({ ...serializeExpense(existing), idempotent: true }, 200)
      }
    }

    let expense: ExpenseWithSplits
    try {
      expense = await c.var.repos.expenses.create({
        id: `exp_${ulid()}`,
        ledgerId: ledger.id,
        paidByUserId: body.paidByUserId,
        totalCents: body.totalCents,
        description: body.description,
        splitMode: body.splitMode,
        categoryId: body.categoryId ?? null,
        ref,
        spentAt: body.spentAt,
        createdBy: userId,
        splits: splitRows,
      })
    } catch (err) {
      // Race: two parallel posts with the same ref both got past the
      // pre-flight; the second hit the partial-unique index. Same
      // fall-back: fetch and return the winner.
      if (err instanceof UniqueConstraintError && ref !== null) {
        const existing = await c.var.repos.expenses.findByLedgerAndRef(ledger.id, ref)
        if (existing) {
          if (existing.deletedAt !== null) {
            throw errors.expenseRefTakenByDeleted({
              ref,
              expense_id: existing.id,
              deleted_at: existing.deletedAt.toISOString(),
            })
          }
          return c.json({ ...serializeExpense(existing), idempotent: true }, 200)
        }
      }
      throw err
    }
    await recordActivity(c, ledger.id, 'expense.created', {
      expense_id: expense.id,
      total_cents: expense.totalCents,
      split_mode: expense.splitMode,
      ...(ref !== null ? { ref } : {}),
    })
    publish(
      c,
      ledgerChannel(ledger.id),
      envelope('expenses', 'create', expense.id, userId),
    )
    return c.json(serializeExpense(expense), 201)
  })

  // --- list (member+) ------------------------------------------------
  .get('/api/v1/ui/ledgers/:id/expenses', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'member')
    const rows = await c.var.repos.expenses.listForLedger(ledger.id)
    return c.json({ items: rows.map(serializeExpense) })
  })

  // --- detail (member+) ----------------------------------------------
  .get('/api/v1/ui/ledgers/:id/expenses/:expenseId', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'member')
    const exp = await c.var.repos.expenses.findByIdActive(c.req.param('expenseId'))
    if (!exp || exp.ledgerId !== ledger.id) throw errors.expenseNotFound()
    return c.json(serializeExpense(exp))
  })

  // --- patch (member+) -----------------------------------------------
  // The strict structural fields (split mode + splits + amounts +
  // paid_by) can't be edited in place — delete & recreate is the
  // supported path so the activity log captures the swap clearly.
  .patch('/api/v1/ui/ledgers/:id/expenses/:expenseId', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'member')
    const exp = await c.var.repos.expenses.findByIdActive(c.req.param('expenseId'))
    if (!exp || exp.ledgerId !== ledger.id) throw errors.expenseNotFound()
    const parsed = PatchExpenseSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    if (parsed.data.categoryId !== undefined) {
      await assertCategoryOnLedger(c, ledger.id, parsed.data.categoryId)
    }

    const updated = await c.var.repos.expenses.patch(exp.id, parsed.data)
    if (!updated) throw errors.expenseNotFound()
    await recordActivity(c, ledger.id, 'expense.patched', {
      expense_id: exp.id,
      fields: Object.keys(parsed.data),
    })
    publish(
      c,
      ledgerChannel(ledger.id),
      envelope('expenses', 'update', exp.id, c.var.session!.userId),
    )
    return c.json({
      ...serializeExpense({ ...updated, splits: exp.splits }),
    })
  })

  // --- soft-delete (member+) -----------------------------------------
  .delete('/api/v1/ui/ledgers/:id/expenses/:expenseId', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'member')
    const exp = await c.var.repos.expenses.findByIdActive(c.req.param('expenseId'))
    if (!exp || exp.ledgerId !== ledger.id) throw errors.expenseNotFound()
    await c.var.repos.expenses.softDelete(exp.id, new Date())
    await recordActivity(c, ledger.id, 'expense.soft_deleted', {
      expense_id: exp.id,
    })
    publish(
      c,
      ledgerChannel(ledger.id),
      envelope('expenses', 'delete', exp.id, c.var.session!.userId),
    )
    return c.body(null, 204)
  })

  // --- balances (member+) --------------------------------------------
  // Projects the per-other-user net cents balance from the caller's
  // POV. Folds in both expenses (split-resolved) and settlements
  // (reductions on outstanding debt) — slice 4 wired the second
  // input.
  .get('/api/v1/ui/ledgers/:id/balances', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'member')
    const viewerUserId = c.var.session!.userId
    const [expenses, settlements] = await Promise.all([
      c.var.repos.expenses.listForLedger(ledger.id),
      c.var.repos.settlements.listForLedger(ledger.id),
    ])
    const expensesLite: ExpenseLite[] = expenses.map((e) => ({
      paidByUserId: e.paidByUserId,
      totalCents: e.totalCents,
      splitMode: e.splitMode,
      splits: splitRecordsToLite(e.splits),
    }))
    const settlementsLite: SettlementLite[] = settlements.map((s) => ({
      fromUserId: s.fromUserId,
      toUserId: s.toUserId,
      amountCents: s.amountCents,
    }))
    let rows
    try {
      rows = computeBalances(expensesLite, settlementsLite, viewerUserId)
    } catch (err) {
      rethrowAsSplitInvalid(err)
    }
    return c.json({
      ledger_id: ledger.id,
      currency: ledger.currency,
      viewer_user_id: viewerUserId,
      // Sign convention: positive = that user owes the viewer.
      items: rows.map((r) => ({
        user_id: r.userId,
        net_cents: r.netCents,
      })),
    })
  })
