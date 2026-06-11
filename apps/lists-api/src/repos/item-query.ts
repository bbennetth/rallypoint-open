import {
  compareForSort,
  evalFilter,
  type ValidatedFilter,
  type ValidatedSort,
} from '@rallypoint/lists-shared'
import type { ListItemRecord } from './types.js'

// In-memory filter & sort for list items (Lists v2 slice 4), shared by
// the memory repo. The pg repo translates the same validated specs to
// SQL instead; both must agree on the semantics in @rallypoint/lists-shared.
// Specs arrive pre-validated (their `resolved.kind` is trusted), so this
// only resolves a row's value per field and defers to the shared
// predicates.

// The value of a built-in column on a row, in the same shape the shared
// predicates expect (dates as ISO strings, like the wire form).
function builtinValue(rec: ListItemRecord, field: string): unknown {
  switch (field) {
    case 'title':
      return rec.title
    case 'notes':
      return rec.notes
    case 'assigned_to':
      return rec.assignedTo
    case 'completed':
      return rec.completed
    case 'status':
      return rec.status
    case 'priority':
      return rec.priority
    case 'due_date':
      return rec.dueDate ? rec.dueDate.toISOString() : null
    case 'position':
      return rec.position
    case 'created_at':
      return rec.createdAt.toISOString()
    default:
      return null
  }
}

function fieldValue(rec: ListItemRecord, resolved: ValidatedFilter['resolved']): unknown {
  return resolved.source === 'builtin'
    ? builtinValue(rec, resolved.field)
    : rec.customFields[resolved.field]
}

// Keep only rows that satisfy every filter (AND across filters).
export function applyItemFilters(
  rows: ListItemRecord[],
  filters: ValidatedFilter[],
): ListItemRecord[] {
  if (filters.length === 0) return rows
  return rows.filter((rec) =>
    filters.every((f) => evalFilter(f.resolved.kind, f.op, fieldValue(rec, f.resolved), f.value)),
  )
}

// Sort by the requested specs in order; ties (and the no-sort case) fall
// through to the caller's stable (position, createdAt, id) order, so this
// only needs to break ties the field sorts leave. Returns a new array.
export function applyItemSort(rows: ListItemRecord[], sort: ValidatedSort[]): ListItemRecord[] {
  if (sort.length === 0) return rows
  return [...rows].sort((a, b) => {
    for (const s of sort) {
      const c = compareForSort(
        s.resolved.kind,
        fieldValue(a, s.resolved),
        fieldValue(b, s.resolved),
        s.dir,
      )
      if (c !== 0) return c
    }
    return 0
  })
}
