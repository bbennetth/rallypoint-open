import type { UserEventDto } from '@rallypoint/events-client'

// Helpers for merging the actor's group-event days with planner-flagged
// SHARED group events ("show in planner" per-user prefs). The flag lives in
// events-db and is read over the SDK; Planner stays stateless. (The lists
// equivalent was removed with the RPL↔RPP separation, #531 — tasks come
// only from the actor's personal planner-origin lists.)

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
