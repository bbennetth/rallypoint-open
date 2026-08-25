import type { EventDto, GroupDto, MemberRole } from './api.js'

// Where an attendee should land when they open an event.
//
// `my_group_id` is the caller's FIRST-joined group in the event (the API
// collapses multiple memberships to one — see listUserGroupIdsByEvent).
// Three call sites used to inline this ternary and one of them had
// drifted: PreviewPage always sent the viewer to the solo shell, so an
// owner with a group landed on "You're attending solo". Keep them all
// on this helper so they can't disagree again.
//
// Landing in one group is not the whole story — the Group tab lists
// every group you belong to, which is what makes the others reachable.

export function attendeeHomeHref(event: Pick<EventDto, 'slug' | 'my_group_id'>): string {
  if (event.my_group_id) return `/groups/${encodeURIComponent(event.my_group_id)}`
  return `/events/${encodeURIComponent(event.slug)}/attending/now`
}

// The event's Group tab — "my groups in this event". Reachable from the
// solo shell's tab bar and linked from inside a group so a second group
// isn't a dead end.
export function eventGroupsHref(slug: string): string {
  return `/events/${encodeURIComponent(slug)}/attending/group`
}

// The owner-side tab shell (Overview). EventOwnerLayout bounces
// viewer-role users straight back out of here (#440), so this is only a
// sensible destination for the roles `canManageEvent` accepts.
export function eventOwnerHref(slug: string): string {
  return `/events/${encodeURIComponent(slug)}`
}

export function canManageEvent(role: MemberRole): boolean {
  return role === 'owner' || role === 'editor'
}

// Where opening an event from the My Events list should land.
//
// On a phone the owner tab shell is the wrong default even for the
// organizer: those tabs are wide, table-heavy management surfaces, and
// someone opening the event on their phone is almost always *at* it.
// So mobile gets the attendee experience for every role, and the owner
// tabs stay reachable via the row's "Manage" link.
//
// Deliberately scoped to this one entry point — a deep link to
// /events/:slug still opens the owner shell, which is what keeps the
// solo shell's "Return to owner view" link from bouncing straight back.
//
// Soft-deleted events are the one mobile exception: the attendee shell
// for a dead event is a dead end, and the only reason you'd open one
// from behind the "Show deleted events" checkbox is to manage it.
export function eventHomeHref(
  event: Pick<EventDto, 'slug' | 'my_group_id' | 'viewer_role' | 'deleted_at'>,
  opts: { mobile: boolean },
): string {
  if (canManageEvent(event.viewer_role) && (!opts.mobile || event.deleted_at)) {
    return eventOwnerHref(event.slug)
  }
  return attendeeHomeHref(event)
}

// Your other groups in the same event, for the "you're also in…" list
// rendered inside a group. Order is preserved (the API returns join
// order); only the group you're currently looking at drops out.
export function otherGroups(groups: readonly GroupDto[], currentGroupId: string): GroupDto[] {
  return groups.filter((g) => g.id !== currentGroupId)
}
