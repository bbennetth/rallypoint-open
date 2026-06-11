import type { Context } from 'hono'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { GroupRecord, GroupRole } from '../repos/types.js'

// Group access-control helpers, sibling of _access.ts. Groups carry an
// event_id, so audit rows still land in event_activity via the shared
// recordActivity helper.
//
// Phase 0 privacy rule (platform/v-1.1, #16): event owners do NOT see
// or act on groups inside their event. Groups are opaque containers
// attendees form among themselves; chat, lists, ledger, members, and
// rallies all gate on a real `group_members` row. The owner side
// reads attendees from `event_attendees` instead (see attendees.ts).

export const GROUP_ROLE_RANK: Record<GroupRole, number> = { owner: 3, sidekick: 2, member: 1 }

// Resolve the actor's group role, or null if they have no access. A
// soft-deleted parent event freezes all group access (matching the join
// path, which rejects a deleted event's codes) — nobody acts on groups
// of an event pending purge.
//
// **Event owners no longer pass through as group 'owner'** — under the
// privacy rule they must be `group_members` rows like any other
// participant. The shortcut that previously short-circuited this check
// to `'owner'` is removed (Phase 0 / issue #16).
//
// **Attendee revocation also gates group access:** if the user has been
// soft-removed from the parent event (event_attendees.removed_at IS NOT
// NULL), every group under that event closes to them, even though
// their group_members row still exists. The event owner is exempt
// (they don't carry an event_attendees row).
export async function groupActorRole(
  c: Context<HonoApp>,
  group: GroupRecord,
  userId: string,
): Promise<GroupRole | null> {
  const event = await c.var.repos.events.findById(group.eventId)
  if (!event || event.deletedAt) return null
  const member = await c.var.repos.groupMembers.findByGroupAndUser(group.id, userId)
  if (!member) return null
  if (event.ownerUserId !== userId) {
    const attendee = await c.var.repos.attendees.findByEventAndUser(event.id, userId)
    if (attendee && attendee.removedAt !== null) return null
  }
  return member.role
}

// Load a group by id and enforce access. minGroupRole gates the action;
// no access 404s rather than 403s so group existence doesn't leak.
//
// Stale-prefix ids (`crew_<ulid>` from before Phase R, anything not
// matching `grp_*`) 404 before we touch the repo so a renamed-but-not-
// updated client doesn't quietly hit the DB on every request.
export async function loadGroupForAction(
  c: Context<HonoApp>,
  groupId: string,
  minGroupRole: GroupRole,
): Promise<{ group: GroupRecord; role: GroupRole }> {
  if (!groupId.startsWith('grp_')) throw errors.groupNotFound()
  const userId = c.var.session!.userId
  const group = await c.var.repos.groups.findById(groupId)
  if (!group) throw errors.groupNotFound()
  const role = await groupActorRole(c, group, userId)
  if (role === null) throw errors.groupNotFound() // don't leak existence
  if (GROUP_ROLE_RANK[role] < GROUP_ROLE_RANK[minGroupRole]) throw errors.forbidden()
  return { group, role }
}
