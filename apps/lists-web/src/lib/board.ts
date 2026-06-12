// Kanban board grouping (RPL v1.0.0 S2). Pure: maps a tasks list's items
// onto its custom-status columns, keeping pre-S1 rows visible.
//
// An item lands in a column by, in order:
//   1. its `status_id`, when that id is one of the list's live statuses;
//   2. otherwise its legacy `status` category (todo|in_progress|done) →
//      that category's representative status (lowest position), so a row
//      that predates S1 (status_id null) or points at a since-deleted
//      status still shows up;
//   3. otherwise the first status by position (a never-empty fallback).
// Column order follows status `position`; item order within a column is
// preserved from the input (already server-ordered).

import { defaultStatusForCategory, type StatusCategory } from '@rallypoint/lists-shared'
import type { ListItemDto, ListStatusDto } from './api.js'

export interface BoardColumn {
  status: ListStatusDto
  items: ListItemDto[]
}

// The status an item belongs to. Exposed for the card chip, which needs
// the resolved status (category drives the done strikethrough) even though
// the board already grouped the item.
export function resolveItemStatus(
  item: ListItemDto,
  statuses: readonly ListStatusDto[],
): ListStatusDto | null {
  if (statuses.length === 0) return null
  if (item.status_id) {
    const direct = statuses.find((s) => s.id === item.status_id)
    if (direct) return direct
  }
  const category = (item.status ?? 'todo') as StatusCategory
  const byCategory = defaultStatusForCategory(statuses, category)
  if (byCategory) return byCategory
  return statuses.slice().sort((a, b) => a.position - b.position)[0] ?? null
}

export function groupItemsByStatus(
  items: readonly ListItemDto[],
  statuses: readonly ListStatusDto[],
): BoardColumn[] {
  const ordered = statuses.slice().sort((a, b) => a.position - b.position)
  const columns = new Map<string, BoardColumn>()
  for (const status of ordered) columns.set(status.id, { status, items: [] })

  for (const item of items) {
    const status = resolveItemStatus(item, ordered)
    if (status) columns.get(status.id)?.items.push(item)
  }
  return ordered.map((s) => columns.get(s.id)!)
}
