// Pure label helpers (RPL v1.0.0 S12 UI). Resolve an item's attached label
// ids against the list's labels (for chip rendering) and toggle membership.

import type { LabelDto } from './api.js'

// The labels an item carries, in the list's label order, dropping any id
// that no longer resolves (e.g. a label deleted after the item loaded).
export function resolveLabels(
  labelIds: readonly string[],
  labels: readonly LabelDto[],
): LabelDto[] {
  const attached = new Set(labelIds)
  return labels.filter((l) => attached.has(l.id)).sort((a, b) => a.position - b.position)
}

// Add the id if absent, remove it if present — a new array either way.
export function toggleLabelId(labelIds: readonly string[], id: string): string[] {
  return labelIds.includes(id) ? labelIds.filter((x) => x !== id) : [...labelIds, id]
}
