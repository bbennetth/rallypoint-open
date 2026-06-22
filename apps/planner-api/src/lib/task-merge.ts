import type {
  CreateFieldDefInput,
  CreateListItemInput,
  CreateSeriesInput,
  FieldDefDto,
  ListItemDto,
  ListItemSeriesDto,
} from '@rallypoint/lists-client'

// Pure merge-decision helpers for folding a user's extra personal task
// lists into the single canonical Tasks list (issue #543). All side effects
// (read/create/delete via the Lists SDK) live in personal-scope.ts'
// mergeTaskListsInto orchestrator; the decisions it makes — which field defs
// to reuse vs. create, how to rewrite an item's customFields keys, how to
// rebuild a series rule — are extracted here so every branch is unit-tested
// against the SDK DTO shapes without a transport round-trip.

// A stable identity for a custom-field definition: two defs that share a
// (label, fieldType) pair are treated as "the same field" when unifying a
// source list's schema into the canonical list. Label is the user-facing
// name; fieldType is immutable post-create, so this pair is a safe key.
// Labels are compared case-insensitively and whitespace-trimmed so trivial
// formatting differences across lists don't spawn duplicate canonical defs.
export function fieldDefKey(def: { label: string; fieldType: string }): string {
  return `${def.fieldType}::${def.label.trim().toLowerCase()}`
}

// Map a source list's `select`-type choices to the CreateFieldDefInput
// shape (label-only — the canonical list mints fresh option ids). Returns
// undefined for non-select types so the caller can spread conditionally.
function choicesFor(def: FieldDefDto): { label: string }[] | undefined {
  if (def.fieldType !== 'single_select' && def.fieldType !== 'multi_select') return undefined
  const choices = def.options?.choices ?? []
  return choices
    .filter((ch) => !ch.archived)
    .map((ch) => ({ label: ch.label }))
}

// Derive the CreateFieldDefInput needed to reproduce a source field def in
// the canonical list. Mirrors the user-facing inputs the Lists field-def
// create surface accepts (label, type, choices, required, multiline) — the
// server derives the key and mints option ids, so neither is carried over.
export function fieldDefCreateInput(def: FieldDefDto): CreateFieldDefInput {
  const choices = choicesFor(def)
  // Only carry multiline when it's actually on — a plain text field omits it
  // (passing multiline:false is noise the create surface doesn't need).
  const multiline = def.fieldType === 'text' && def.options?.multiline === true
  return {
    label: def.label,
    fieldType: def.fieldType,
    required: def.required,
    ...(choices !== undefined ? { choices } : {}),
    ...(multiline ? { multiline: true } : {}),
  }
}

// Build the old-def-id → canonical-def-id remap for one source list.
// `canonicalDefs` is the canonical list's CURRENT defs (including any just
// created this run); `sourceDefs` are the defs on the list being folded in.
// A source def reuses a canonical def with a matching (label, type) key;
// `toCreate` lists the source defs that have no canonical match yet (the
// orchestrator creates them, then re-runs this with the enlarged canonical
// set to obtain the final remap). Pure — no I/O.
export interface FieldDefPlan {
  // Source defs that must be created in the canonical list (no match yet).
  toCreate: FieldDefDto[]
  // Resolved old-id → canonical-id remap for source defs that DID match.
  remap: Map<string, string>
}

export function planFieldDefs(
  sourceDefs: FieldDefDto[],
  canonicalDefs: FieldDefDto[],
): FieldDefPlan {
  const canonicalByKey = new Map<string, FieldDefDto>()
  for (const def of canonicalDefs) {
    // First write wins on the unlikely duplicate (oldest canonical def),
    // mirroring the oldest-wins resolution used elsewhere in personal-scope.
    if (!canonicalByKey.has(fieldDefKey(def))) canonicalByKey.set(fieldDefKey(def), def)
  }
  const toCreate: FieldDefDto[] = []
  const remap = new Map<string, string>()
  for (const src of sourceDefs) {
    const match = canonicalByKey.get(fieldDefKey(src))
    if (match) remap.set(src.id, match.id)
    else toCreate.push(src)
  }
  return { toCreate, remap }
}

// Rewrite an item's customFields object, translating every source field-def
// id key through `remap` to the canonical def id. A key absent from the
// remap (e.g. a reserved system key like `rp:category`, or a value whose def
// could not be resolved) is dropped — carrying an unknown def id into the
// canonical list would fail the server's validateCustomFields. Returns a
// fresh object; never mutates the input.
export function remapCustomFields(
  customFields: Record<string, unknown>,
  remap: Map<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(customFields)) {
    const mapped = remap.get(key)
    if (mapped !== undefined) out[mapped] = value
  }
  return out
}

// Derive the CreateListItemInput that reproduces a one-off (non-series)
// source item in the canonical list, given the source→canonical field-def
// `remap`. Preserves title, notes, status, priority, due date, and the
// remapped custom fields. `seriesId` is intentionally NOT carried — series
// are rebuilt separately (see seriesCreateInput); a one-off item has a null
// seriesId anyway.
//
// Status is carried verbatim ('todo' | 'in_progress' | 'done') when the
// source item has one — items created in the Lists UI can be 'in_progress'.
// For items that only carry the boolean `completed` (Planner-native tasks),
// fall back to mapping it onto 'done'/'todo'. The Lists item create surface
// derives the boolean `completed` column from the status category; there is
// no direct `completed` field on CreateListItemSchema.
export function itemCreateInput(
  item: ListItemDto,
  remap: Map<string, string>,
): CreateListItemInput {
  const customFields = remapCustomFields(item.customFields, remap)
  return {
    title: item.title,
    notes: item.notes,
    assignedTo: item.assignedTo,
    status: item.status ?? (item.completed ? 'done' : 'todo'),
    priority: item.priority,
    dueDate: item.dueDate,
    ...(Object.keys(customFields).length > 0 ? { customFields } : {}),
  }
}

// Derive the CreateSeriesInput that reproduces a source recurring series in
// the canonical list. Carries the full recurrence rule + the template fields
// (title/notes/assignedTo/priority) so the rebuilt series materializes the
// same occurrences going forward. byDay is only meaningful for weekly series;
// an empty array would fail the server's min(1) guard, so it is dropped.
export function seriesCreateInput(series: ListItemSeriesDto): CreateSeriesInput {
  const byDay = series.byDay && series.byDay.length > 0 ? series.byDay : undefined
  return {
    title: series.title,
    notes: series.notes,
    assignedTo: series.assignedTo,
    ...(series.priority != null
      ? { priority: series.priority as CreateSeriesInput['priority'] }
      : {}),
    freq: series.freq,
    interval: series.interval,
    ...(byDay !== undefined ? { byDay } : {}),
    dtstart: series.dtstart,
    ...(series.until != null ? { until: series.until } : {}),
    ...(series.count != null ? { count: series.count } : {}),
    ...(series.timeOfDay != null ? { timeOfDay: series.timeOfDay } : {}),
  }
}
