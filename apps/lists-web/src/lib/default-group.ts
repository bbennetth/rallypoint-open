// Default-group resolution for My Lists. A Lists user shouldn't have to
// create a group before making a list, so the page auto-provisions one
// writable "home" group on first visit (#531 follow-up).
//
// The Planner-provisioned personal group ("Planner", origin='planner'; formerly "My Tasks" — renamed by migration 0010)
// shows up in the same group listing but is read-only in the Lists app
// (#531), so it does NOT count as a place to make lists — the default
// must be a writable, Lists-owned group.

import type { GroupDto } from './api.js'

// Reserved display name for the auto-provisioned default Lists group
// (parallel to Planner's "Planner" group). createGroup is conflict-tolerant on
// (created_by, name), so re-provisioning is idempotent.
export const DEFAULT_GROUP_NAME = 'My Lists'

type GroupOriginLike = Pick<GroupDto, 'origin'>

// A group the user can create lists in. Planner-origin groups are
// read-only on the Lists UI surface, so they're excluded.
export function isWritableGroup(g: GroupOriginLike): boolean {
  return g.origin !== 'planner'
}

// True when the user has no writable group — the trigger to auto-provision
// the default one. Having only the Planner "Planner" group still counts as
// needing a default, since lists can't be created there.
export function needsDefaultGroup(groups: readonly GroupOriginLike[]): boolean {
  return !groups.some(isWritableGroup)
}

// The group id the page should select by default: the first writable group,
// or null when only read-only (Planner) groups exist. Keeps the create form
// pointed at a scope the user can actually write to.
export function selectDefaultGroupId(groups: readonly GroupDto[]): string | null {
  return groups.find(isWritableGroup)?.id ?? null
}
