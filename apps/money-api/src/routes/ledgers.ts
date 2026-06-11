import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  CreateLedgerSchema,
  PatchLedgerSchema,
  TransferLedgerSchema,
} from '@rallypoint/money-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { LedgerMemberRecord, LedgerRecord } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { envelope, ledgerChannel, scopeChannel } from '../realtime/channels.js'
import { publish } from '../realtime/publish.js'
import { loadLedgerForAction, recordActivity, TENANT } from './_access.js'

// All ledger rows share the platform default tenant in V1.

function serializeLedger(l: LedgerRecord): Record<string, unknown> {
  return {
    id: l.id,
    scope_type: l.scopeType,
    scope_id: l.scopeId,
    owner_user_id: l.ownerUserId,
    name: l.name,
    currency: l.currency,
    description: l.description,
    created_at: l.createdAt.toISOString(),
    updated_at: l.updatedAt.toISOString(),
  }
}

function serializeMember(m: LedgerMemberRecord): Record<string, unknown> {
  return {
    id: m.id,
    user_id: m.userId,
    role: m.role,
    joined_at: m.joinedAt.toISOString(),
  }
}

export const ledgersRoutes = new Hono<HonoApp>()
  // --- create --------------------------------------------------------
  .post('/api/v1/ui/ledgers', async (c) => {
    const userId = c.var.session!.userId
    const parsed = CreateLedgerSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    const ledger = await c.var.repos.ledgers.create({
      id: `led_${ulid()}`,
      tenantId: TENANT,
      scopeType: body.scopeType,
      scopeId: body.scopeId,
      ownerUserId: userId,
      name: body.name,
      currency: body.currency,
      description: body.description ?? null,
    })
    await recordActivity(c, ledger.id, 'ledger.created', {
      scope_type: ledger.scopeType,
      scope_id: ledger.scopeId,
      currency: ledger.currency,
    })
    // Notify the scope overview that a new ledger exists.
    publish(
      c,
      scopeChannel(ledger.scopeType, ledger.scopeId),
      envelope('ledgers', 'create', ledger.id, userId),
    )
    return c.json(serializeLedger(ledger), 201)
  })

  // --- list (caller's owned + shared ledgers) ------------------------
  .get('/api/v1/ui/ledgers', async (c) => {
    const userId = c.var.session!.userId
    const [owned, shared] = await Promise.all([
      c.var.repos.ledgers.listForOwner(userId),
      c.var.repos.ledgerMembers.listLedgersForUser(userId),
    ])
    // De-dupe — a user might own a ledger AND have a member row (e.g.
    // a co-owner after a transfer) — and put owner-relation first.
    const seen = new Set<string>()
    const items: Array<Record<string, unknown>> = []
    for (const l of owned) {
      seen.add(l.id)
      items.push({ ...serializeLedger(l), viewer_role: 'owner' })
    }
    for (const l of shared) {
      if (seen.has(l.id)) continue
      seen.add(l.id)
      items.push({ ...serializeLedger(l), viewer_role: 'member' })
    }
    return c.json({ items })
  })

  // --- detail (members + owner) --------------------------------------
  .get('/api/v1/ui/ledgers/:id', async (c) => {
    const { ledger, role } = await loadLedgerForAction(c, c.req.param('id'), 'member')
    const members = await c.var.repos.ledgerMembers.listForLedger(ledger.id)
    return c.json({
      ...serializeLedger(ledger),
      viewer_role: role,
      members: members.map(serializeMember),
    })
  })

  // --- patch (owner only) --------------------------------------------
  .patch('/api/v1/ui/ledgers/:id', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'owner')
    const parsed = PatchLedgerSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const fields = parsed.data
    const updated = await c.var.repos.ledgers.patch(ledger.id, fields)
    if (!updated) throw errors.ledgerNotFound()
    await recordActivity(c, ledger.id, 'ledger.patched', {
      fields: Object.keys(fields),
    })
    publish(
      c,
      ledgerChannel(ledger.id),
      envelope('ledgers', 'update', ledger.id, c.var.session!.userId),
    )
    return c.json(serializeLedger(updated))
  })

  // --- soft-delete (owner only) --------------------------------------
  .delete('/api/v1/ui/ledgers/:id', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'owner')
    await c.var.repos.ledgers.softDelete(ledger.id, new Date())
    await recordActivity(c, ledger.id, 'ledger.soft_deleted', {})
    publish(
      c,
      ledgerChannel(ledger.id),
      envelope('ledgers', 'delete', ledger.id, c.var.session!.userId),
    )
    return c.body(null, 204)
  })

  // --- transfer ownership (owner only) -------------------------------
  .post('/api/v1/ui/ledgers/:id/transfer', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'owner')
    const parsed = TransferLedgerSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { newOwnerUserId } = parsed.data

    if (newOwnerUserId === ledger.ownerUserId) {
      throw errors.conflict(
        'transfer_target_is_owner',
        'New owner must differ from the current owner.',
      )
    }
    const target = await c.var.repos.ledgerMembers.findByLedgerAndUser(
      ledger.id,
      newOwnerUserId,
    )
    if (!target) {
      throw errors.conflict(
        'transfer_target_not_member',
        'New owner must be an existing member of this ledger.',
      )
    }

    // Demote the previous owner into a member row, hand the role over,
    // and stamp the ledger's owner_user_id. Done sequentially — a
    // transactional helper can be hoisted into the repo later if needed.
    const oldOwnerUserId = ledger.ownerUserId
    await c.var.repos.ledgerMembers.remove(ledger.id, newOwnerUserId)
    await c.var.repos.ledgers.transferOwnership({
      ledgerId: ledger.id,
      newOwnerUserId,
    })
    await c.var.repos.ledgerMembers.add({
      id: `lmm_${ulid()}`,
      ledgerId: ledger.id,
      userId: oldOwnerUserId,
      role: 'member',
    })
    await recordActivity(c, ledger.id, 'ledger.ownership_transferred', {
      from_user_id: oldOwnerUserId,
      to_user_id: newOwnerUserId,
    })
    publish(
      c,
      ledgerChannel(ledger.id),
      envelope('ledgers', 'update', ledger.id, c.var.session!.userId),
    )
    return c.json({
      ledger_id: ledger.id,
      owner_user_id: newOwnerUserId,
    })
  })

  // --- members listing (members + owner) -----------------------------
  .get('/api/v1/ui/ledgers/:id/members', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'member')
    const rows = await c.var.repos.ledgerMembers.listForLedger(ledger.id)
    return c.json({ items: rows.map(serializeMember) })
  })

  // --- leave (any member, never the owner) ---------------------------
  .delete('/api/v1/ui/ledgers/:id/members/me', async (c) => {
    const { ledger, role } = await loadLedgerForAction(c, c.req.param('id'), 'member')
    if (role === 'owner') {
      throw errors.conflict(
        'owner_cannot_leave',
        'The ledger owner cannot leave — transfer ownership first or delete the ledger.',
      )
    }
    const userId = c.var.session!.userId
    await c.var.repos.ledgerMembers.remove(ledger.id, userId)
    await recordActivity(c, ledger.id, 'ledger.member.left', {})
    publish(
      c,
      ledgerChannel(ledger.id),
      envelope('ledger_members', 'delete', userId, userId),
    )
    return c.body(null, 204)
  })

  // --- kick a member (owner only) ------------------------------------
  .delete('/api/v1/ui/ledgers/:id/members/:userId', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'owner')
    const targetUserId = c.req.param('userId')
    if (targetUserId === ledger.ownerUserId) {
      throw errors.conflict(
        'cannot_remove_owner',
        'The ledger owner cannot be removed — transfer ownership first.',
      )
    }
    const removed = await c.var.repos.ledgerMembers.remove(ledger.id, targetUserId)
    if (!removed) throw errors.notFound('Member not found.')
    await recordActivity(c, ledger.id, 'ledger.member.removed', {
      user_id: targetUserId,
    })
    publish(
      c,
      ledgerChannel(ledger.id),
      envelope('ledger_members', 'delete', targetUserId, c.var.session!.userId),
    )
    return c.body(null, 204)
  })

  // --- activity feed (owner only) ------------------------------------
  .get('/api/v1/ui/ledgers/:id/activity', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'owner')
    const rows = await c.var.repos.ledgerActivity.listForLedger(ledger.id, {
      limit: 200,
    })
    return c.json({
      items: rows.map((r) => ({
        id: r.id,
        actor_user_id: r.actorUserId,
        event_type: r.eventType,
        meta: r.meta,
        created_at: r.createdAt.toISOString(),
      })),
    })
  })
