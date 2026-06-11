import type { ListItemDto } from '@rallypoint/lists-client'
import type { UserEventDto } from '@rallypoint/events-client'

// Helpers for merging the actor's personal task items / group-event days with
// items from planner-flagged SHARED sources ("show in planner" per-user prefs).
// The flag lives in the source service (lists-db / events-db) and is read over
// the SDK; Planner stays stateless.

// --- task (lists) helpers ------------------------------------------------

// Personal-scope lists and flagged shared lists live in different groups,
// so their items are disjoint by construction — but we still de-dup by item
// id as a safeguard against a future double-fetch, and so a list that is
// somehow both personal and flagged can't double-render.

/** Concatenate personal + shared task items, de-duped by item id (personal
 * wins). Order: all personal items first, then shared items not already
 * present. */
export function mergeSharedTaskItems(
  personal: readonly ListItemDto[],
  shared: readonly ListItemDto[],
): ListItemDto[] {
  const seen = new Set(personal.map((i) => i.id))
  const merged: ListItemDto[] = [...personal]
  for (const item of shared) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    merged.push(item)
  }
  return merged
}

/** Build the set of list ids that should be marked "shared" in the planner
 * output — the flagged shared lists minus any that are also in the personal
 * scope (personal always wins, never badged as shared). */
export function sharedListIdSet(
  flaggedSharedListIds: readonly string[],
  personalListIds: readonly string[],
): Set<string> {
  const personal = new Set(personalListIds)
  return new Set(flaggedSharedListIds.filter((id) => !personal.has(id)))
}

// --- group-event (events) helpers ----------------------------------------

// Group events are already pulled via listUserEvents (all reachable events).
// listPlannerGroupEvents returns only the flagged subset. We dedup at the
// event level (by eventId) BEFORE day-expansion, so an event that is both
// reachable and flagged expands once (reachable wins, preserving ownership);
// a flagged event the actor lost access to silently drops (the events SDK
// re-checks access at read time).

/** Merge already-reachable group events with planner-flagged group events,
 * de-duped by eventId (reachable wins so ownership data is preserved).
 * Returns a combined UserEventDto[] ready for expandEventDays. */
export function mergeSharedGroupEvents(
  reachable: readonly UserEventDto[],
  flagged: readonly UserEventDto[],
): UserEventDto[] {
  const seen = new Set(reachable.map((e) => e.eventId))
  const merged: UserEventDto[] = [...reachable]
  for (const e of flagged) {
    if (seen.has(e.eventId)) continue
    seen.add(e.eventId)
    merged.push(e)
  }
  return merged
}

/** Build the set of event ids that should be marked "shared" in the planner
 * output — the flagged event ids minus any already in the reachable set
 * (reachable events are never badged as shared). */
export function sharedEventIdSet(
  flaggedEventIds: readonly string[],
  reachableEventIds: readonly string[],
): Set<string> {
  const reachable = new Set(reachableEventIds)
  return new Set(flaggedEventIds.filter((id) => !reachable.has(id)))
}
