// Pure helpers for the Lists v2 field-manager UI. They translate field
// definitions into display labels, surface the live (non-archived)
// select choices, and plan a reorder swap — all without touching the
// network, so they're unit-tested in isolation. The drawer component
// wires these to the API.

import { isEmptyValue, isSelectFieldType, type FieldType } from '@rallypoint/lists-shared'
import type { FieldDefDto } from './api.js'
import type { SelectChoice } from '@rallypoint/lists-shared'

// Human-readable labels for the type picker and the read-only type tag
// on existing fields (field_type is immutable after creation).
const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  checkbox: 'Checkbox',
  single_select: 'Single select',
  multi_select: 'Multi-select',
  person: 'Person',
  url: 'URL',
}

export function fieldTypeLabel(type: FieldType): string {
  return FIELD_TYPE_LABELS[type] ?? type
}

// Whether this field type manages a list of choices (the option editor
// only renders for these). Re-exported from the shared predicate so the
// component imports a single module.
export function fieldTypeHasChoices(type: FieldType): boolean {
  return isSelectFieldType(type)
}

// The choices a user should see/edit: archived choices are kept in the
// stored array (so historical values still resolve a label) but hidden
// from the management list.
export function activeChoices(def: Pick<FieldDefDto, 'options'>): SelectChoice[] {
  return (def.options.choices ?? []).filter((c) => !c.archived)
}

// The current value of a multi-select field as a string[] of choice ids.
// Tolerates the absent/non-array stored shape (returns []), so the editor
// can render before any value is set.
export function multiValue(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

// Toggle a choice id in a multi-select value, preserving the order of the
// other selections. Returns a new array (clears the id when present, else
// appends it) so the editor can PATCH the whole array.
export function toggleSelection(current: readonly string[], id: string): string[] {
  return current.includes(id) ? current.filter((v) => v !== id) : [...current, id]
}

// The ids of required fields whose value is still unset, using the shared
// isEmptyValue rule the server enforces in validateCustomFields (absent /
// null / '' / empty multi-select array; a `false` checkbox counts as set).
// The add form gates its submit button on this so it can't POST a payload
// the API would reject for a missing required field.
export function missingRequiredFieldIds(
  defs: readonly Pick<FieldDefDto, 'id' | 'required'>[],
  values: Record<string, unknown>,
): string[] {
  return defs.filter((d) => d.required && isEmptyValue(values[d.id])).map((d) => d.id)
}

// Plan a one-step reorder: swap the target field's position with its
// neighbour in the given direction. Returns the two `{ id, position }`
// patches to PATCH, or null when the move runs off either end. Mirrors
// the item-row swap in ListDetailPage so ordering stays well-defined.
export function planFieldReorder(
  defs: readonly Pick<FieldDefDto, 'id' | 'position'>[],
  index: number,
  dir: -1 | 1,
): [{ id: string; position: number }, { id: string; position: number }] | null {
  const cur = defs[index]
  const other = defs[index + dir]
  if (!cur || !other) return null
  return [
    { id: cur.id, position: other.position },
    { id: other.id, position: cur.position },
  ]
}
