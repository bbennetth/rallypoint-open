// Saved-view config for Rallypoint Lists v2 (slice 5). A saved view is a
// named bundle of the slice-4 filter/sort plus which columns are visible
// and which view mode (list/grid) to render. Both apps/lists-api (stores
// the blob, validates its wire shape) and apps/lists-web (applies it to
// the FilterSortBar / column set) agree on this. No PG — sibling to
// list-query.ts/custom-fields.ts, unit-tested in isolation.
//
// The config is intentionally TOLERANT of staleness: a filter/sort that
// names a since-deleted field, or a visibleColumns entry for a dropped
// field, stays in the stored blob and is resolved/dropped at APPLY time
// (via validateListQuery + the live def set), mirroring slice 4. So this
// module only asserts the structural wire shape, never field existence.

import { z } from 'zod'
import { FILTER_OPS } from './list-query.js'
import type { FilterSpec, SortSpec } from './list-query.js'

export const VIEW_MODES = ['list', 'grid'] as const
export const viewModeField = z.enum(VIEW_MODES)
export type ViewMode = (typeof VIEW_MODES)[number]

export interface ViewConfig {
  filters: FilterSpec[]
  sort: SortSpec[]
  visibleColumns: string[]
  viewMode: ViewMode
}

// Structural shape of a single stored filter spec. `field` is any bounded
// string (a built-in column name or a custom def id) — existence is NOT
// checked here, only at apply time. `op` must be a known operator; value
// is the raw string (absent only for the value-less is_empty).
const storedFilterSchema = z.object({
  field: z.string().trim().min(1).max(64),
  op: z.enum(FILTER_OPS),
  value: z.string().max(500).optional(),
})

const storedSortSchema = z.object({
  field: z.string().trim().min(1).max(64),
  dir: z.enum(['asc', 'desc']),
})

// The view config blob. Every key optional on the wire; missing keys fill
// in as empty/list so a partial config still round-trips to a full
// ViewConfig. Bounded to keep a saved view from growing unboundedly.
export const viewConfigField = z
  .object({
    filters: z.array(storedFilterSchema).max(50).optional(),
    sort: z.array(storedSortSchema).max(20).optional(),
    visibleColumns: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
    viewMode: viewModeField.optional(),
  })
  .transform(
    (c): ViewConfig => ({
      filters: (c.filters ?? []) as FilterSpec[],
      sort: (c.sort ?? []) as SortSpec[],
      visibleColumns: c.visibleColumns ?? [],
      viewMode: c.viewMode ?? 'list',
    }),
  )

// Coerce an unknown stored/incoming blob into a full ViewConfig, dropping
// anything that doesn't fit the structural shape. Used when reading a
// stored config back (an older blob may predate a key) and when accepting
// one on the wire. Never throws — a wholly-malformed blob yields the empty
// default config.
export function normalizeViewConfig(raw: unknown): ViewConfig {
  const parsed = viewConfigField.safeParse(raw ?? {})
  if (parsed.success) return parsed.data
  return { filters: [], sort: [], visibleColumns: [], viewMode: 'list' }
}
