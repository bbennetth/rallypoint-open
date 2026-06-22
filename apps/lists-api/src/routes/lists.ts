import { Hono } from 'hono'
import { z } from 'zod'
import { ulid } from 'ulid'
import { CreateListSchema, scopeTypeField, scopeIdField, SYSTEM_MANAGED_LIST_TYPES, type SystemManagedListType } from '@rallypoint/lists-shared'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import type { ListInviteRecord, ListRecord, ListShareRecord } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { envelope, scopeChannel } from '../realtime/channels.js'
import { publish } from '../realtime/publish.js'
import {
  assertScopeMutable,
  assertScopeReadable,
  canRead,
  loadListForRead,
  loadListForWrite,
} from './_list-access.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'

// The group/group `scope_id` carries no tenant of its own in V1, so all
// rows share the platform default tenant. Slice 2+ may thread a real
// tenant through once multi-tenant Lists deployments exist.
const TENANT = 'rallypoint'

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000 // 14 days
const INVITE_PREFIX = 'rpl_' // rallypoint lists (peer of `rpe_` events / `rpj_` groups)

const CreateInviteSchema = z.object({
  invitedEmail: z.string().trim().email().max(320),
})
const AcceptInviteSchema = z.object({
  code: z.string().trim().min(1).max(128),
})

function serializeShare(s: ListShareRecord): Record<string, unknown> {
  return {
    id: s.id,
    list_id: s.listId,
    user_id: s.userId,
    added_by_user_id: s.addedByUserId,
    created_at: s.createdAt.toISOString(),
  }
}

function serializeInvite(i: ListInviteRecord): Record<string, unknown> {
  return {
    id: i.id,
    list_id: i.listId,
    invited_email: i.invitedEmail,
    invited_by_user_id: i.invitedByUserId,
    created_at: i.createdAt.toISOString(),
    expires_at: i.expiresAt.toISOString(),
    consumed_at: i.consumedAt ? i.consumedAt.toISOString() : null,
  }
}

function serializeList(l: ListRecord): Record<string, unknown> {
  return {
    id: l.id,
    scope_type: l.scopeType,
    scope_id: l.scopeId,
    list_type: l.listType,
    name: l.name,
    visibility: l.visibility,
    color: l.color,
    created_by: l.createdBy,
    created_at: l.createdAt.toISOString(),
    updated_at: l.updatedAt.toISOString(),
  }
}

export const listsRoutes = new Hono<HonoApp>()
  // --- create ------------------------------------------------------
  // #128: writes are gated by the same scope-ownership + membership
  // rule as reads. Cross-app scopes (e.g. events `group`) are denied
  // at the UI boundary; lists-local `list_group` scopes require an
  // active member row.
  .post('/api/v1/ui/lists', async (c) => {
    const userId = c.var.session!.userId
    const parsed = CreateListSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data
    await assertScopeReadable(c, body.scopeType, body.scopeId)
    await assertScopeMutable(c, body.scopeId)

    const list = await c.var.repos.lists.create({
      id: `lst_${ulid()}`,
      tenantId: TENANT,
      scopeType: body.scopeType,
      scopeId: body.scopeId,
      listType: body.listType,
      name: body.name,
      visibility: body.visibility,
      color: body.color ?? null,
      createdBy: userId,
    })
    // Scope overview is "every scope member sees a notification" —
    // private lists must not leak their existence to non-shared scope
    // members, so we skip the scope-channel publish for them. Shares
    // get notified via their per-list channel on the (future) ops
    // they receive after accepting. The list_groups channel still
    // notifies the creator's own subscribers (they subscribe to the
    // list channel directly on accept).
    if (list.visibility !== 'private') {
      publish(c, scopeChannel(list.scopeType, list.scopeId), envelope('lists', 'create', list.id, userId))
    }
    return c.json(serializeList(list), 201)
  })

  // --- soft-delete a list (creator only) ----------------------------
  // Uses the same `loadListForWrite` guard as structural mutations:
  // creator-only, not-already-deleted, 404 anti-fingerprint. Publishes
  // to the scope channel so the My Lists overview drops the row.
  //
  // System-managed list types (shopping, notes) are provisioned
  // automatically by the Planner BFF and must never be deleted by any
  // client. Rejecting here blocks deletion from every surface — RPP,
  // RPL, or any future caller — without placing the guard in each BFF.
  .delete('/api/v1/ui/lists/:listId', async (c) => {
    const userId = c.var.session!.userId
    const list = await loadListForWrite(c, c.req.param('listId'))
    if (SYSTEM_MANAGED_LIST_TYPES.has(list.listType as SystemManagedListType)) {
      throw errors.conflict(
        'system_managed_list',
        'System-managed lists cannot be deleted.',
      )
    }
    await c.var.repos.lists.softDelete(list.id, new Date())
    publish(c, scopeChannel(list.scopeType, list.scopeId), envelope('lists', 'delete', list.id, userId))
    return c.body(null, 204)
  })

  // --- shared with me ------------------------------------------------
  // Registered BEFORE /lists/:listId so "shared-with-me" isn't
  // captured as a listId path param. Lists every private list the
  // caller has been added to via the share-by-email flow. Mirror of
  // MyListsPage's scope-listing for the out-of-scope discovery case:
  // a share-recipient who isn't in the list_group has no other way
  // to rediscover the list. Soft-deleted lists drop out; the caller's
  // own creations don't appear here (they already surface in their
  // scope view).
  .get('/api/v1/ui/lists/shared-with-me', async (c) => {
    const userId = c.var.session!.userId
    const shares = await c.var.repos.listShares.listForUser(userId)
    const items: ReturnType<typeof serializeList>[] = []
    for (const share of shares) {
      const list = await c.var.repos.lists.findById(share.listId)
      if (!list || list.deletedAt) continue
      if (list.createdBy === userId) continue
      items.push(serializeList(list))
    }
    return c.json({ items })
  })

  // --- get one (by id) ---------------------------------------------
  // Read-authz: scope-owned-by-Lists + scope membership + visibility.
  // Any failure mode 404s; existence is never leaked.
  .get('/api/v1/ui/lists/:listId', async (c) => {
    const list = await loadListForRead(c, c.req.param('listId'))
    return c.json(serializeList(list))
  })

  // --- list (by scope) ---------------------------------------------
  // Two-stage filter: cheap upfront scope-ownership + membership gate
  // (assertScopeReadable), then per-row visibility check (canRead) so
  // 'private' lists you weren't shared on drop out of the listing.
  .get('/api/v1/ui/lists', async (c) => {
    const scopeType = scopeTypeField.safeParse(c.req.query('scope_type'))
    const scopeId = scopeIdField.safeParse(c.req.query('scope_id'))
    if (!scopeType.success || !scopeId.success) {
      throw errors.validation({
        issues: [
          ...(scopeType.success ? [] : scopeType.error.issues),
          ...(scopeId.success ? [] : scopeId.error.issues),
        ],
      })
    }
    await assertScopeReadable(c, scopeType.data, scopeId.data)
    const rows = await c.var.repos.lists.listForScope({
      tenantId: TENANT,
      scopeType: scopeType.data,
      scopeId: scopeId.data,
    })
    const visible: ListRecord[] = []
    for (const row of rows) {
      if (await canRead(c, row)) visible.push(row)
    }
    return c.json({ items: visible.map(serializeList) })
  })

  // --- share-by-email invites (#128) ---------------------------------
  // Only the list creator may mint or revoke share invites today. The
  // raw code leaves exactly once in the create response (events-api
  // convention). The UI hands delivery off to the user's email client
  // via a copy-link + mailto: fallback — lists-api has no SMTP path.
  .post('/api/v1/ui/lists/:listId/invites', async (c) => {
    const list = await loadListForRead(c, c.req.param('listId'))
    await assertScopeMutable(c, list.scopeId)
    if (list.createdBy !== c.var.session!.userId) {
      // Mask non-creator share-invite attempts as 404 so existence isn't
      // confirmed beyond what loadListForRead already exposes.
      throw errors.listNotFound()
    }
    // Shares are only meaningful for `visibility='private'`. An 'all'
    // list already grants read access to every scope member; minting
    // a share for it would create an unreachable list_shares row
    // that canRead doesn't honor. 409 so the UI can offer to flip
    // visibility first instead.
    if (list.visibility !== 'private') {
      throw errors.conflict(
        'visibility_not_shareable',
        'Only private lists can be shared by email. Switch visibility to private first.',
      )
    }
    const parsed = CreateInviteSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const rawCode = generateRawToken(INVITE_PREFIX)
    const invite = await c.var.repos.listInvites.create({
      id: `lin_${ulid()}`,
      listId: list.id,
      codeHash: hashToken(rawCode),
      invitedByUserId: c.var.session!.userId,
      invitedEmail: parsed.data.invitedEmail.toLowerCase(),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    })
    return c.json({ ...serializeInvite(invite), code: rawCode }, 201)
  })

  // --- list pending invites (creator only) ---------------------------
  .get('/api/v1/ui/lists/:listId/invites', async (c) => {
    const list = await loadListForRead(c, c.req.param('listId'))
    if (list.createdBy !== c.var.session!.userId) throw errors.listNotFound()
    const rows = await c.var.repos.listInvites.listForList(list.id)
    const now = Date.now()
    return c.json({
      items: rows
        .filter((r) => r.consumedAt === null && r.expiresAt.getTime() > now)
        .map(serializeInvite),
    })
  })

  // --- revoke pending invite (creator only) --------------------------
  .delete('/api/v1/ui/lists/:listId/invites/:inviteId', async (c) => {
    const list = await loadListForRead(c, c.req.param('listId'))
    if (list.createdBy !== c.var.session!.userId) throw errors.listNotFound()
    const inviteId = c.req.param('inviteId')
    const invite = await c.var.repos.listInvites.findById(inviteId)
    if (!invite || invite.listId !== list.id) {
      throw new ApiError({ code: 'invite_not_found', message: 'Invite not found.', status: 404 })
    }
    if (invite.consumedAt) {
      throw errors.conflict('invite_already_consumed', 'Invite has already been used.')
    }
    const removed = await c.var.repos.listInvites.deletePending(inviteId)
    if (!removed) {
      throw new ApiError({ code: 'invite_not_found', message: 'Invite not found.', status: 404 })
    }
    return c.body(null, 204)
  })

  // --- accept invite (any authed user) -------------------------------
  // Resolves the code, runs liveness checks, then atomically inserts
  // the list_shares row + consumes the invite via ListRepo.acceptInvite
  // (mirrors events-api EventRepo.acceptInvite). Concurrent double-
  // accept hits the (list_id, user_id) unique index → 409 already_shared.
  .post('/api/v1/ui/lists/invites/accept', async (c) => {
    const userId = c.var.session!.userId
    const parsed = AcceptInviteSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    const invite = await c.var.repos.listInvites.findByCodeHash(hashToken(parsed.data.code))
    if (!invite) {
      throw new ApiError({ code: 'invite_invalid', message: 'Invite is invalid.', status: 404 })
    }
    if (invite.consumedAt) {
      throw errors.conflict('invite_already_consumed', 'Invite has already been used.')
    }
    if (invite.expiresAt.getTime() < Date.now()) {
      throw new ApiError({ code: 'invite_expired', message: 'Invite has expired.', status: 400 })
    }
    const list = await c.var.repos.lists.findById(invite.listId)
    if (!list || list.deletedAt) {
      throw new ApiError({ code: 'invite_invalid', message: 'Invite is invalid.', status: 404 })
    }
    if (list.createdBy === userId) {
      throw errors.conflict('already_owner', 'You already own this list.')
    }
    // Round-3 fix: also check parent list_group liveness + that the
    // list's visibility still makes sharing meaningful. A list whose
    // group was soft-deleted, or whose visibility was flipped to 'all'
    // since the invite was minted, must not produce a hidden share row.
    if (list.visibility !== 'private') {
      throw new ApiError({ code: 'invite_invalid', message: 'Invite is invalid.', status: 404 })
    }
    const parentGroup = await c.var.repos.groups.findById(list.scopeId)
    if (!parentGroup || parentGroup.deletedAt) {
      throw new ApiError({ code: 'invite_invalid', message: 'Invite is invalid.', status: 404 })
    }

    const result = await c.var.repos.lists.acceptInvite({
      shareId: `lsh_${ulid()}`,
      inviteId: invite.id,
      listId: list.id,
      userId,
      // The audit trail records who CREATED the share, not who
      // consumed the invite — the list creator's mint of the invite
      // is the act of granting access.
      addedByUserId: invite.invitedByUserId,
    })
    if (!result.ok) {
      // Consume-first ordering: the loser of a concurrent-accept race
      // sees `invite_already_consumed` (the winner's UPDATE took the
      // invite row). `already_shared` only fires for idempotent
      // re-acceptance by the same user.
      if (result.reason === 'invite_already_consumed') {
        throw errors.conflict('invite_already_consumed', 'Invite has already been used.')
      }
      throw errors.conflict('already_shared', 'You already have access to this list.')
    }
    return c.json({ list_id: list.id })
  })

  // --- list current shares (creator only) ----------------------------
  .get('/api/v1/ui/lists/:listId/shares', async (c) => {
    const list = await loadListForRead(c, c.req.param('listId'))
    if (list.createdBy !== c.var.session!.userId) throw errors.listNotFound()
    const rows = await c.var.repos.listShares.listForList(list.id)
    return c.json({ items: rows.map(serializeShare) })
  })

  // --- revoke a share (creator only) ---------------------------------
  .delete('/api/v1/ui/lists/:listId/shares/:userId', async (c) => {
    const list = await loadListForRead(c, c.req.param('listId'))
    if (list.createdBy !== c.var.session!.userId) throw errors.listNotFound()
    const targetUserId = c.req.param('userId')
    const removed = await c.var.repos.listShares.remove(list.id, targetUserId)
    if (!removed) {
      throw new ApiError({ code: 'share_not_found', message: 'Share not found.', status: 404 })
    }
    return c.body(null, 204)
  })
