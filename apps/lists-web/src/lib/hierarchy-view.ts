// Sub-item tree shaping for the list UI (RPL v1.0.0 S5). Pure: turns the
// flat item set the API returns into a parent→child tree for nested
// rendering, and exposes the progress-rollup math. The API caps nesting at
// depth 5 and counts direct children server-side (child_count /
// child_done_count); these helpers only reshape what comes back, so an
// item is never hidden — an orphan (parent not in the returned set, e.g.
// beyond the scan cap) is promoted to a root.

export interface TreeItem {
  id: string
  parent_id: string | null
}

export interface ItemTreeNode<T extends TreeItem> {
  item: T
  depth: number
  children: ItemTreeNode<T>[]
}

export function buildItemTree<T extends TreeItem>(items: readonly T[]): ItemTreeNode<T>[] {
  const present = new Set(items.map((i) => i.id))
  const childrenOf = new Map<string, T[]>()
  const roots: T[] = []
  for (const item of items) {
    const parent = item.parent_id
    // A root is a top-level item OR an orphan whose parent fell outside the
    // returned set — promoting orphans guarantees every item renders once.
    if (parent === null || !present.has(parent)) {
      roots.push(item)
    } else {
      const bucket = childrenOf.get(parent)
      if (bucket) bucket.push(item)
      else childrenOf.set(parent, [item])
    }
  }

  // `seen` guards against a corrupt stored cycle so the recursion can't loop.
  const seen = new Set<string>()
  function build(item: T, depth: number): ItemTreeNode<T> {
    seen.add(item.id)
    const kids = (childrenOf.get(item.id) ?? []).filter((c) => !seen.has(c.id))
    return { item, depth, children: kids.map((c) => build(c, depth + 1)) }
  }
  const result = roots.map((r) => build(r, 0))
  // A pure cycle (every member's parent present, so no null/orphan root)
  // would otherwise hide all its members. Cycles are API-prevented, but
  // promote any still-unreached item to a root so nothing silently vanishes.
  for (const item of items) {
    if (!seen.has(item.id)) result.push(build(item, 0))
  }
  return result
}

export interface FlatTreeRow<T extends TreeItem> {
  item: T
  depth: number
  hasChildren: boolean
}

// Depth-first flatten in render order, skipping the descendants of any
// collapsed node. Used by the grid (a flat table that still wants the tree
// order + indent) and anywhere a flat list of visible rows is easier.
export function flattenVisible<T extends TreeItem>(
  nodes: readonly ItemTreeNode<T>[],
  collapsed: ReadonlySet<string>,
): FlatTreeRow<T>[] {
  const out: FlatTreeRow<T>[] = []
  function walk(node: ItemTreeNode<T>) {
    out.push({ item: node.item, depth: node.depth, hasChildren: node.children.length > 0 })
    if (collapsed.has(node.item.id)) return
    for (const child of node.children) walk(child)
  }
  for (const node of nodes) walk(node)
  return out
}

// Parent progress as a whole-number percent. 0 when there are no children
// (callers should not render a bar in that case).
export function progressPercent(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((Math.max(0, Math.min(done, total)) / total) * 100)
}
