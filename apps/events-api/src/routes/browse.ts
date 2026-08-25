import { Hono } from 'hono'
import { ulid } from 'ulid'
import { resolveEventFeatures } from '@rallypoint/events-shared'
import { paginationQuery } from '@rallypoint/api-kit'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { eventsCursorCodec } from '../lib/events-cursor.js'
import type { EventRecord, MemberRole } from '../repos/types.js'
import {
  TENANT,
  actorRole,
  isBrowsableEvent,
  recordActivity,
  requireIdPrefix,
  viewerAttending,
} from './_access.js'
import { serializeEvent } from './events.js'
import { serializeDay, serializeSlot, serializeStage, slotArtistMeta } from './lineup.js'

// Browse tab (#browse-tab): the discovery surface for signed-in users.
// Visibility is isBrowsableEvent (system-owned OR public, non-deleted)
// — deliberately NOT membership, so every handler here loads events
// directly instead of via loadForAction. Mounted BEFORE eventsRoutes in
// build-app.ts so GET /events/browse isn't captured by GET /events/:slug.

const browsePageQuery = paginationQuery({ defaultLimit: 20, maxLimit: 100, mode: 'clamp' })

// serializeEvent + the two per-viewer bits the browse list needs to
// render Join vs Open. viewer_role is null for strangers here — the
// only surface where the serializer sees a null role.
function serializeBrowseEvent(
  e: EventRecord,
  viewerRole: MemberRole | null,
  attending: boolean,
): Record<string, unknown> {
  return { ...serializeEvent(e, viewerRole), viewer_attending: attending }
}

export const browseRoutes = new Hono<HonoApp>()
  // --- list browsable events ---------------------------------------
  .get('/api/v1/ui/events/browse', async (c) => {
    const userId = c.var.session!.userId
    const parsed = browsePageQuery.safeParse({
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
    })
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { limit, cursor } = parsed.data
    if (cursor !== undefined && eventsCursorCodec.decode(cursor) === null) {
      throw errors.validation({
        issues: [{ code: 'custom', path: ['cursor'], message: 'Invalid cursor.' }],
      })
    }

    const page = await c.var.repos.events.listBrowsable({
      includeDeleted: false,
      limit,
      cursor: cursor ?? null,
    })
    const items: Record<string, unknown>[] = []
    for (const e of page.items) {
      // Unlike /me/events, a null role does NOT hide the row — that's
      // the whole point of Browse. It renders as a Join affordance.
      const role = await actorRole(c, e, userId)
      items.push(serializeBrowseEvent(e, role, await viewerAttending(c, e.id, userId)))
    }
    return c.json({ items, next_cursor: page.nextCursor })
  })

  // --- pre-join preview by slug --------------------------------------
  // Read-only event info + lineup for a browsable event, no membership
  // required. A dedicated endpoint (rather than relaxing loadForAction
  // on the lineup routes) so the membership-gated surfaces stay intact.
  .get('/api/v1/ui/events/browse/:slug', async (c) => {
    const userId = c.var.session!.userId
    const event = await c.var.repos.events.findBySlug(TENANT, c.req.param('slug'))
    // Same 404 for missing and non-browsable — don't leak existence of
    // unlisted/private events, mirroring loadForAction.
    if (!event || !isBrowsableEvent(event)) throw errors.eventNotFound()

    const role = await actorRole(c, event, userId)
    // Lineup honors the per-event feature toggle (#216) with the same
    // owner exemption as assertFeatureEnabled; here a disabled lineup
    // omits the section (null) instead of 404ing the whole preview.
    const lineupEnabled = role === 'owner' || resolveEventFeatures(event.features).lineup
    let lineup: { stages: unknown[]; days: unknown[]; slots: unknown[] } | null = null
    if (lineupEnabled) {
      const [stages, days, slots] = await Promise.all([
        c.var.repos.stages.listForEvent(event.id),
        c.var.repos.days.listForEvent(event.id),
        c.var.repos.eventArtists.listForEvent(event.id),
      ])
      const meta = await slotArtistMeta(c.var.repos.artists, slots)
      lineup = {
        stages: stages.map(serializeStage),
        days: days.map(serializeDay),
        slots: slots.map((s) => serializeSlot(s, meta.get(s.artistId) ?? null)),
      }
    }
    return c.json({
      event: serializeBrowseEvent(event, role, await viewerAttending(c, event.id, userId)),
      lineup,
    })
  })

  // --- invite-free self-join -----------------------------------------
  .post('/api/v1/ui/events/:id/join', async (c) => {
    const userId = c.var.session!.userId
    const eventId = requireIdPrefix(c.req.param('id'), 'event_')
    const event = await c.var.repos.events.findById(eventId)
    if (!event || !isBrowsableEvent(event)) throw errors.eventNotFound()
    if (event.ownerUserId === userId) {
      throw errors.conflict('already_owner', 'You already own this event.')
    }
    // Re-admission pre-detect, same policy read as invite accept: a
    // surviving event_members row + soft-removed event_attendees row
    // means "rejoin", not "duplicate".
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
    const result = await c.var.repos.events.joinAsViewer({
      memberId: `evm_${ulid()}`,
      attendeeId: `eva_${ulid()}`,
      eventId: event.id,
      userId,
      skipMemberAdd,
    })
    if (!result.ok) {
      throw errors.conflict('already_member', 'You are already a member of this event.')
    }
    await recordActivity(c, event.id, 'event.browse_joined', {
      ...(result.readmitted ? { readmitted: true } : {}),
    })
    return c.json({ event_slug: event.slug, role: 'viewer' as const })
  })
