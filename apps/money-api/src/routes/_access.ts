import { ulid } from 'ulid'
import type { Context } from 'hono'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { LedgerRecord } from '../repos/types.js'

// Shared ledger access-control + audit helpers used by every router
// that operates on a ledger (ledgers CRUD, members, invites, groups,
// and the expense/settlement surfaces in later slices). Kept in one
// place so the permission rules can't drift between surfaces.

export const TENANT = 'rallypoint'

export type LedgerActorRole = 'owner' | 'member'

// 'owner' beats 'member'. A handler with `minRole='member'` accepts
// either; a handler with `minRole='owner'` only accepts the canonical
// owner (ledgers.owner_user_id) or a co-owner member row.
export const LEDGER_ROLE_RANK: Record<LedgerActorRole, number> = {
  owner: 2,
  member: 1,
}

// Resolve the actor's role on a ledger, or null if they have no
// access at all. Owner is canonical (ledgers.owner_user_id); everyone
// else needs a ledger_members row.
export async function actorRole(
  c: Context<HonoApp>,
  ledger: LedgerRecord,
  userId: string,
): Promise<LedgerActorRole | null> {
  if (ledger.ownerUserId === userId) return 'owner'
  const member = await c.var.repos.ledgerMembers.findByLedgerAndUser(ledger.id, userId)
  if (!member) return null
  return member.role === 'owner' ? 'owner' : 'member'
}

// Load a ledger by id and enforce access. minRole gates the action.
// Deleted (soft-deleted) ledgers 404 unless allowDeleted is set.
// We 404 rather than 403 for non-members so existence doesn't leak.
export async function loadLedgerForAction(
  c: Context<HonoApp>,
  ledgerId: string,
  minRole: LedgerActorRole,
  allowDeleted = false,
): Promise<{ ledger: LedgerRecord; role: LedgerActorRole }> {
  const userId = c.var.session!.userId
  const ledger = await c.var.repos.ledgers.findById(ledgerId)
  if (!ledger) throw errors.ledgerNotFound()
  const role = await actorRole(c, ledger, userId)
  if (role === null) throw errors.ledgerNotFound()
  if (ledger.deletedAt && !allowDeleted) throw errors.ledgerNotFound()
  if (LEDGER_ROLE_RANK[role] < LEDGER_ROLE_RANK[minRole]) throw errors.forbidden()
  return { ledger, role }
}

// Assert the session user may subscribe to a scope-level realtime channel.
// 404 on any failure — never leak whether a scope_id exists.
//
// 'personal' — scopeId must be the caller's own userId (no repo lookup needed).
// 'group' / 'ledger_group' — scopeId must be an active group the caller belongs to.
export async function assertScopeReadable(
  c: Context<HonoApp>,
  scopeType: string,
  scopeId: string,
): Promise<void> {
  const userId = c.var.session!.userId
  if (scopeType === 'personal') {
    if (scopeId !== userId) throw errors.ledgerNotFound()
    return
  }
  // 'group' and 'ledger_group' are both backed by ledger_groups rows.
  const group = await c.var.repos.ledgerGroups.findById(scopeId)
  if (!group || group.deletedAt) throw errors.ledgerNotFound()
  const membership = await c.var.repos.ledgerGroups.findMembership(scopeId, userId)
  if (!membership) throw errors.ledgerNotFound()
}

// Append a row to ledger_activity for the current actor. eventType is
// a dotted string like `ledger.patched`, `ledger.member.removed`,
// `ledger.invite.created`. meta carries a no-secrets summary.
export async function recordActivity(
  c: Context<HonoApp>,
  ledgerId: string,
  eventType: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  await c.var.repos.ledgerActivity.record({
    id: `lac_${ulid()}`,
    ledgerId,
    actorUserId: c.var.session!.userId,
    eventType,
    meta,
  })
}
