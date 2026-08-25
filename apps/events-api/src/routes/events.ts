import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  CreateEventSchema,
  PatchEventSchema,
  isEventScopedObjectKey,
  mergeEventFeatures,
  resolveEventFeatures,
  CreateInviteSchema,
  AcceptInviteSchema,
  TransferOwnershipSchema,
} from '@rallypoint/events-shared'
import { paginationQuery, UniqueConstraintError } from '@rallypoint/api-kit'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { eventsCursorCodec } from '../lib/events-cursor.js'
import { createEventWithSlugRetry } from '../lib/create-event.js'
import type { EventRecord, MemberRole, PatchEventInput } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import {
  TENANT,
  actorRole,
  isEventsAdmin,
  isSystemEvent,
  loadForAction,
  recordActivity,
  viewerAttending,
} from './_access.js'
import { publish } from '../realtime/publish.js'
import { eventChannel, envelope } from '../realtime/channels.js'

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000 // 14 days
const RESTORE_GRACE_MS = 30 * 24 * 60 * 60 * 1000 // 30-day soft-delete window
// clamp (not reject) preserves the pre-unification behavior: the old route
// clamped `limit` into [1,100] and fell back to the default on a non-numeric
// value rather than 400ing a read. (An undecodable cursor is still a 400 —
// that guard is below.)
const eventsPageQuery = paginationQuery({ defaultLimit: 20, maxLimit: 100, mode: 'clamp' })

function num(s: string | null): number | null {
  return s === null ? null : Number(s)
}

// viewer_role is null on the browse surfaces (routes/browse.ts reuses
// this serializer for strangers); every route in THIS file resolves a
// concrete role before serializing.
export function serializeEvent(
  e: EventRecord,
  viewerRole: MemberRole | null,
): Record<string, unknown> {
  return {
    id: e.id,
    slug: e.slug,
    name: e.name,
    description: e.description,
    start_date: e.startDate,
    end_date: e.endDate,
    timezone: e.timezone,
    location_label: e.locationLabel,
    location_lat: num(e.locationLat),
    location_lng: num(e.locationLng),
    privacy_mode: e.privacyMode,
    public_page_config: e.publicPageConfig ?? null,
    features: resolveEventFeatures(e.features),
    owner_user_id: e.ownerUserId,
    scope_type: e.scopeType,
    viewer_role: viewerRole,
    created_at: e.createdAt.toISOString(),
    updated_at: e.updatedAt.toISOString(),
    deleted_at: e.deletedAt ? e.deletedAt.toISOString() : null,
  }
}

export const eventsRoutes = new Hono<HonoApp>()
  // --- create ------------------------------------------------------
  .post('/api/v1/ui/events', async (c) => {
    const userId = c.var.session!.userId
    const parsed = CreateEventSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    // #16 follow-up: auto-slug + collision-retry live in
    // lib/create-event.ts (shared with the admin RPC core). Exhausted
    // retries surface as 409 so the client can prompt a retry.
    let event: EventRecord
    try {
      event = await createEventWithSlugRetry(c.var.repos, {
        tenantId: TENANT,
        ownerUserId: userId,
        name: body.name,
        description: body.description ?? null,
        startDate: body.startDate ?? null,
        endDate: body.endDate ?? null,
        timezone: body.timezone,
        locationLabel: body.locationLabel ?? null,
        locationLat: body.locationLat ?? null,
        locationLng: body.locationLng ?? null,
        privacyMode: body.privacyMode ?? 'unlisted',
      })
    } catch (err) {
      throw err instanceof UniqueConstraintError ? errors.eventSlugTaken() : err
    }
    await recordActivity(c, event.id, 'event.created', { slug: event.slug })
    return c.json(serializeEvent(event, 'owner'), 201)
  })

  // --- list (mine) -------------------------------------------------
  .get('/api/v1/ui/events', async (c) => {
    const userId = c.var.session!.userId
    const includeDeleted = c.req.query('include') === 'deleted'
    const parsed = eventsPageQuery.safeParse({
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
    })
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { limit, cursor } = parsed.data
    // Reject an undecodable cursor (tampered / from another endpoint) rather
    // than silently restarting at page 1 — the latter makes infinite-scroll
    // bugs invisible. Legacy `<iso>|<id>` cursors still decode here.
    if (cursor !== undefined && eventsCursorCodec.decode(cursor) === null) {
      throw errors.validation({
        issues: [{ code: 'custom', path: ['cursor'], message: 'Invalid cursor.' }],
      })
    }

    const page = await c.var.repos.events.listForUser(userId, {
      includeDeleted,
      limit,
      cursor: cursor ?? null,
      // Allowlisted admins resolve as 'owner' on system-owned events
      // without an event_members row, so self-attending one has to be
      // what makes it visible here (issue: joined system event missing
      // from My Events). The env/allowlist read stays at the route.
      includeAttendedSystemEvents: isEventsAdmin(c, userId),
    })
    // Phase 0 (#16): a soft-removed event_attendees row revokes
    // listing visibility too — without this filter, removed attendees
    // would keep seeing the event in their /me/events list because
    // their event_members row still exists. actorRole returns null
    // when the attendee row is removed; we drop those entries here
    // rather than coerce them to 'viewer'.
    const items: ReturnType<typeof serializeEvent>[] = []
    const visible: { e: (typeof page.items)[number]; role: MemberRole }[] = []
    for (const e of page.items) {
      const role = await actorRole(c, e, userId)
      if (role === null) continue
      visible.push({ e, role })
    }
    // #440: one batched lookup for "which of my groups belongs to each
    // event" so the client can route viewer-role events into the group
    // attendee shell. Single query, not per-event N+1.
    const groupByEvent = await c.var.repos.groups.listUserGroupIdsByEvent(
      userId,
      visible.map((v) => v.e.id),
    )
    for (const { e, role } of visible) {
      items.push({
        ...serializeEvent(e, role),
        my_group_id: groupByEvent.get(e.id) ?? null,
      })
    }
    return c.json({ items, next_cursor: page.nextCursor })
  })

  // --- detail by slug ----------------------------------------------
  .get('/api/v1/ui/events/:slug', async (c) => {
    const userId = c.var.session!.userId
    const event = await c.var.repos.events.findBySlug(TENANT, c.req.param('slug'))
    if (!event) throw errors.eventNotFound()
    const role = await actorRole(c, event, userId)
    if (role === null) throw errors.eventNotFound()
    // Deleted events are visible only to the owner (so they can
    // restore); everyone else gets a 404.
    if (event.deletedAt && role !== 'owner') throw errors.eventNotFound()
    const groupByEvent = await c.var.repos.groups.listUserGroupIdsByEvent(userId, [event.id])
    return c.json({
      ...serializeEvent(event, role),
      my_group_id: groupByEvent.get(event.id) ?? null,
      viewer_attending: await viewerAttending(c, event.id, userId),
    })
  })

  // --- patch -------------------------------------------------------
  // Slug is intentionally not patchable here — custom slugs are
  // deferred behind a future paid-tier endpoint. PatchEventSchema
  // strips it at the validator boundary; this handler is unchanged.
  .patch('/api/v1/ui/events/:id', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'editor')
    const parsed = PatchEventSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    // Theme image keys are client-supplied and later streamed by public
    // serve routes, so they must stay inside this event's R2 namespace
    // (audit 1.1). The zod schema can't check this — it has no event id
    // at parse time — so it's enforced here where the event is loaded.
    const theme = parsed.data.publicPageConfig?.theme
    for (const key of [theme?.background_image_key, theme?.icon_image_key]) {
      if (key !== undefined && !isEventScopedObjectKey(key, event.id)) {
        throw errors.validation({
          reason: `Theme image keys must start with events/${event.id}/.`,
        })
      }
    }
    // Feature toggles are owner-only (#216); the rest of the patch
    // surface stays editor-level. Merge the partial patch over the
    // stored value so the column always holds the full object.
    const { features: featuresPatch, ...rest } = parsed.data
    const fields: PatchEventInput = { ...rest }
    if (featuresPatch !== undefined) {
      if (role !== 'owner') {
        throw new ApiError({
          code: 'features_owner_only',
          message: 'Only the event owner can change feature toggles.',
          status: 403,
        })
      }
      fields.features = mergeEventFeatures(event.features, featuresPatch)
    }

    const updated = await c.var.repos.events.patch(event.id, fields)
    if (!updated) throw errors.eventNotFound()
    await recordActivity(c, event.id, 'event.patched', { fields: Object.keys(fields) })
    publish(
      c,
      eventChannel(event.id),
      envelope('events', 'update', event.id, c.var.session!.userId),
    )
    return c.json(serializeEvent(updated, role))
  })

  // --- soft-delete (owner only) ------------------------------------
  .delete('/api/v1/ui/events/:id', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'owner')
    await c.var.repos.events.softDelete(event.id, new Date())
    await recordActivity(c, event.id, 'event.soft_deleted')
    publish(c, eventChannel(event.id), envelope('events', 'delete', event.id, c.var.session!.userId))
    return c.body(null, 204)
  })

  // --- restore (owner only, within grace window) -------------------
  .post('/api/v1/ui/events/:id/restore', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'owner', true)
    if (!event.deletedAt) {
      throw errors.conflict('event_not_deleted', 'Event is not deleted.')
    }
    if (Date.now() - event.deletedAt.getTime() > RESTORE_GRACE_MS) {
      throw errors.conflict('event_purge_window_elapsed', 'Restore window has elapsed.')
    }
    await c.var.repos.events.restore(event.id)
    await recordActivity(c, event.id, 'event.restored')
    publish(c, eventChannel(event.id), envelope('events', 'update', event.id, c.var.session!.userId))
    const fresh = await c.var.repos.events.findById(event.id)
    return c.json(serializeEvent(fresh ?? event, role))
  })

  // --- transfer ownership (owner only, re-auth gated) --------------
  .post('/api/v1/ui/events/:id/transfer', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'owner')
    const parsed = TransferOwnershipSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { newOwnerUserId, currentPassword } = parsed.data

    // System-owned events are permanently owned by the sentinel — the
    // re-auth step below would try to verify a password the sentinel
    // doesn't have (admins act as owner but aren't the owner row), so
    // refuse up front with a clear 409 instead of a confusing 401.
    if (isSystemEvent(event)) {
      throw errors.conflict(
        'system_event_not_transferable',
        'System-owned events cannot change ownership.',
      )
    }

    if (newOwnerUserId === event.ownerUserId) {
      throw new ApiError({
        code: 'transfer_target_is_owner',
        message: 'New owner must differ from the current owner.',
        status: 400,
      })
    }

    // §3.5 step-up: re-verify the current owner's password via RPID.
    const reauth = await c.var.services.rpidReauth.verify(event.ownerUserId, currentPassword)
    if (!reauth.ok) throw errors.unauthorized('Password re-authentication failed.')

    // The new owner must already be an active editor collaborator.
    // Use actorRole so a soft-removed editor (attendees.removed_at NOT
    // NULL) is rejected — handing ownership to a revoked collaborator
    // would silently un-revoke them via the ownership channel.
    const targetRole = await actorRole(c, event, newOwnerUserId)
    if (targetRole !== 'editor') {
      throw new ApiError({
        code: 'transfer_target_not_editor',
        message: 'New owner must be an existing editor on this event.',
        status: 409,
      })
    }

    await c.var.repos.events.transferOwnership({
      eventId: event.id,
      newOwnerUserId,
      oldOwnerUserId: event.ownerUserId,
      oldOwnerMemberId: `evm_${ulid()}`,
    })
    await recordActivity(c, event.id, 'event.ownership_transferred', {
      new_owner_user_id: newOwnerUserId,
    })
    publish(c, eventChannel(event.id), envelope('events', 'update', event.id, c.var.session!.userId))
    const fresh = await c.var.repos.events.findById(event.id)
    // The actor is now an editor, not the owner.
    return c.json(serializeEvent(fresh ?? event, 'editor'))
  })

  // --- create invite (owner or editor) -----------------------------
  .post('/api/v1/ui/events/:id/invites', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const parsed = CreateInviteSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { role, invitedEmail } = parsed.data

    const rawCode = generateRawToken('rpe_')
    const invite = await c.var.repos.invites.create({
      id: `evi_${ulid()}`,
      eventId: event.id,
      codeHash: hashToken(rawCode),
      invitedByUserId: c.var.session!.userId,
      invitedEmail: invitedEmail ?? null,
      role,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    })
    await recordActivity(c, event.id, 'event.invite_created', { invite_id: invite.id, role })
    // The raw code leaves the API exactly once, here.
    return c.json(
      {
        id: invite.id,
        code: rawCode,
        role: invite.role,
        invited_email: invite.invitedEmail,
        expires_at: invite.expiresAt.toISOString(),
      },
      201,
    )
  })

  // --- accept invite -----------------------------------------------
  .post('/api/v1/ui/invites/accept', async (c) => {
    const userId = c.var.session!.userId
    const parsed = AcceptInviteSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    const invite = await c.var.repos.invites.findByCodeHash(hashToken(parsed.data.code))
    if (!invite) {
      throw new ApiError({ code: 'invite_invalid', message: 'Invite is invalid.', status: 404 })
    }
    if (invite.consumedAt) {
      throw errors.conflict('invite_already_consumed', 'Invite has already been used.')
    }
    if (invite.expiresAt.getTime() < Date.now()) {
      throw new ApiError({ code: 'invite_expired', message: 'Invite has expired.', status: 400 })
    }

    const event = await c.var.repos.events.findById(invite.eventId)
    if (!event || event.deletedAt) {
      throw new ApiError({ code: 'invite_invalid', message: 'Invite is invalid.', status: 404 })
    }
    if (event.ownerUserId === userId) {
      throw errors.conflict('already_owner', 'You already own this event.')
    }
    // Re-admission path (Phase 0 round-3 fix): an attendee whose
    // event_attendees row was soft-removed (removed_at NOT NULL)
    // keeps their event_members row. Detect that here so we can pass
    // `skipMemberAdd: true` to the repo and treat it as a re-admission
    // instead of a duplicate-member 409. Pre-reads happen at the route
    // (these are policy decisions, not writes); the repo trusts the
    // intent flag inside its transaction.
    const existing = await c.var.repos.members.findByEventAndUser(event.id, userId)
    let skipMemberAdd = false
    if (existing) {
      const attendee = await c.var.repos.attendees.findByEventAndUser(event.id, userId)
      const isRevoked = attendee !== null && attendee.removedAt !== null
      if (!isRevoked) {
        throw errors.conflict('already_member', 'You are already a member of this event.')
      }
      skipMemberAdd = true
    }
    // #171: event_members (conditional) + event_attendees upsert +
    // invite consume in one DB transaction. A concurrent double-accept
    // (two tabs) hits a unique violation on event_members and surfaces
    // here as `already_active_member` → 409.
    const result = await c.var.repos.events.acceptInvite({
      memberId: `evm_${ulid()}`,
      attendeeId: `eva_${ulid()}`,
      eventId: event.id,
      userId,
      role: invite.role,
      inviteId: invite.id,
      skipMemberAdd,
    })
    if (!result.ok) {
      throw errors.conflict('already_member', 'You are already a member of this event.')
    }
    await recordActivity(c, event.id, 'event.invite_accepted', {
      invite_id: invite.id,
      ...(result.readmitted ? { readmitted: true } : {}),
    })
    // E2 #8: invite.role is the authoritative role for THIS acceptance,
    // including re-admissions where the previous member row had a
    // different role. The repo's UPDATE in the skipMemberAdd path
    // brings the DB into agreement; the response mirrors it.
    return c.json({ event_slug: event.slug, role: invite.role })
  })
