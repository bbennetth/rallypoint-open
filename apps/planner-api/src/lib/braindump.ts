import { z } from 'zod'
import { localAnchor, wallClockToInstant } from '@rallypoint/shared'
import { extractFirstJsonObject } from '@rallypoint/ai'
import { ASSIST_MODEL } from './assist.js'

// Brain Dump — pure logic for the enrich + summary endpoints. The route
// (routes/braindump.ts) owns the Workers AI calls + tracing; everything here
// is deterministic and unit-tested: prompt building (with a tz-resolved
// "today" anchor), defensive parsing of the model's JSON, coercion of the raw
// shapes into the contracts the client saves from, and the versioned codec
// for the AI Analysis custom-field value.
//
// Enrichment is STATELESS composition (assist.ts pattern): the endpoint
// returns {category, themes, entities, summary, taskSuggestions,
// eventSuggestions} and saves nothing — the client writes the entry through
// the generic list-item create with customFields prefilled, so the offline
// outbox stays intact and no domain rule moves into this thin BFF.

export const BRAINDUMP_MODEL = ASSIST_MODEL
export const BRAINDUMP_ENRICH_MAX_TOKENS = 1024
export const BRAINDUMP_SUMMARY_MAX_TOKENS = 768

// The fixed category vocabulary, seeded as single_select choices on the
// brain-dump list's Category field. The AI picks one; the user can
// recategorize freely (values reference stable server-minted choice ids, so
// renames are safe). Order is the seeded choice order.
export const BRAINDUMP_CATEGORIES = [
  'Ideas',
  'Feelings',
  'Work',
  'Health',
  'People',
  'Plans',
  'Journal',
  'Reference',
  'Other',
] as const
export type BraindumpCategory = (typeof BRAINDUMP_CATEGORIES)[number]

export const ENTITY_KINDS = ['person', 'place', 'topic'] as const
export type EntityKind = (typeof ENTITY_KINDS)[number]

// Coercion bounds — clamped, never 422s, so one odd model value can't sink
// the whole enrichment.
export const MAX_THEMES = 10
export const MAX_ENTITIES = 15
export const MAX_ANALYSIS_SUMMARY = 500
export const MAX_SUGGESTED_TASKS = 5
export const MAX_SUGGESTED_EVENTS = 5

// --- request contracts -----------------------------------------------

// `clientNow`/`tz` anchor relative dates in the dump ("call Sam tomorrow"),
// mirroring AssistRequestSchema. The text cap is larger than assist's 500 —
// a brain dump is a paragraph, not a one-liner — but still bounded so an
// authenticated caller can't push unbounded prompts at Workers AI.
export const EnrichRequestSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, 'Dump something first.')
    .max(4000, 'Keep a single dump under 4000 characters.'),
  clientNow: z.string().datetime({ offset: true }),
  tz: z.string().trim().min(1).max(64),
})
export type EnrichRequest = z.infer<typeof EnrichRequestSchema>

// One entry of the client-sent corpus for a range summary. The client trims
// bodies before sending (selectEntriesForSummary); these server caps are the
// hard backstop.
const SummaryEntrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  category: z.string().trim().max(40).nullable(),
  text: z.string().trim().min(1).max(1000),
})

export const MAX_SUMMARY_ENTRIES = 50
export const MAX_SUMMARY_TOTAL_CHARS = 15000

export const SummaryRequestSchema = z
  .object({
    entries: z.array(SummaryEntrySchema).min(1).max(MAX_SUMMARY_ENTRIES),
  })
  .refine(
    (v) => v.entries.reduce((n, e) => n + e.text.length, 0) <= MAX_SUMMARY_TOTAL_CHARS,
    { message: 'Too much text for one summary — narrow the date range.' },
  )
export type SummaryRequest = z.infer<typeof SummaryRequestSchema>

// --- raw model output ------------------------------------------------
// Permissive shapes (unions-with-null, plain strings); coercion tightens.

const RawEntitySchema = z.object({
  name: z.string(),
  kind: z.union([z.string(), z.null()]).optional(),
})

const RawTaskSchema = z.object({
  title: z.string(),
  date: z.union([z.string(), z.null()]).optional(),
  time: z.union([z.string(), z.null()]).optional(),
})

const RawEventSchema = z.object({
  title: z.string(),
  date: z.union([z.string(), z.null()]).optional(),
  time: z.union([z.string(), z.null()]).optional(),
  durationMinutes: z.union([z.number(), z.null()]).optional(),
})

const RawEnrichSchema = z.object({
  category: z.string(),
  title: z.string(),
  themes: z.union([z.array(z.string()).max(30), z.null()]).optional(),
  entities: z.union([z.array(RawEntitySchema).max(40), z.null()]).optional(),
  summary: z.union([z.string(), z.null()]).optional(),
  tasks: z.union([z.array(RawTaskSchema).max(20), z.null()]).optional(),
  events: z.union([z.array(RawEventSchema).max(20), z.null()]).optional(),
})
export type RawEnrich = z.infer<typeof RawEnrichSchema>

const RawSummarySchema = z.object({
  summary: z.string(),
  highlights: z.union([z.array(z.string()).max(20), z.null()]).optional(),
  moodTrend: z.union([z.string(), z.null()]).optional(),
})
export type RawSummary = z.infer<typeof RawSummarySchema>

// --- response contracts ----------------------------------------------

export const EntitySchema = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(ENTITY_KINDS),
})
export type BraindumpEntity = z.infer<typeof EntitySchema>

// A suggested to-do extracted from the dump. dueDate is day-only
// 'YYYY-MM-DD' or a full ISO instant (timed), mirroring AssistSuggestion.
export const TaskSuggestionSchema = z.object({
  title: z.string().min(1).max(100),
  dueDate: z.string().nullable(),
})
export type TaskSuggestion = z.infer<typeof TaskSuggestionSchema>

export const EventSuggestionSchema = z.object({
  title: z.string().min(1).max(100),
  startAt: z.string().nullable(),
  endAt: z.string().nullable(),
  allDay: z.boolean(),
})
export type EventSuggestion = z.infer<typeof EventSuggestionSchema>

export const EnrichmentSchema = z.object({
  category: z.enum(BRAINDUMP_CATEGORIES),
  title: z.string().min(1).max(100),
  themes: z.array(z.string().min(1).max(40)).max(MAX_THEMES),
  entities: z.array(EntitySchema).max(MAX_ENTITIES),
  summary: z.string().max(MAX_ANALYSIS_SUMMARY).nullable(),
  taskSuggestions: z.array(TaskSuggestionSchema).max(MAX_SUGGESTED_TASKS),
  eventSuggestions: z.array(EventSuggestionSchema).max(MAX_SUGGESTED_EVENTS),
})
export type Enrichment = z.infer<typeof EnrichmentSchema>

// The full responses also carry trace ids so the client can echo feedback.
export interface EnrichResponse extends Enrichment {
  traceId: string
  responseId: string
}

export const RangeSummarySchema = z.object({
  summary: z.string().min(1).max(2000),
  highlights: z.array(z.string().min(1).max(200)).max(8),
  moodTrend: z.string().max(300).nullable(),
})
export type RangeSummary = z.infer<typeof RangeSummarySchema>

export interface SummaryResponse extends RangeSummary {
  traceId: string
  responseId: string
}

// --- AI Analysis custom-field codec ----------------------------------
// The per-entry AI metadata is stored as a JSON string in a text custom
// field ("AI Analysis") on the brain-dump list — no new storage primitive.
// Versioned so a future shape change can migrate lazily on read.

export const AI_ANALYSIS_VERSION = 1

export interface AiAnalysis {
  v: number
  themes: string[]
  entities: BraindumpEntity[]
  summary: string | null
  model: string
}

export function encodeAiAnalysis(input: {
  themes: string[]
  entities: BraindumpEntity[]
  summary: string | null
  model: string
}): string {
  const value: AiAnalysis = { v: AI_ANALYSIS_VERSION, ...input }
  return JSON.stringify(value)
}

// Defensive decode: any malformed / wrong-version / oversized value → null
// (the entry just renders un-analyzed; a re-Analyze overwrites it).
export function decodeAiAnalysis(raw: unknown): AiAnalysis | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > 10000) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const schema = z.object({
    v: z.literal(AI_ANALYSIS_VERSION),
    themes: z.array(z.string().min(1).max(40)).max(MAX_THEMES),
    entities: z.array(EntitySchema).max(MAX_ENTITIES),
    summary: z.string().max(MAX_ANALYSIS_SUMMARY).nullable(),
    model: z.string().max(120),
  })
  const result = schema.safeParse(parsed)
  return result.success ? result.data : null
}

// --- prompts ---------------------------------------------------------

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/
const HM_RE = /^\d{2}:\d{2}$/

// Deliberately terse (prefill tokens are latency on Workers AI).
export function enrichSystemPrompt(clientNow: string, tz: string): string {
  const { date, time, weekday } = localAnchor(clientNow, tz)
  return `\
Analyze one free-form "brain dump" the user wrote. Local now:
${weekday} ${date} ${time} (${tz}); resolve relative dates against it.
Pick ONE category: ${BRAINDUMP_CATEGORIES.join(', ')}.
Extract recurring themes (1-3 word topics), named entities
(kind: person, place or topic), a 1-2 sentence summary, and any concrete
actionable to-dos (tasks) or appointments at a date/time (events) the text
commits to — only real commitments, not musings.
Respond with ONLY this JSON:
{"category":"...","title":"short heading for the dump",
"themes":["..."],"entities":[{"name":"...","kind":"person|place|topic"}],
"summary":"1-2 sentences or null",
"tasks":[{"title":"...","date":"YYYY-MM-DD or null","time":"HH:MM or null"}],
"events":[{"title":"...","date":"YYYY-MM-DD or null","time":"HH:MM or null",
"durationMinutes":number or null}]}
Empty arrays when nothing applies. Use null, not omission. No prose, no code
fences.`
}

export function buildEnrichInput(
  text: string,
  clientNow: string,
  tz: string,
): Record<string, unknown> {
  return {
    messages: [
      { role: 'system', content: enrichSystemPrompt(clientNow, tz) },
      { role: 'user', content: text },
    ],
    max_tokens: BRAINDUMP_ENRICH_MAX_TOKENS,
    response_format: {
      type: 'json_schema',
      json_schema: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: [...BRAINDUMP_CATEGORIES] },
          title: { type: 'string' },
          themes: { type: 'array', items: { type: 'string' } },
          entities: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                kind: { type: 'string', enum: [...ENTITY_KINDS] },
              },
              required: ['name', 'kind'],
            },
          },
          summary: { type: ['string', 'null'] },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                date: { type: ['string', 'null'] },
                time: { type: ['string', 'null'] },
              },
              required: ['title'],
            },
          },
          events: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                date: { type: ['string', 'null'] },
                time: { type: ['string', 'null'] },
                durationMinutes: { type: ['number', 'null'] },
              },
              required: ['title'],
            },
          },
        },
        required: ['category', 'title', 'themes', 'entities', 'tasks', 'events'],
      },
    },
  }
}

export function summarySystemPrompt(): string {
  return `\
Summarize a set of dated "brain dump" journal entries the user wrote.
Write for the user ("you..."), warm but concrete. Respond with ONLY this
JSON:
{"summary":"3-5 sentence overview of the period",
"highlights":["up to 5 short notable points"],
"moodTrend":"one sentence on how the tone/mood moved across the period, or
null if unclear"}
Use null, not omission. No prose, no code fences.`
}

export function buildSummaryInput(entries: SummaryRequest['entries']): Record<string, unknown> {
  const corpus = entries
    .map((e) => `${e.date}${e.category ? ` [${e.category}]` : ''}: ${e.text}`)
    .join('\n')
  return {
    messages: [
      { role: 'system', content: summarySystemPrompt() },
      { role: 'user', content: corpus },
    ],
    max_tokens: BRAINDUMP_SUMMARY_MAX_TOKENS,
    response_format: {
      type: 'json_schema',
      json_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          highlights: { type: 'array', items: { type: 'string' } },
          moodTrend: { type: ['string', 'null'] },
        },
        required: ['summary', 'highlights'],
      },
    },
  }
}

// --- parsing ---------------------------------------------------------

// Shared recovery: accept an already-parsed object or a raw text reply
// (stray prose / code fences recovered via the balanced-brace extractor).
function parseRaw<T>(raw: unknown, schema: z.ZodType<T>): T | null {
  let candidate: unknown = raw
  if (typeof raw === 'string') {
    const json = extractFirstJsonObject(raw)
    if (json === null) return null
    try {
      candidate = JSON.parse(json)
    } catch {
      return null
    }
  }
  const parsed = schema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

export function parseEnrichOutput(raw: unknown): RawEnrich | null {
  return parseRaw(raw, RawEnrichSchema)
}

export function parseSummaryOutput(raw: unknown): RawSummary | null {
  return parseRaw(raw, RawSummarySchema)
}

// --- coercion --------------------------------------------------------

function normalizeCategory(value: string): BraindumpCategory {
  const v = value.trim().toLowerCase()
  const hit = BRAINDUMP_CATEGORIES.find((c) => c.toLowerCase() === v)
  return hit ?? 'Other'
}

function clampTitle(value: string, fallback: string): string {
  const t = value.trim().replace(/\s+/g, ' ')
  if (t === '') return fallback
  return t.length > 100 ? `${t.slice(0, 99).trimEnd()}…` : t
}

// Dedupe case-insensitively, keep first occurrence's casing.
function normalizeThemes(raw: string[] | null | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of raw ?? []) {
    const v = t.trim().replace(/\s+/g, ' ').slice(0, 40)
    const key = v.toLowerCase()
    if (v === '' || seen.has(key)) continue
    seen.add(key)
    out.push(v)
    if (out.length >= MAX_THEMES) break
  }
  return out
}

function normalizeEntities(
  raw: Array<{ name: string; kind?: string | null | undefined }> | null | undefined,
): BraindumpEntity[] {
  const out: BraindumpEntity[] = []
  const seen = new Set<string>()
  for (const e of raw ?? []) {
    const name = e.name.trim().replace(/\s+/g, ' ').slice(0, 80)
    if (name === '') continue
    const kindRaw = (e.kind ?? '').trim().toLowerCase()
    const kind = (ENTITY_KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as EntityKind)
      : 'topic'
    const key = `${kind}:${name.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name, kind })
    if (out.length >= MAX_ENTITIES) break
  }
  return out
}

function normalizeSummary(value: string | null | undefined): string | null {
  if (value == null) return null
  const t = value.trim()
  if (t === '') return null
  return t.length > MAX_ANALYSIS_SUMMARY ? t.slice(0, MAX_ANALYSIS_SUMMARY) : t
}

// date+time → ISO instant; date-only stays 'YYYY-MM-DD'; garbage → null.
function resolveDueDate(
  date: string | null | undefined,
  time: string | null | undefined,
  tz: string,
): string | null {
  const d = typeof date === 'string' && YMD_RE.test(date) ? date : null
  if (!d) return null
  const t = typeof time === 'string' && HM_RE.test(time) ? time : null
  if (!t) return d
  const inst = wallClockToInstant(d, t, tz)
  return inst ? inst.toISOString() : d
}

// Turn validated raw enrich output into the Enrichment contract. Pure and
// total: never throws for schema-valid raw input (garbage dates degrade to
// null, unknown categories fall back to 'Other').
export function coerceEnrichment(raw: RawEnrich, tz: string): Enrichment {
  const taskSuggestions: TaskSuggestion[] = []
  for (const t of raw.tasks ?? []) {
    const title = t.title.trim().replace(/\s+/g, ' ')
    if (title === '') continue
    taskSuggestions.push({
      title: title.length > 100 ? `${title.slice(0, 99).trimEnd()}…` : title,
      dueDate: resolveDueDate(t.date, t.time, tz),
    })
    if (taskSuggestions.length >= MAX_SUGGESTED_TASKS) break
  }

  const eventSuggestions: EventSuggestion[] = []
  for (const e of raw.events ?? []) {
    const title = e.title.trim().replace(/\s+/g, ' ')
    if (title === '') continue
    const date = typeof e.date === 'string' && YMD_RE.test(e.date) ? e.date : null
    const time = typeof e.time === 'string' && HM_RE.test(e.time) ? e.time : null
    let startAt: string | null = null
    let endAt: string | null = null
    let allDay = true
    if (date && time) {
      const start = wallClockToInstant(date, time, tz)
      if (start) {
        startAt = start.toISOString()
        allDay = false
        const dur =
          typeof e.durationMinutes === 'number' && e.durationMinutes > 0
            ? Math.min(e.durationMinutes, 24 * 60)
            : null
        if (dur) endAt = new Date(start.getTime() + dur * 60000).toISOString()
      }
    } else if (date) {
      const start = wallClockToInstant(date, '00:00', tz)
      startAt = start ? start.toISOString() : null
    }
    // An event with no resolvable date can't be created — skip it rather
    // than suggesting an unschedulable appointment.
    if (startAt === null) continue
    eventSuggestions.push({
      title: title.length > 100 ? `${title.slice(0, 99).trimEnd()}…` : title,
      startAt,
      endAt,
      allDay,
    })
    if (eventSuggestions.length >= MAX_SUGGESTED_EVENTS) break
  }

  return EnrichmentSchema.parse({
    category: normalizeCategory(raw.category),
    title: clampTitle(raw.title, 'Brain dump'),
    themes: normalizeThemes(raw.themes),
    entities: normalizeEntities(raw.entities),
    summary: normalizeSummary(raw.summary),
    taskSuggestions,
    eventSuggestions,
  })
}

// Coerce the raw summary output, or null when the summary text is empty
// (the route maps that to 422 like an unparsable reply).
export function coerceSummary(raw: RawSummary): RangeSummary | null {
  const summary = raw.summary.trim()
  if (summary === '') return null
  const highlights: string[] = []
  for (const h of raw.highlights ?? []) {
    const v = h.trim().replace(/\s+/g, ' ').slice(0, 200)
    if (v === '') continue
    highlights.push(v)
    if (highlights.length >= 8) break
  }
  const moodRaw = (raw.moodTrend ?? '').trim()
  return RangeSummarySchema.parse({
    summary: summary.length > 2000 ? summary.slice(0, 2000) : summary,
    highlights,
    moodTrend: moodRaw === '' ? null : moodRaw.slice(0, 300),
  })
}
