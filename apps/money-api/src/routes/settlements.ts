import { Hono } from 'hono'
import { ulid } from 'ulid'
import { CreateSettlementSchema } from '@rallypoint/money-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { LedgerRecord, SettlementRecord } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { envelope, ledgerChannel } from '../realtime/channels.js'
import { publish } from '../realtime/publish.js'
import { loadLedgerForAction, recordActivity } from './_access.js'

function serializeSettlement(s: SettlementRecord): Record<string, unknown> {
  return {
    id: s.id,
    ledger_id: s.ledgerId,
    from_user_id: s.fromUserId,
    to_user_id: s.toUserId,
    amount_cents: s.amountCents,
    note: s.note,
    settled_at: s.settledAt,
    created_by: s.createdBy,
    created_at: s.createdAt.toISOString(),
  }
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

export const settlementsRoutes = new Hono<HonoApp>()
  // --- record a settlement (any member or owner) ---------------------
  // Any ledger member can record a payment — the activity log
  // captures the actor for accountability. Splitwise's trust model.
  .post('/api/v1/ui/ledgers/:id/settlements', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'member')
    const parsed = CreateSettlementSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    const participants = await ledgerParticipantSet(c, ledger)
    if (!participants.has(body.fromUserId)) {
      throw errors.settlementInvalid({
        violation: 'from_not_member',
        user_id: body.fromUserId,
      })
    }
    if (!participants.has(body.toUserId)) {
      throw errors.settlementInvalid({
        violation: 'to_not_member',
        user_id: body.toUserId,
      })
    }

    const userId = c.var.session!.userId
    const settlement = await c.var.repos.settlements.create({
      id: `stl_${ulid()}`,
      ledgerId: ledger.id,
      fromUserId: body.fromUserId,
      toUserId: body.toUserId,
      amountCents: body.amountCents,
      note: body.note ?? null,
      settledAt: body.settledAt,
      createdBy: userId,
    })
    await recordActivity(c, ledger.id, 'settlement.recorded', {
      settlement_id: settlement.id,
      from_user_id: settlement.fromUserId,
      to_user_id: settlement.toUserId,
      amount_cents: settlement.amountCents,
    })
    publish(
      c,
      ledgerChannel(ledger.id),
      envelope('settlements', 'create', settlement.id, userId),
    )
    return c.json(serializeSettlement(settlement), 201)
  })

  // --- list (member+) ------------------------------------------------
  .get('/api/v1/ui/ledgers/:id/settlements', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'member')
    const rows = await c.var.repos.settlements.listForLedger(ledger.id)
    return c.json({ items: rows.map(serializeSettlement) })
  })

  // --- delete (any member — Splitwise trust model) -------------------
  // No soft-delete column on settlements (design §5). The activity
  // log retains the create + delete pair so the audit trail survives.
  .delete('/api/v1/ui/ledgers/:id/settlements/:settlementId', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'member')
    const settlement = await c.var.repos.settlements.findById(c.req.param('settlementId'))
    if (!settlement || settlement.ledgerId !== ledger.id) {
      throw errors.settlementNotFound()
    }
    await c.var.repos.settlements.delete(settlement.id)
    await recordActivity(c, ledger.id, 'settlement.deleted', {
      settlement_id: settlement.id,
      from_user_id: settlement.fromUserId,
      to_user_id: settlement.toUserId,
      amount_cents: settlement.amountCents,
    })
    publish(
      c,
      ledgerChannel(ledger.id),
      envelope('settlements', 'delete', settlement.id, c.var.session!.userId),
    )
    return c.body(null, 204)
  })
