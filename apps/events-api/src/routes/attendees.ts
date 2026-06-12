import { Hono } from 'hono'
import { ulid } from 'ulid'
import { z } from 'zod'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { readJsonBody } from './_body.js'
import { loadForAction, recordActivity, requireIdPrefix } from './_access.js'
import { assertFeatureEnabled } from './_features.js'

// Phase 0 of platform/v-1.1 — the owner-side attendees-first surface.
//
//   GET    /api/v1/ui/events/:id/attendees           — owner/editor lists everyone attending or invited.
//   DELETE /api/v1/ui/events/:id/attendees/:userId   — owner/editor soft-removes an attendee (block self).
//   GET    /api/v1/ui/events/:id/invites             — owner/editor pending invite list.
//   POST   /api/v1/ui/events/:id/invites/bulk        — owner/editor creates many invites in one transaction.
//   DELETE /api/v1/ui/events/:id/invites/:inviteId   — owner/editor revokes a pending invite.
//
// The privacy rule lives at the API layer first (see #87 in the plan):
// groups + group-internal data stay opaque to event owners. This file
// is what the owner-side UI reads instead.

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000 // 14 days
const ATTENDEES_PAGE_DEFAULT = 50
const ATTENDEES_PAGE_MAX = 200
const BULK_INVITE_MAX = 200

const RoleField = z.enum(['editor', 'viewer'])

const BulkInviteSchema = z.object({
  emails: z
    .array(z.string().trim().email().max(320))
    .min(1, 'At least one email required.')
    .max(BULK_INVITE_MAX, `emails may not exceed ${BULK_INVITE_MAX} per request.`),
  role: RoleField.default('viewer'),
})

const AttendeesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(ATTENDEES_PAGE_MAX).default(ATTENDEES_PAGE_DEFAULT),
  cursor: z.string().datetime().nullable().optional(),
})

export const attendeesRoutes = new Hono<HonoApp>()
  // ── who's going (any member, #216) ────────────────────────────────
  // Attendee-visible roster, gated on the per-event `attendees`
  // feature toggle (default OFF; 404s for non-owners when off, like
  // every gated surface). Display names only — emails stay on the
  // owner/editor surface below.
  .get('/api/v1/ui/events/:id/attendees/community', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'viewer')
    assertFeatureEnabled(event, role, 'attendees')
    const parsed = AttendeesQuerySchema.safeParse({
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor') ?? null,
    })
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    const cursor = parsed.data.cursor ? new Date(parsed.data.cursor) : null
    const page = await c.var.repos.attendees.listForEvent(event.id, {
      limit: parsed.data.limit,
      cursor,
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
      next_cursor: page.nextCursor ? page.nextCursor.toISOString() : null,
    })
  })

  // ── list attendees (editor+) ──────────────────────────────────────
  .get('/api/v1/ui/events/:id/attendees', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const parsed = AttendeesQuerySchema.safeParse({
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor') ?? null,
    })
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    const cursor = parsed.data.cursor ? new Date(parsed.data.cursor) : null
    const page = await c.var.repos.attendees.listForEvent(event.id, {
      limit: parsed.data.limit,
      cursor,
    })

    // Pull collaborator roles (owner + editors + viewers) for everyone
    // on the page in one shot so the response includes role alongside
    // the attendance signal. The owner row may not exist in
    // event_members; we handle that as an OR clause below.
    const collaborators = await c.var.repos.members.listForEvent(event.id)
    const roleByUser = new Map(collaborators.map((m) => [m.userId, m.role]))
    roleByUser.set(event.ownerUserId, 'owner')

    // Resolve emails + display names via RPID. Dedup the lookup set
    // because the same user_id may appear multiple times across pages
    // (it won't here — listForEvent paginates — but the dedup is cheap).
    const userIds = Array.from(new Set(page.items.map((a) => a.userId)))
    const lookup = await c.var.services.idClient.batchLookupUsers(userIds)
    const userById = new Map(lookup.map((u) => [u.userId, u]))

    return c.json({
      items: page.items.map((a) => {
        const u = userById.get(a.userId) ?? null
        return {
          user_id: a.userId,
          email: u?.email ?? null,
          display_name: u?.displayName ?? null,
          joined_at: a.joinedAt.toISOString(),
          role: roleByUser.get(a.userId) ?? null,
        }
      }),
      next_cursor: page.nextCursor ? page.nextCursor.toISOString() : null,
    })
  })

  // ── export attendees as CSV (editor+) ──────────────────────────────
  // Streams a CSV with one header row + one row per attendee. Used by
  // the Attendees tab's "Export CSV" button. Caps at 2000 rows to bound
  // the lookup payload — events with more attendees can paginate via
  // the JSON endpoint instead (CSV becomes a separate background-job
  // surface when that scale matters).
  .get('/api/v1/ui/events/:id/attendees.csv', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const page = await c.var.repos.attendees.listForEvent(event.id, {
      limit: 2000,
      cursor: null,
    })
    const userIds = Array.from(new Set(page.items.map((a) => a.userId)))
    const lookup = await c.var.services.idClient.batchLookupUsers(userIds)
    const userById = new Map(lookup.map((u) => [u.userId, u]))
    const collaborators = await c.var.repos.members.listForEvent(event.id)
    const roleByUser = new Map(collaborators.map((m) => [m.userId, m.role]))
    roleByUser.set(event.ownerUserId, 'owner')

    const rows: string[] = ['user_id,email,display_name,role,joined_at']
    for (const a of page.items) {
      const u = userById.get(a.userId) ?? null
      const role = roleByUser.get(a.userId) ?? ''
      rows.push(
        [
          a.userId,
          u?.email ?? '',
          u?.displayName ?? '',
          role,
          a.joinedAt.toISOString(),
        ]
          .map(csvEscape)
          .join(','),
      )
    }
    const csv = rows.join('\r\n') + '\r\n'
    const filename = `${event.slug}-attendees-${new Date().toISOString().slice(0, 10)}.csv`
    return new Response(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    })
  })

  // ── remove attendee (editor+, block self-removal) ───────────────────
  .delete('/api/v1/ui/events/:id/attendees/:userId', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const targetUserId = requireIdPrefix(c.req.param('userId'), 'user_')
    if (event.ownerUserId === targetUserId) {
      throw new ApiError({
        code: 'owner_cannot_be_removed',
        message: 'The event owner cannot be removed.',
        status: 409,
      })
    }
    if (targetUserId === c.var.session!.userId) {
      throw new ApiError({
        code: 'owner_cannot_remove_self',
        message: 'You cannot remove yourself from the event.',
        status: 409,
      })
    }
    await c.var.repos.attendees.softRemove(event.id, targetUserId, new Date())
    await recordActivity(c, event.id, 'event.attendee_removed', {
      removed_user_id: targetUserId,
    })
    return c.body(null, 204)
  })

  // ── list pending invites (editor+) ─────────────────────────────────
  .get('/api/v1/ui/events/:id/invites', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const all = await c.var.repos.invites.listForEvent(event.id)
    const now = Date.now()
    return c.json({
      items: all
        .filter((inv) => inv.consumedAt === null && inv.expiresAt.getTime() > now)
        .map((inv) => ({
          id: inv.id,
          invited_email: inv.invitedEmail,
          role: inv.role,
          created_at: inv.createdAt.toISOString(),
          expires_at: inv.expiresAt.toISOString(),
        })),
    })
  })

  // ── bulk create invites (editor+) ──────────────────────────────────
  // Wire format: { emails: string[], role?: 'editor'|'viewer' }. Each
  // input email becomes one invite row. Duplicate emails within the
  // request are de-duplicated. The response surfaces both `created`
  // and `skipped` (validation issues) per email so the UI can show a
  // per-row status. Per design, raw codes leave exactly once — they're
  // returned here, never re-derivable.
  .post('/api/v1/ui/events/:id/invites/bulk', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const parsed = BulkInviteSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    const { role } = parsed.data
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
    const created: { email: string; code: string; id: string; expires_at: string }[] = []
    const seen = new Set<string>()

    for (const rawEmail of parsed.data.emails) {
      const email = rawEmail.trim().toLowerCase()
      if (seen.has(email)) continue
      seen.add(email)
      const rawCode = generateRawToken('rpe_')
      const invite = await c.var.repos.invites.create({
        id: `evi_${ulid()}`,
        eventId: event.id,
        codeHash: hashToken(rawCode),
        invitedByUserId: c.var.session!.userId,
        invitedEmail: email,
        role,
        expiresAt,
      })
      created.push({
        email,
        code: rawCode,
        id: invite.id,
        expires_at: invite.expiresAt.toISOString(),
      })
    }
    await recordActivity(c, event.id, 'event.invites_bulk_created', {
      count: created.length,
      role,
    })
    return c.json({ created }, 201)
  })

  // ── revoke pending invite (editor+) ────────────────────────────────
  .delete('/api/v1/ui/events/:id/invites/:inviteId', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const inviteId = requireIdPrefix(c.req.param('inviteId'), 'evi_')
    const invite = await c.var.repos.invites.findById(inviteId)
    if (!invite || invite.eventId !== event.id) {
      throw new ApiError({
        code: 'invite_not_found',
        message: 'Invite not found.',
        status: 404,
      })
    }
    if (invite.consumedAt) {
      throw errors.conflict('invite_already_consumed', 'Invite has already been used.')
    }
    const removed = await c.var.repos.invites.deletePending(inviteId)
    if (!removed) {
      throw new ApiError({
        code: 'invite_not_found',
        message: 'Invite not found.',
        status: 404,
      })
    }
    await recordActivity(c, event.id, 'event.invite_revoked', { invite_id: inviteId })
    return c.body(null, 204)
  })

// CSV field escape per RFC 4180: wrap in double quotes if the value
// contains comma, quote, CR, or LF; escape embedded quotes by doubling.
function csvEscape(v: string): string {
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`
  }
  return v
}
