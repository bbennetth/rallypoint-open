import { ulid } from 'ulid'
import type { Context } from 'hono'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { EventRecord, MemberRole } from '../repos/types.js'

// Shared event access-control + audit helpers used by every router
// that operates on an event (events CRUD, lineup, sessions). Kept in
// one place so the permission rules can't drift between surfaces.

export const TENANT = 'rallypoint'

export const ROLE_RANK: Record<MemberRole, number> = { owner: 3, editor: 2, viewer: 1 }

// Resolve the actor's role on an event, or null if they have no
// access at all. Owner is canonical (events.owner_user_id); everyone
// else needs a member row.
//
// Phase 0 (#16): a soft-removed event_attendees row revokes access
// across the board, even if the user still has an event_members
// collaborator row. The owner short-circuits — they don't carry an
// event_attendees row and cannot be removed by the attendees endpoint
// (it 409s on owner). For collaborators, we require either no
// event_attendees row (legacy collaborators predating the table) or
// a row with removed_at IS NULL.
export async function actorRole(
  c: Context<HonoApp>,
  event: EventRecord,
  userId: string,
): Promise<MemberRole | null> {
  if (event.ownerUserId === userId) return 'owner'
  const member = await c.var.repos.members.findByEventAndUser(event.id, userId)
  if (!member) return null
  const attendee = await c.var.repos.attendees.findByEventAndUser(event.id, userId)
  if (attendee && attendee.removedAt !== null) return null
  return member.role
}

// Load an event by id and enforce access. minRole gates the action;
// deleted events 404 unless allowDeleted (restore/owner-view paths).
//
// Stale-prefix ids (anything not matching `event_*`) 404 before we
// touch the repo — same defense-in-depth as loadGroupForAction.
export async function loadForAction(
  c: Context<HonoApp>,
  eventId: string,
  minRole: MemberRole,
  allowDeleted = false,
): Promise<{ event: EventRecord; role: MemberRole }> {
  if (!eventId.startsWith('event_')) throw errors.eventNotFound()
  const userId = c.var.session!.userId
  const event = await c.var.repos.events.findById(eventId)
  if (!event) throw errors.eventNotFound()
  const role = await actorRole(c, event, userId)
  if (role === null) throw errors.eventNotFound() // don't leak existence
  if (event.deletedAt && !allowDeleted) throw errors.eventNotFound()
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) throw errors.forbidden()
  return { event, role }
}

// Prefix-shape guard for path params. Repos already 404 on unknown
// rows, but a stale-prefix id (e.g. a leftover `crew_<ulid>` from
// before Phase R, or `evt_*` used in place of `event_*`) shouldn't
// even reach the repo. We 404 here rather than 400 so existence isn't
// leaked, mirroring how `loadForAction` handles missing rows.
export function requireIdPrefix(value: string | undefined, prefix: string): string {
  if (!value || !value.startsWith(prefix)) throw errors.notFound()
  return value
}

export async function recordActivity(
  c: Context<HonoApp>,
  eventId: string,
  eventType: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  await c.var.repos.activity.record({
    id: `eva_${ulid()}`,
    eventId,
    actorUserId: c.var.session!.userId,
    eventType,
    meta,
  })
}
