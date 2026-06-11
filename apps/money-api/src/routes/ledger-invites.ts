import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  CreateLedgerInviteSchema,
  JoinLedgerSchema,
  MONEY_INVITE_CODE_PREFIX,
} from '@rallypoint/money-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { LedgerInviteRecord } from '../repos/types.js'
import { UniqueConstraintError } from '../repos/errors.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { readJsonBody } from './_body.js'
import { envelope, ledgerChannel } from '../realtime/channels.js'
import { publish } from '../realtime/publish.js'
import { loadLedgerForAction, recordActivity } from './_access.js'

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000 // 14 days

function serializeInvite(i: LedgerInviteRecord): Record<string, unknown> {
  return {
    id: i.id,
    ledger_id: i.ledgerId,
    invited_by_user_id: i.invitedByUserId,
    invited_email: i.invitedEmail,
    role: i.role,
    created_at: i.createdAt.toISOString(),
    expires_at: i.expiresAt.toISOString(),
    consumed_at: i.consumedAt?.toISOString() ?? null,
    consumed_by_user_id: i.consumedByUserId,
  }
}

export const ledgerInvitesRoutes = new Hono<HonoApp>()
  // --- mint an invite (owner only) -----------------------------------
  .post('/api/v1/ui/ledgers/:id/invites', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'owner')
    const parsed = CreateLedgerInviteSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { invitedEmail, role } = parsed.data

    const rawCode = generateRawToken(MONEY_INVITE_CODE_PREFIX)
    const invite = await c.var.repos.ledgerInvites.create({
      id: `lin_${ulid()}`,
      ledgerId: ledger.id,
      codeHash: hashToken(rawCode),
      invitedByUserId: c.var.session!.userId,
      invitedEmail: invitedEmail ?? null,
      role: role ?? 'member',
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    })
    await recordActivity(c, ledger.id, 'ledger.invite.created', {
      invite_id: invite.id,
      invited_email: invite.invitedEmail,
      role: invite.role,
    })
    publish(
      c,
      ledgerChannel(ledger.id),
      envelope('ledger_invites', 'create', invite.id, c.var.session!.userId),
    )
    // The raw code leaves the API exactly once, here.
    return c.json({ ...serializeInvite(invite), code: rawCode }, 201)
  })

  // --- list active invites (owner only) ------------------------------
  .get('/api/v1/ui/ledgers/:id/invites', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'owner')
    const rows = await c.var.repos.ledgerInvites.listActiveForLedger(ledger.id)
    return c.json({ items: rows.map(serializeInvite) })
  })

  // --- accept an invite (any signed-in user) -------------------------
  // Lives outside the ledger-scoped tree because the acceptor doesn't
  // know the ledger id yet — only the raw code.
  .post('/api/v1/ui/ledgers/join', async (c) => {
    const userId = c.var.session!.userId
    const parsed = JoinLedgerSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const codeHash = hashToken(parsed.data.code)

    const invite = await c.var.repos.ledgerInvites.findByCodeHash(codeHash)
    if (!invite) throw errors.inviteCodeInvalid()
    if (invite.consumedAt) throw errors.inviteAlreadyConsumed()
    if (invite.expiresAt.getTime() < Date.now()) throw errors.inviteExpired()

    const ledger = await c.var.repos.ledgers.findById(invite.ledgerId)
    if (!ledger || ledger.deletedAt) throw errors.inviteCodeInvalid()

    // Block accepting your own ledger's invite, and joining twice.
    if (ledger.ownerUserId === userId) {
      throw errors.conflict(
        'already_owner',
        'You already own this ledger.',
      )
    }
    const existing = await c.var.repos.ledgerMembers.findByLedgerAndUser(
      ledger.id,
      userId,
    )
    if (existing) {
      // Idempotent: the invite is still consumed (so we don't leak a
      // perpetually-redeemable code) and we return the ledger handle.
      await c.var.repos.ledgerInvites.markConsumed(invite.id, userId, new Date())
      return c.json({ ledger_id: ledger.id, role: existing.role, already_member: true })
    }

    try {
      await c.var.repos.ledgerMembers.add({
        id: `lmm_${ulid()}`,
        ledgerId: ledger.id,
        userId,
        role: invite.role,
      })
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        // Race: someone else added them between findByLedgerAndUser and add.
        await c.var.repos.ledgerInvites.markConsumed(invite.id, userId, new Date())
        return c.json({ ledger_id: ledger.id, role: invite.role, already_member: true })
      }
      throw err
    }
    await c.var.repos.ledgerInvites.markConsumed(invite.id, userId, new Date())
    await recordActivity(c, ledger.id, 'ledger.member.joined', {
      invite_id: invite.id,
      role: invite.role,
    })
    publish(
      c,
      ledgerChannel(ledger.id),
      envelope('ledger_members', 'create', userId, userId),
    )
    return c.json({ ledger_id: ledger.id, role: invite.role, already_member: false })
  })
