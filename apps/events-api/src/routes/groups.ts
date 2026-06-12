import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  CreateGroupSchema,
  PatchGroupSchema,
  JoinGroupSchema,
  CreateGroupInviteSchema,
  SetGroupRoleSchema,
  TransferGroupSchema,
} from '@rallypoint/events-shared'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { UniqueConstraintError } from '../repos/errors.js'
import type { GroupMemberRecord, GroupRecord, GroupRole } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { loadForAction, recordActivity, requireIdPrefix } from './_access.js'
import { assertFeatureEnabled } from './_features.js'
import { applyPerUserRateLimit } from '../middleware/rate-limit.js'
import {
  SHORT_CODE_MAX_ATTEMPTS,
  generateShortCode,
  normalizeShortCode,
} from '@rallypoint/events-shared'
import { GROUP_ROLE_RANK, groupActorRole, loadGroupForAction } from './_group-access.js'

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000 // 14 days

function serializeGroup(
  group: GroupRecord,
  viewerRole: GroupRole | null,
  memberCount?: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: group.id,
    event_id: group.eventId,
    name: group.name,
    description: group.description,
    start_date: group.startDate,
    end_date: group.endDate,
    owner_user_id: group.ownerUserId,
    viewer_role: viewerRole,
    created_at: group.createdAt.toISOString(),
    updated_at: group.updatedAt.toISOString(),
  }
  if (memberCount !== undefined) out.member_count = memberCount
  return out
}

function serializeMember(m: GroupMemberRecord): Record<string, unknown> {
  return {
    id: m.id,
    user_id: m.userId,
    role: m.role,
    joined_at: m.joinedAt.toISOString(),
  }
}

export const groupsRoutes = new Hono<HonoApp>()
  // --- create (event editor+) --------------------------------------
  .post('/api/v1/ui/events/:id/groups', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'editor')
    assertFeatureEnabled(event, role, 'groups')
    const userId = c.var.session!.userId
    const parsed = CreateGroupSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    const rawCode = generateRawToken('rpj_')
    // #171: groups row + owner member row + (conditional) attendee row
    // all in one DB transaction. UniqueConstraintError still bubbles on
    // name collision; no phantom owner-member or attendee row on the
    // sad path. Phase 0 attendee rule: event owners don't carry an
    // attendees row, so `attendeeId: null` skips that write.
    //
    // #440: also mint a 6-char short code. A collision on the
    // short-code unique index retries with a fresh code (32^6 space —
    // vanishingly rare); a name collision keeps its 409.
    let group: GroupRecord | null = null
    for (let attempt = 0; attempt < SHORT_CODE_MAX_ATTEMPTS; attempt += 1) {
      try {
        group = await c.var.repos.groups.createWithOwner({
          group: {
            id: `grp_${ulid()}`,
            eventId: event.id,
            name: body.name,
            description: body.description ?? null,
            startDate: body.startDate ?? null,
            endDate: body.endDate ?? null,
            joinCodeHash: hashToken(rawCode),
            shortCode: generateShortCode(),
            ownerUserId: userId,
          },
          ownerMemberId: `grm_${ulid()}`,
          attendeeId: event.ownerUserId !== userId ? `eva_${ulid()}` : null,
        })
        break
      } catch (err) {
        // D1 reports "groups.short_code", the memory repo
        // "groups_short_code_idx" — match on the column name.
        if (err instanceof UniqueConstraintError && err.constraintName.includes('short_code')) {
          continue
        }
        if (err instanceof UniqueConstraintError) {
          throw errors.conflict('group_name_taken', 'A group with that name already exists.')
        }
        throw err
      }
    }
    if (!group) {
      // Exhausted short-code retries — fail loudly (FP's silent
      // collision reuse is the bug we're not replicating).
      throw new ApiError({
        code: 'short_code_exhausted',
        message: 'Could not allocate a join code; try again.',
        status: 503,
      })
    }
    await recordActivity(c, event.id, 'group.created', { group_id: group.id })

    // Best-effort auto-attach a Money ledger so every group has shared
    // expense tracking out of the box (design §8, slice 11). A money-api
    // outage must NOT block group creation — the lazy heal in
    // GET /api/v1/ui/groups/:id/ledger fills the gap on first read.
    let ledgerId: string | null = null
    try {
      const ledger = await c.var.services.moneyClient.ensureGroupLedger({
        groupId: group.id,
        ownerUserId: userId,
        name: `${group.name} expenses`,
      })
      ledgerId = ledger.id
      if (ledger.created) {
        await recordActivity(c, event.id, 'group.ledger_attached', {
          group_id: group.id,
          ledger_id: ledger.id,
        })
      }
    } catch (err) {
      c.var.logger.warn(
        { err, group_id: group.id },
        'auto-attach money ledger failed; will heal on first BFF read',
      )
    }
    // The raw rpj_ join code leaves the API exactly once, here. The
    // short code is re-showable (group detail, owner/sidekick).
    return c.json(
      {
        ...serializeGroup(group, 'owner', 1),
        join_code: rawCode,
        short_code: group.shortCode,
        ...(ledgerId !== null ? { ledger_id: ledgerId } : {}),
      },
      201,
    )
  })

  // --- list MY groups for an event (event viewer+) ------------------
  // Phase 0 privacy rule (platform/v-1.1 #16): event owners no longer
  // see every group in their event. This endpoint returns *only* the
  // groups the caller is a member of (i.e. "my groups in this event").
  // Owners not in any group get an empty list. groupActorRole no longer
  // short-circuits event ownership to `owner`, so the role filter and
  // the membership check below collapse to the same predicate.
  .get('/api/v1/ui/events/:id/groups', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'viewer')
    assertFeatureEnabled(event, role, 'groups')
    const userId = c.var.session!.userId
    const groups = await c.var.repos.groups.listForEvent(event.id)
    const items: ReturnType<typeof serializeGroup>[] = []
    for (const group of groups) {
      const role = await groupActorRole(c, group, userId)
      if (role === null) continue
      const count = await c.var.repos.groupMembers.countForGroup(group.id)
      items.push(serializeGroup(group, role, count))
    }
    return c.json({ items })
  })

  // --- join by code (resolver: join code first, then invite) -------
  // --- join preview (#440, FP parity) --------------------------------
  // Resolve a join code (6-char short code or rpj_ token) to a small
  // preview card payload WITHOUT joining: group name, member count,
  // whether the caller is already a member, plus the event name (RPE
  // extension — groups are event-scoped here, FP's were festival-
  // scoped). Auth'd + per-user rate limited; invalid codes 404 with
  // the same shape as the join route so codes aren't probeable
  // cheaper here than there.
  .get('/api/v1/ui/groups/join/preview', async (c) => {
    const userId = c.var.session!.userId
    await applyPerUserRateLimit(c, {
      userId,
      route: 'group-join-preview',
      limit: 30,
      windowSeconds: 300,
    })
    const raw = c.req.query('code') ?? ''
    if (!raw) throw errors.groupJoinCodeInvalid()

    const short = normalizeShortCode(raw)
    let group = short
      ? await c.var.repos.groups.findByShortCode(short)
      : await c.var.repos.groups.findByJoinCodeHash(hashToken(raw))
    if (!group && !short) {
      const invite = await c.var.repos.groupInvites.findByCodeHash(hashToken(raw))
      if (invite && !invite.consumedAt && invite.expiresAt.getTime() >= Date.now()) {
        group = await c.var.repos.groups.findById(invite.groupId)
      }
    }
    if (!group) throw errors.groupJoinCodeInvalid()

    const event = await c.var.repos.events.findById(group.eventId)
    if (!event || event.deletedAt) throw errors.groupJoinCodeInvalid()

    const member = await c.var.repos.groupMembers.findByGroupAndUser(group.id, userId)
    const memberCount = await c.var.repos.groupMembers.countForGroup(group.id)
    return c.json({
      group_id: group.id,
      name: group.name,
      member_count: memberCount,
      event_name: event.name,
      you_are_member: member !== null,
    })
  })

  .post('/api/v1/ui/groups/join', async (c) => {
    const userId = c.var.session!.userId
    // 6-char codes are brute-forceable in principle (32^6); throttle
    // join attempts per user. rpj_ tokens share the bucket — joining
    // is not a hot path.
    await applyPerUserRateLimit(c, {
      userId,
      route: 'group-join',
      limit: 20,
      windowSeconds: 300,
    })
    const parsed = JoinGroupSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    // #440: a 6-char short code (any casing/spacing) resolves via
    // groups.short_code; anything else is treated as an rpj_ token.
    const short = normalizeShortCode(parsed.data.code)
    const codeHash = hashToken(parsed.data.code)

    // §5.5 contract: an active group join code wins over a colliding
    // invite code, so check groups.join_code_hash FIRST.
    let group = short
      ? await c.var.repos.groups.findByShortCode(short)
      : await c.var.repos.groups.findByJoinCodeHash(codeHash)
    let invite = null
    if (!group && !short) {
      invite = await c.var.repos.groupInvites.findByCodeHash(codeHash)
      if (invite) group = await c.var.repos.groups.findById(invite.groupId)
    }
    if (!group) throw errors.groupJoinCodeInvalid()

    // #216: with groups toggled off, join codes behave as invalid for
    // everyone but the owner — indistinguishable from a dead code. This
    // fires BEFORE the invite liveness checks below so a consumed or
    // expired invite can't leak its state through the toggle wall.
    {
      const gateEvent = await c.var.repos.events.findById(group.eventId)
      if (!gateEvent || gateEvent.deletedAt) throw errors.groupJoinCodeInvalid()
      assertFeatureEnabled(gateEvent, gateEvent.ownerUserId === userId ? 'owner' : 'viewer', 'groups')
    }

    // Invite-path liveness checks.
    if (invite) {
      if (invite.consumedAt) {
        throw errors.conflict('group_invite_already_consumed', 'Invite has already been used.')
      }
      if (invite.expiresAt.getTime() < Date.now()) {
        throw new ApiError({
          code: 'group_invite_expired',
          message: 'Invite has expired.',
          status: 400,
        })
      }
    }

    const event = await c.var.repos.events.findById(group.eventId)
    if (!event || event.deletedAt) throw errors.groupJoinCodeInvalid()

    // #171: member insert + invite consumption + attendee upsert in one
    // batch (uncapped — the member cap was dropped in #313). Re-admission
    // detection (a member row exists but the user's event_attendees row is
    // soft-removed) lives inside the repo method; we get back
    // `readmitted: true` so the activity log distinguishes "joined" from
    // "rejoined".
    const result = await c.var.repos.groups.joinWithAttendee({
      memberId: `grm_${ulid()}`,
      groupId: group.id,
      userId,
      inviteId: invite?.id ?? null,
      attendeeId: event.ownerUserId !== userId ? `eva_${ulid()}` : null,
      eventId: event.id,
    })
    if (!result.ok) {
      throw errors.conflict('already_group_member', 'You are already a member of this group.')
    }
    await recordActivity(c, group.eventId, result.readmitted ? 'group.rejoined' : 'group.joined', {
      group_id: group.id,
    })
    return c.json({ group_id: group.id, role: 'member' })
  })

  // --- detail (group member only) ------------------------------------
  // Event owners no longer pass through here (Phase 0 privacy rule);
  // they read the flat attendees list instead. groupActorRole gates.
  .get('/api/v1/ui/groups/:id', async (c) => {
    const loaded = await loadGroupForAction(c, c.req.param('id'), 'member')
    let group = loaded.group
    const role = loaded.role
    const members = await c.var.repos.groupMembers.listForGroup(group.id)

    // #440: lazy short-code backfill for pre-#440 groups, then expose
    // the code to privileged members (owner/sidekick) so the invite UI
    // can re-show it any time. Plain members share via the invite UI
    // too, so expose to all group members — the code is group-internal
    // either way (matches FP, where every member saw the Crew invite
    // section).
    if (group.shortCode === null) {
      for (let attempt = 0; attempt < SHORT_CODE_MAX_ATTEMPTS; attempt += 1) {
        try {
          const updated = await c.var.repos.groups.setShortCode(group.id, generateShortCode())
          if (updated) group = updated
          break
        } catch (err) {
          if (err instanceof UniqueConstraintError && err.constraintName.includes('short_code')) {
            continue
          }
          throw err
        }
      }
      // Statistically unreachable, but fail loudly rather than return
      // a permanent null code (matches the create path's 503).
      if (group.shortCode === null) {
        throw new ApiError({
          code: 'short_code_exhausted',
          message: 'Could not allocate a join code; try again.',
          status: 503,
        })
      }
    }

    return c.json({
      ...serializeGroup(group, role, members.length),
      short_code: group.shortCode,
      members: members.map(serializeMember),
    })
  })

  // --- who's going via group membership (#216) ------------------------
  // Group-joined attendees may have no event_members row, so the event-
  // scoped /attendees/community route would 404 them. This variant gates
  // on group membership instead, then applies the same `attendees`
  // feature toggle on the group's event. Display names only.
  .get('/api/v1/ui/groups/:id/attendees', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'member')
    const event = await c.var.repos.events.findById(group.eventId)
    if (!event || event.deletedAt) throw errors.notFound('Not found.')
    const userId = c.var.session!.userId
    assertFeatureEnabled(event, event.ownerUserId === userId ? 'owner' : 'viewer', 'attendees')

    // First page only, capped at the endpoint max (200) — matches the
    // event-scoped community endpoint's max. Very large events show a
    // truncated roster here; the card is a social glance, not a census.
    const page = await c.var.repos.attendees.listForEvent(event.id, {
      limit: 200,
      cursor: null,
    })
    const userIds = Array.from(new Set(page.items.map((a) => a.userId)))
    const lookup = await c.var.services.idClient.batchLookupUsers(userIds)
    const nameById = new Map(lookup.map((u) => [u.userId, u.displayName ?? null]))
    return c.json({
      items: page.items.map((a) => ({
        user_id: a.userId,
        display_name: nameById.get(a.userId) ?? null,
        joined_at: a.joinedAt.toISOString(),
      })),
    })
  })

  // --- group lists (BFF proxy to lists-api, group member only) --------
  // events-api owns the membership check (lists-api has no group table);
  // loadGroupForAction gates, then the lists-client presents EVENTS_API_KEY
  // to lists-api's /sdk/lists. Read-only — see #84.
  .get('/api/v1/ui/groups/:id/lists', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'member')
    const items = await c.var.services.listsClient.listLists({
      scopeType: 'group',
      scopeId: group.id,
    })
    return c.json({ items })
  })

  // --- group list items (BFF proxy, group member only) ----------------
  // Confused-deputy guard: lists-api trusts the EVENTS_API_KEY holder for
  // any listId, so events-api MUST confirm the requested list belongs to
  // this group's scope before proxying. A listId from another group (or one
  // that doesn't exist) 404s here and never reaches lists-api's items
  // endpoint. Read-only — part of #84.
  .get('/api/v1/ui/groups/:id/lists/:listId/items', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'member')
    const listId = c.req.param('listId')
    const lists = await c.var.services.listsClient.listLists({
      scopeType: 'group',
      scopeId: group.id,
    })
    if (!lists.some((l) => l.id === listId)) throw errors.notFound('List not found.')
    const items = await c.var.services.listsClient.listItems(listId)
    return c.json({ items })
  })

  // --- group ledger expenses (BFF proxy to money-api, group member+) ---
  // Read-only feed of expenses for the group's default ledger. The
  // events-web inline ledger window calls this to render the recent-
  // expenses list. The ledger lookup is done server-side, so the
  // client never names a ledger_id directly (no confused-deputy risk).
  .get('/api/v1/ui/groups/:id/ledger/expenses', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'member')
    try {
      const ledgers = await c.var.services.moneyClient.listLedgers({
        scopeType: 'group',
        scopeId: group.id,
      })
      if (ledgers.length === 0) return c.json({ items: [] })
      const items = await c.var.services.moneyClient.listExpenses(ledgers[0]!.id)
      return c.json({ items })
    } catch (err) {
      c.var.logger.warn(
        { err, group_id: group.id },
        'fetch group ledger expenses via money-client failed',
      )
      throw new ApiError({
        code: 'money_upstream_unavailable',
        message: 'Money service is unavailable. Please retry shortly.',
        status: 502,
      })
    }
  })

  // --- group ledger balances (BFF proxy to money-api, group member+) ---
  // Projects the viewer's per-other-member net balance for the group
  // ledger. viewer_user_id is supplied server-side from the session,
  // not the client, so a member can't peek at another member's balances.
  .get('/api/v1/ui/groups/:id/ledger/balances', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'member')
    const viewerUserId = c.var.session!.userId
    try {
      const ledgers = await c.var.services.moneyClient.listLedgers({
        scopeType: 'group',
        scopeId: group.id,
      })
      if (ledgers.length === 0) {
        return c.json({
          ledger_id: null,
          currency: null,
          viewer_user_id: viewerUserId,
          items: [],
        })
      }
      const balance = await c.var.services.moneyClient.getBalances(
        ledgers[0]!.id,
        viewerUserId,
      )
      return c.json({
        ledger_id: balance.ledgerId,
        currency: balance.currency,
        viewer_user_id: balance.viewerUserId,
        items: balance.items.map((i) => ({
          user_id: i.userId,
          net_cents: i.netCents,
        })),
      })
    } catch (err) {
      c.var.logger.warn(
        { err, group_id: group.id },
        'fetch group ledger balances via money-client failed',
      )
      throw new ApiError({
        code: 'money_upstream_unavailable',
        message: 'Money service is unavailable. Please retry shortly.',
        status: 502,
      })
    }
  })

  // --- group ledger (BFF proxy to money-api, group member+) ------------
  // Returns the default money ledger for this group. Lazy-heal: if no
  // ledger exists (the auto-attach on creation either failed or the
  // group predates Money), this route asks money-api to ensure one,
  // so a single GET converges. money-api outage returns 502 — the
  // events-web UI is expected to render an inline error and keep
  // working for the non-ledger parts (design §8).
  .get('/api/v1/ui/groups/:id/ledger', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'member')
    try {
      const existing = await c.var.services.moneyClient.listLedgers({
        scopeType: 'group',
        scopeId: group.id,
      })
      if (existing.length > 0) return c.json(existing[0])
      const created = await c.var.services.moneyClient.ensureGroupLedger({
        groupId: group.id,
        ownerUserId: group.ownerUserId,
        name: `${group.name} expenses`,
      })
      return c.json(created)
    } catch (err) {
      c.var.logger.warn(
        { err, group_id: group.id },
        'fetch group ledger via money-client failed',
      )
      throw new ApiError({
        code: 'money_upstream_unavailable',
        message: 'Money service is unavailable. Please retry shortly.',
        status: 502,
      })
    }
  })

  // --- patch (group sidekick+) --------------------------------------
  .patch('/api/v1/ui/groups/:id', async (c) => {
    const { group, role } = await loadGroupForAction(c, c.req.param('id'), 'sidekick')
    const parsed = PatchGroupSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const fields = parsed.data

    let updated: GroupRecord | null
    try {
      updated = await c.var.repos.groups.patch(group.id, fields)
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw errors.conflict('group_name_taken', 'A group with that name already exists.')
      }
      throw err
    }
    if (!updated) throw errors.groupNotFound()
    await recordActivity(c, group.eventId, 'group.patched', { fields: Object.keys(fields) })
    return c.json(serializeGroup(updated, role))
  })

  // --- delete (group owner) -----------------------------------------
  .delete('/api/v1/ui/groups/:id', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'owner')
    await c.var.repos.groups.delete(group.id)
    await recordActivity(c, group.eventId, 'group.deleted', { group_id: group.id })
    return c.body(null, 204)
  })

  // --- create invite (group sidekick+) ------------------------------
  .post('/api/v1/ui/groups/:id/invites', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'sidekick')
    const parsed = CreateGroupInviteSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { invitedEmail } = parsed.data

    const rawCode = generateRawToken('rpj_')
    const invite = await c.var.repos.groupInvites.create({
      id: `gri_${ulid()}`,
      groupId: group.id,
      codeHash: hashToken(rawCode),
      invitedByUserId: c.var.session!.userId,
      invitedEmail: invitedEmail ?? null,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    })
    await recordActivity(c, group.eventId, 'group.invite_created', { invite_id: invite.id })
    // The raw code leaves the API exactly once, here.
    return c.json(
      {
        id: invite.id,
        code: rawCode,
        invited_email: invite.invitedEmail,
        expires_at: invite.expiresAt.toISOString(),
      },
      201,
    )
  })

  // --- transfer ownership (group owner) -----------------------------
  .post('/api/v1/ui/groups/:id/transfer', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'owner')
    const parsed = TransferGroupSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { newOwnerUserId } = parsed.data

    if (newOwnerUserId === group.ownerUserId) {
      throw new ApiError({
        code: 'transfer_target_is_owner',
        message: 'New owner must differ from the current owner.',
        status: 400,
      })
    }
    // Use groupActorRole so a soft-removed event attendee with a
    // lingering group_members row is rejected — handing group
    // ownership to an event-revoked member would let them back in
    // through the group-owner channel.
    const targetRole = await groupActorRole(c, group, newOwnerUserId)
    if (targetRole === null) {
      throw new ApiError({
        code: 'transfer_target_not_member',
        message: 'New owner must be an existing member of this group.',
        status: 409,
      })
    }

    await c.var.repos.groups.transferOwnership({
      groupId: group.id,
      newOwnerUserId,
      oldOwnerUserId: group.ownerUserId,
    })
    await recordActivity(c, group.eventId, 'group.ownership_transferred', {
      new_owner_user_id: newOwnerUserId,
    })
    const fresh = await c.var.repos.groups.findById(group.id)
    if (!fresh) throw errors.groupNotFound()
    const role = await groupActorRole(c, fresh, c.var.session!.userId)
    return c.json(serializeGroup(fresh, role ?? 'sidekick'))
  })

  // --- set member role (group owner) --------------------------------
  .post('/api/v1/ui/groups/:id/members/:userId/role', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'owner')
    const targetUserId = requireIdPrefix(c.req.param('userId'), 'user_')
    const parsed = SetGroupRoleSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { role } = parsed.data

    if (targetUserId === c.var.session!.userId) {
      throw errors.conflict('cannot_change_own_role', 'You cannot change your own role.')
    }
    if (targetUserId === group.ownerUserId) {
      throw errors.conflict('cannot_change_owner_role', "Transfer ownership to change the owner's role.")
    }
    const target = await c.var.repos.groupMembers.findByGroupAndUser(group.id, targetUserId)
    if (!target) {
      throw new ApiError({ code: 'group_member_not_found', message: 'Member not found.', status: 404 })
    }
    await c.var.repos.groupMembers.updateRole(group.id, targetUserId, role)
    await recordActivity(c, group.eventId, 'group.role_changed', {
      user_id: targetUserId,
      role,
    })
    return c.json({ user_id: targetUserId, role })
  })

  // --- remove member / leave group ----------------------------------
  .delete('/api/v1/ui/groups/:id/members/:userId', async (c) => {
    const userId = c.var.session!.userId
    const targetUserId = requireIdPrefix(c.req.param('userId'), 'user_')
    const groupId = requireIdPrefix(c.req.param('id'), 'grp_')
    const group = await c.var.repos.groups.findById(groupId)
    if (!group) throw errors.groupNotFound()
    const role = await groupActorRole(c, group, userId)
    if (role === null) throw errors.groupNotFound() // don't leak existence

    const isSelf = targetUserId === userId
    // Non-self removal requires group ownership.
    if (!isSelf && GROUP_ROLE_RANK[role] < GROUP_ROLE_RANK.owner) throw errors.forbidden()
    // The owner can neither be removed nor leave without transferring first.
    if (targetUserId === group.ownerUserId) {
      throw errors.conflict('group_owner_must_transfer', 'Transfer ownership before leaving the group.')
    }
    const target = await c.var.repos.groupMembers.findByGroupAndUser(group.id, targetUserId)
    if (!target) {
      throw new ApiError({ code: 'group_member_not_found', message: 'Member not found.', status: 404 })
    }
    await c.var.repos.groupMembers.remove(group.id, targetUserId)
    // Drop the departed member's RSVPs so they stop inflating each
    // rally's rsvp_summary (they're no longer in the group).
    await c.var.repos.rallyAttendees.deleteForUserInGroup(group.id, targetUserId)
    await recordActivity(c, group.eventId, isSelf ? 'group.member_left' : 'group.member_removed', {
      user_id: targetUserId,
    })
    return c.body(null, 204)
  })
