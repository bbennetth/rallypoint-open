// Pure, display-only helpers for the Planner Brain Dump tab. Kept out of the
// React component so the merged-stream building (braindump + legacy diary +
// legacy notes), category resolution and the defensive AI-analysis decode are
// unit-testable (no React/DOM).

import type {
  BraindumpEntity,
  BraindumpEntryDto,
  DiaryEntryDto,
  FieldDefDto,
  NoteDto,
} from './api.js'
import { choiceLabel, isDayOnlyDueDate, ymdFromDueDate } from './diary-helpers.js'

// Labels of the auto-seeded fields (lockstep with the BFF constants in
// apps/planner-api/src/routes/braindump.ts).
export const CATEGORY_FIELD_LABEL = 'Category'
export const AI_ANALYSIS_FIELD_LABEL = 'AI Analysis'

export function findCategoryField(defs: readonly FieldDefDto[]): FieldDefDto | null {
  return (
    defs.find((d) => d.label === CATEGORY_FIELD_LABEL && d.fieldType === 'single_select') ?? null
  )
}

export function findAnalysisField(defs: readonly FieldDefDto[]): FieldDefDto | null {
  return defs.find((d) => d.label === AI_ANALYSIS_FIELD_LABEL && d.fieldType === 'text') ?? null
}

// The decoded per-entry AI metadata (versioned JSON stored in the AI
// Analysis text field — lockstep with encodeAiAnalysis in
// apps/planner-api/src/lib/braindump.ts).
export interface AiAnalysis {
  v: 1
  themes: string[]
  entities: BraindumpEntity[]
  summary: string | null
  model: string
}

const ENTITY_KINDS = ['person', 'place', 'topic'] as const

// Defensive decode: any malformed / wrong-version value → null (the entry
// renders un-analyzed and stays re-analyzable). Hand-rolled narrowing — no
// schema dependency in the web bundle.
export function decodeAiAnalysis(raw: unknown): AiAnalysis | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > 10000) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const o = parsed as Record<string, unknown>
  if (o['v'] !== 1) return null
  if (!Array.isArray(o['themes']) || !o['themes'].every((t) => typeof t === 'string')) return null
  if (!Array.isArray(o['entities'])) return null
  const entities: BraindumpEntity[] = []
  for (const e of o['entities']) {
    if (typeof e !== 'object' || e === null) return null
    const ent = e as Record<string, unknown>
    if (typeof ent['name'] !== 'string' || ent['name'] === '') return null
    if (!(ENTITY_KINDS as readonly string[]).includes(ent['kind'] as string)) return null
    entities.push({ name: ent['name'], kind: ent['kind'] as BraindumpEntity['kind'] })
  }
  const summary = o['summary']
  if (summary !== null && typeof summary !== 'string') return null
  if (typeof o['model'] !== 'string') return null
  return {
    v: 1,
    themes: o['themes'] as string[],
    entities,
    summary: (summary as string | null) ?? null,
    model: o['model'],
  }
}

// Encode for saving into the AI Analysis custom field (mirror of the BFF
// codec so a client-side save round-trips through decodeAiAnalysis).
export function encodeAiAnalysis(input: {
  themes: string[]
  entities: BraindumpEntity[]
  summary: string | null
  model: string
}): string {
  return JSON.stringify({ v: 1, ...input })
}

// --- merged stream ---------------------------------------------------
// The Brain Dump page shows braindump entries PLUS the user's legacy diary
// entries and notes in one stream (merged read — no data migration). Each
// row normalizes to this shape; `source` tags provenance so edits route back
// through the right save path.

export type StreamSource = 'braindump' | 'diary' | 'note'

export interface StreamEntry {
  /** `${source}:${id}` — unique across the merged sources. */
  key: string
  id: string
  source: StreamSource
  /** The owning list for braindump/diary rows; null for notes. */
  listId: string | null
  title: string
  body: string | null
  /** 'YYYY-MM-DD' anchor day ('' when undated). */
  day: string
  /** True when the entry carries a real time-of-day instant. */
  timed: boolean
  createdAt: string
  /** Resolved category label, or null (legacy rows are uncategorized). */
  category: string | null
  analysis: AiAnalysis | null
  /** Raw item for edit drawers (braindump/diary only). */
  raw: BraindumpEntryDto | NoteDto | null
}

export const UNCATEGORIZED = 'Uncategorized'

export function fromBraindumpItem(
  item: BraindumpEntryDto,
  categoryField: FieldDefDto | null,
  analysisField: FieldDefDto | null,
): StreamEntry {
  const categoryRaw = categoryField ? item.customFields[categoryField.id] : null
  const analysisRaw = analysisField ? item.customFields[analysisField.id] : null
  return {
    key: `braindump:${item.id}`,
    id: item.id,
    source: 'braindump',
    listId: item.listId,
    title: item.title,
    body: item.notes,
    day: ymdFromDueDate(item.dueDate),
    timed: !isDayOnlyDueDate(item.dueDate),
    createdAt: item.createdAt,
    category: choiceLabel(categoryField, categoryRaw),
    analysis: decodeAiAnalysis(analysisRaw),
    raw: item,
  }
}

export function fromDiaryItem(item: DiaryEntryDto): StreamEntry {
  return {
    key: `diary:${item.id}`,
    id: item.id,
    source: 'diary',
    listId: item.listId,
    title: item.title,
    body: item.notes,
    day: ymdFromDueDate(item.dueDate),
    timed: !isDayOnlyDueDate(item.dueDate),
    createdAt: item.createdAt,
    category: null,
    analysis: null,
    raw: item,
  }
}

export function fromNote(note: NoteDto): StreamEntry {
  return {
    key: `note:${note.id}`,
    id: note.id,
    source: 'note',
    listId: null,
    title: note.title,
    body: note.notes,
    day: note.createdAt.slice(0, 10),
    timed: false,
    createdAt: note.createdAt,
    category: null,
    analysis: null,
    raw: note,
  }
}

// Newest-first by day, undated rows sink, createdAt breaks ties within a day.
export function sortStream(entries: readonly StreamEntry[]): StreamEntry[] {
  return entries.slice().sort((a, b) => {
    if (a.day !== b.day) {
      if (!a.day) return 1
      if (!b.day) return -1
      return a.day < b.day ? 1 : -1
    }
    return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
  })
}

// Build the merged, sorted stream from the three cached reads.
export function buildStream(
  braindump: readonly BraindumpEntryDto[],
  diary: readonly DiaryEntryDto[],
  notes: readonly NoteDto[],
  categoryField: FieldDefDto | null,
  analysisField: FieldDefDto | null,
): StreamEntry[] {
  return sortStream([
    ...braindump.map((i) => fromBraindumpItem(i, categoryField, analysisField)),
    ...diary.map(fromDiaryItem),
    ...notes.map(fromNote),
  ])
}

// Filter by a category chip. `null` = All; UNCATEGORIZED matches rows with
// no resolved category (all legacy diary/notes rows plus unanalyzed dumps).
export function filterByCategory(
  entries: readonly StreamEntry[],
  category: string | null,
): StreamEntry[] {
  if (category === null) return entries.slice()
  if (category === UNCATEGORIZED) return entries.filter((e) => e.category === null)
  return entries.filter((e) => e.category === category)
}

// The category chips worth rendering: every category present in the stream
// (stream order preserved per first occurrence), plus UNCATEGORIZED when any
// row lacks one. Empty stream → no chips.
export function categoriesInStream(entries: readonly StreamEntry[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  let uncategorized = false
  for (const e of entries) {
    if (e.category === null) {
      uncategorized = true
      continue
    }
    if (seen.has(e.category)) continue
    seen.add(e.category)
    out.push(e.category)
  }
  if (uncategorized && out.length > 0) out.push(UNCATEGORIZED)
  return out
}
