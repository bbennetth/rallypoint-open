import type { MemberRole } from './api.js'
import { canManageEvent, eventOwnerHref } from './attendee-route.js'

// Routing decisions for the Browse tab (#browse-tab). Kept as pure
// helpers (like attendee-route.ts) so BrowsePage and EventPreviewPage
// can't drift on what Join/Open does.

// Mirror of packages/shared SYSTEM_USER_ID — events-web has no
// workspace dep on @rallypoint/shared, and the sentinel is a stable
// wire value (it's persisted in events.owner_user_id).
export const SYSTEM_USER_ID = 'user_00000000000000000000000000'

export function isSystemEvent(event: { owner_user_id: string }): boolean {
  return event.owner_user_id === SYSTEM_USER_ID
}

// The attending decision page — same landing the invite-accept flow
// uses for viewer-role joiners (EventJoinPage), and where a fresh
// self-join lands.
export function eventAttendDecisionHref(slug: string): string {
  return `/events/${encodeURIComponent(slug)}/attend`
}

export function eventPreviewHref(slug: string): string {
  return `/browse/${encodeURIComponent(slug)}`
}

// What the primary action on a Browse row / preview CTA should be:
// strangers get Join; members open the event (managers land on the
// owner shell, viewers on the attending decision page — Browse rows
// don't carry my_group_id, so the decision page does group routing).
export type BrowseAction = { kind: 'join' } | { kind: 'open'; href: string }

export function browseEventAction(event: {
  slug: string
  viewer_role: MemberRole | null
}): BrowseAction {
  if (event.viewer_role === null) return { kind: 'join' }
  if (canManageEvent(event.viewer_role)) {
    return { kind: 'open', href: eventOwnerHref(event.slug) }
  }
  return { kind: 'open', href: eventAttendDecisionHref(event.slug) }
}
