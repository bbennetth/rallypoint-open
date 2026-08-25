import { z } from 'zod'

// Generic list transfer bundle: everything one list contains, in a shape that
// can be written back into a DIFFERENT scope (another user's personal group,
// another group) without carrying any row ids across.
//
// This is a Lists capability, not a Planner one. Planner composes it — per the
// SDK-first rule, planner-api owns no domain tables and no domain rules, so the
// knowledge of what a list is made of lives here, next to the rules that
// enforce it.
//
// Nothing in a bundle is a row id. Cross-row pointers travel as:
//   - items/series: `ref` (the existing offline-create idempotency key, which
//     the create path already dedupes on — so re-importing is a no-op).
//   - parents: `parentRef`, resolved after every item exists.
//   - statuses/labels/field defs: matched by NAME or KEY on the target list,
//     because those are per-list rows whose ids differ everywhere.
// A custom-field map is keyed by field-def id, so it is re-keyed to the target
// list's def ids on import.
//
// ONE deliberate boundary: items materialised from a recurrence series are NOT
// carried in `items`. Importing the series re-projects its occurrences, so
// shipping them as items too would create a second copy of every one. The
// schedule survives a restore; per-occurrence history (which past chores were
// ticked off) does not.

// The app-level import-result contract is generic; re-exported here so a web
// app gets it from a package it already depends on.
export type { ImportCounts, ImportSummary, ImportWarning } from '@rallypoint/shared'

const shortText = z.string().max(500)
const longText = z.string().max(20_000)
const ref = z.string().min(1).max(128)

export const listFieldDefBundleSchema = z.object({
  /** The SOURCE list's def id. Carried only so an item's customFields map —
   *  which is keyed by def id — can be joined back to a `key` and re-keyed onto
   *  the target list's def ids. Never written to the target. */
  sourceId: shortText,
  key: shortText,
  label: shortText,
  fieldType: shortText,
  options: z.unknown().nullable().optional(),
  required: z.boolean().optional(),
  defaultValue: z.unknown().nullable().optional(),
  position: z.number().int().optional(),
})

export const listStatusBundleSchema = z.object({
  name: shortText,
  color: shortText.nullable().optional(),
  category: shortText,
  position: z.number().int().optional(),
})

export const listLabelBundleSchema = z.object({
  name: shortText,
  color: shortText.nullable().optional(),
  position: z.number().int().optional(),
})

export const listSeriesBundleSchema = z.object({
  ref,
  title: shortText,
  notes: longText.nullable().optional(),
  assignedTo: shortText.nullable().optional(),
  priority: shortText.nullable().optional(),
  freq: shortText,
  interval: z.number().int(),
  byDay: z.array(shortText).max(7).nullable().optional(),
  dtstart: shortText,
  until: shortText.nullable().optional(),
  count: z.number().int().nullable().optional(),
  timeOfDay: shortText.nullable().optional(),
})

export const listItemBundleSchema = z.object({
  ref,
  title: shortText,
  notes: longText.nullable().optional(),
  assignedTo: shortText.nullable().optional(),
  priority: shortText.nullable().optional(),
  dueDate: shortText.nullable().optional(),
  completed: z.boolean().optional(),
  completedAt: shortText.nullable().optional(),
  position: z.number().int().optional(),
  /** Parent item's ref (one level of nesting). Resolved in a second pass. */
  parentRef: ref.nullable().optional(),
  /** Status NAME on the source list, matched by name on the target. */
  statusName: shortText.nullable().optional(),
  /** Label NAMES on the source list, matched by name on the target. */
  labelNames: z.array(shortText).max(64).optional(),
  /** Keyed by the SOURCE list's field-def ids; re-keyed on import. */
  customFields: z.record(z.unknown()).optional(),
  comments: z.array(z.object({ body: longText })).max(200).optional(),
})

export const listBundleSchema = z.object({
  listType: shortText,
  name: shortText,
  visibility: shortText,
  color: shortText.nullable().optional(),
  fieldDefs: z.array(listFieldDefBundleSchema).max(200).default([]),
  statuses: z.array(listStatusBundleSchema).max(200).default([]),
  labels: z.array(listLabelBundleSchema).max(200).default([]),
  series: z.array(listSeriesBundleSchema).max(2000).default([]),
  items: z.array(listItemBundleSchema).max(50_000).default([]),
})

export type ListFieldDefBundle = z.infer<typeof listFieldDefBundleSchema>
export type ListStatusBundle = z.infer<typeof listStatusBundleSchema>
export type ListLabelBundle = z.infer<typeof listLabelBundleSchema>
export type ListSeriesBundle = z.infer<typeof listSeriesBundleSchema>
export type ListItemBundle = z.infer<typeof listItemBundleSchema>
export type ListBundle = z.infer<typeof listBundleSchema>

/** Outcome of importing one bundle. `skipped` counts rows that were already
 *  present — the normal result of re-running the same archive. */
export interface ListImportResult {
  listId: string
  listCreated: boolean
  fieldDefs: { created: number; skipped: number }
  statuses: { created: number; skipped: number }
  labels: { created: number; skipped: number }
  series: { created: number; skipped: number }
  items: { created: number; skipped: number }
  comments: { created: number; skipped: number }
  warnings: { code: string; message: string; ref?: string }[]
}
