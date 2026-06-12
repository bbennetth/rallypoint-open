// Pure sub-item hierarchy logic for Rallypoint Lists (RPL v1.0.0 slice 4).
// Items nest via a `parentId` pointing at another item in the SAME list.
// These helpers are framework-agnostic so both apps/lists-api and the web
// agree on cycle prevention, the depth cap, and the parent progress rollup.

// Max nesting depth. An item's depth is its number of ancestors: a
// top-level item is depth 0, its child depth 1, and so on. The cap is the
// deepest depth an item may have, so MAX_PARENT_DEPTH = 5 permits chains of
// six nodes (depths 0…5). The UI renders one level; the API bounds the full
// chain so a deep tree can't be built even though the UI never shows it.
export const MAX_PARENT_DEPTH = 5

export type ParentAssignmentResult = 'ok' | 'self' | 'cycle' | 'too_deep' | 'missing'

// Decide whether `itemId` may be re-parented under `newParentId`, given a
// map of every item's current parent (id → parentId|null) for the list.
// - 'self'    — an item cannot be its own parent.
// - 'missing' — newParentId isn't in the list.
// - 'cycle'   — newParentId is a descendant of itemId (walking UP from
//               newParentId reaches itemId), which the edge would loop.
// - 'too_deep'— placing itemId under newParentId would push itemId past the
//               depth cap (resulting depth = depth(newParentId) + 1).
// - 'ok'      — safe.
export function validateParentAssignment(
  parentOf: Map<string, string | null>,
  itemId: string,
  newParentId: string,
  maxDepth: number = MAX_PARENT_DEPTH,
): ParentAssignmentResult {
  if (newParentId === itemId) return 'self'
  if (!parentOf.has(newParentId)) return 'missing'

  // Walk UP from newParentId toward the root, counting newParentId's own
  // depth (its ancestor count). If we reach itemId, the proposed edge would
  // close a cycle. The `seen` set also guards against a pre-existing corrupt
  // cycle in the stored data so the walk can't loop forever.
  let cursor: string | null = newParentId
  let parentDepth = 0
  const seen = new Set<string>()
  while (cursor !== null) {
    if (cursor === itemId) return 'cycle'
    if (seen.has(cursor)) break // pre-existing cycle upstream; stop walking
    seen.add(cursor)
    cursor = parentOf.get(cursor) ?? null
    if (cursor !== null) parentDepth++
  }
  // itemId would sit one level below newParentId.
  if (parentDepth + 1 > maxDepth) return 'too_deep'
  return 'ok'
}

export interface ChildCount {
  total: number
  done: number
}

// Count DIRECT children per parent across a flat item set. `done` counts
// children whose `completed` is true (the parent progress rollup). Items
// with a null parentId contribute nothing. Returns a map keyed by parent id.
export function childRollup(
  items: ReadonlyArray<{ id: string; parentId: string | null; completed: boolean }>,
): Map<string, ChildCount> {
  const out = new Map<string, ChildCount>()
  for (const it of items) {
    if (it.parentId === null) continue
    const c = out.get(it.parentId) ?? { total: 0, done: 0 }
    c.total++
    if (it.completed) c.done++
    out.set(it.parentId, c)
  }
  return out
}
