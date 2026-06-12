// Drag-and-drop planning for the kanban board (RPL v1.0.0 S3). Pure: turns
// a drop gesture into a status change + a target-column reindex, with no
// dnd library and no DOM. The component layer owns only the native HTML5
// drag wiring and the optimistic/persist round-trip.
//
// Drop rules (deterministic, no pixel math so it stays testable):
//   • drop a card onto another card → place it immediately BEFORE that card;
//   • drop a card onto a column's empty area → append to that column's end.
// Moving a card to a different column changes its status (the category
// drives completion server-side); reordering within a column rewrites the
// column's positions. Positions are list-wide integers but tasks lists
// render only the board, where within-column relative order is all that
// shows — so reindexing one column to a fresh 0..n block never disturbs
// another column's display.

import type { ListItemDto } from './api.js'

// A column reduced to the data the planner needs: its status id and its
// item ids in current visual (server) order.
export interface BoardColumnIds {
  statusId: string
  itemIds: string[]
}

export type DropTarget =
  | { type: 'item'; itemId: string }
  | { type: 'column'; statusId: string }

export interface BoardDropPlan {
  itemId: string
  fromStatusId: string
  toStatusId: string
  statusChanged: boolean
  // The target column's item ids in their new order — the moved item
  // included. Drives the position reindex (id → its index).
  targetOrder: string[]
}

function columnOf(columns: BoardColumnIds[], itemId: string): BoardColumnIds | undefined {
  return columns.find((c) => c.itemIds.includes(itemId))
}

export function planBoardDrop(
  columns: BoardColumnIds[],
  activeId: string,
  target: DropTarget,
): BoardDropPlan | null {
  const source = columnOf(columns, activeId)
  if (!source) return null

  // A card dropped onto itself is a no-op.
  if (target.type === 'item' && target.itemId === activeId) return null

  const targetCol =
    target.type === 'column'
      ? columns.find((c) => c.statusId === target.statusId)
      : columnOf(columns, target.itemId)
  if (!targetCol) return null

  // Build the target column's order with the active card removed, then
  // re-insert it: before the dropped-on card, or at the end for a column drop.
  const without = targetCol.itemIds.filter((id) => id !== activeId)
  let insertAt: number
  if (target.type === 'item') {
    const idx = without.indexOf(target.itemId)
    insertAt = idx === -1 ? without.length : idx
  } else {
    insertAt = without.length
  }
  const targetOrder = [...without.slice(0, insertAt), activeId, ...without.slice(insertAt)]

  // No-op when nothing actually moved (same column, identical order).
  if (
    source.statusId === targetCol.statusId &&
    targetOrder.length === targetCol.itemIds.length &&
    targetOrder.every((id, i) => id === targetCol.itemIds[i])
  ) {
    return null
  }

  return {
    itemId: activeId,
    fromStatusId: source.statusId,
    toStatusId: targetCol.statusId,
    statusChanged: source.statusId !== targetCol.statusId,
    targetOrder,
  }
}

// Optimistic application: return a new items array reflecting the drop —
// the moved item's status_id updated and the item repositioned next to its
// new in-column neighbours so groupItemsByStatus renders the new order
// before the server round-trip resolves.
export function applyBoardDrop(items: ListItemDto[], plan: BoardDropPlan): ListItemDto[] {
  const moved = items.find((i) => i.id === plan.itemId)
  if (!moved) return items
  const updated: ListItemDto = { ...moved, status_id: plan.toStatusId }

  const rest = items.filter((i) => i.id !== plan.itemId)
  const pos = plan.targetOrder.indexOf(plan.itemId)
  const nextId = plan.targetOrder[pos + 1]
  const prevId = plan.targetOrder[pos - 1]

  if (nextId !== undefined) {
    const at = rest.findIndex((i) => i.id === nextId)
    if (at !== -1) return [...rest.slice(0, at), updated, ...rest.slice(at)]
  }
  if (prevId !== undefined) {
    const at = rest.findIndex((i) => i.id === prevId)
    if (at !== -1) return [...rest.slice(0, at + 1), updated, ...rest.slice(at + 1)]
  }
  // Only card in its column (no neighbours) — append.
  return [...rest, updated]
}

// The position PATCHes a drop implies: each target-column item mapped to
// its new index. The moved item additionally carries the status change, so
// the caller folds `statusId` into its patch. Callers may skip items whose
// position is unchanged; emitting all is harmless (idempotent PATCH).
export interface PositionPatch {
  id: string
  position: number
}

export function reindexPatches(plan: BoardDropPlan): PositionPatch[] {
  return plan.targetOrder.map((id, index) => ({ id, position: index }))
}
