import { z } from 'zod'
import { localAnchor, wallClockToInstant } from '@rallypoint/shared'
import { extractFirstJsonObject } from '@rallypoint/ai'

// AI Assist — pure logic for the free-text capture endpoint. The route
// (routes/assist.ts) owns the Workers AI call + tracing; everything here is
// deterministic and unit-tested: prompt building (with a tz-resolved "today"
// anchor), defensive parsing of the model's JSON, and coercion of the small
// raw shape into the AssistSuggestion contract the client saves from.
//
// Model choice: Mistral Small 3.1 (same as fitness-api's vision passes — no
// Meta/xAI models). Overridable per deployment via the ASSIST_MODEL env var
// (threaded by the route) so a smaller open model can be A/B'd on QA with a
// config flip. A short classification prompt, so the token cap is small —
// 768 leaves room for a multi-item food capture on top of the base fields.

export const ASSIST_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct'
export const ASSIST_MAX_TOKENS = 768

export const ASSIST_CATEGORIES = ['task', 'shopping', 'event', 'food', 'note', 'diary'] as const
export type AssistCategory = (typeof ASSIST_CATEGORIES)[number]

export const ASSIST_CONFIDENCE = ['low', 'medium', 'high'] as const
export type AssistConfidence = (typeof ASSIST_CONFIDENCE)[number]

// --- request contract ------------------------------------------------
// `clientNow` is the browser's current instant (ISO, offset or Z) and `tz`
// its IANA zone. Together they anchor relative dates ("tomorrow 9am") and
// let the model resolve them to an absolute local date, which coercion then
// turns into a real instant. No per-user tz is stored (Planner convention).
export const AssistRequestSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, 'Say what you want to capture.')
    .max(500, 'Keep it under 500 characters.'),
  clientNow: z.string().datetime({ offset: true }),
  tz: z.string().trim().min(1).max(64),
})
export type AssistRequest = z.infer<typeof AssistRequestSchema>

// --- raw model output ------------------------------------------------
// The model returns a small, permissive shape; coercion below tightens it.
// Fields are unions-with-null (not just optional) because the prompt asks the
// model to emit explicit nulls, and some runtimes surface those literally.
// One food item as the model emits it (food category only). Maximally
// permissive numbers — coercion clamps/drops, so one odd value never 422s
// the whole capture.
const RawFoodItemSchema = z.object({
  name: z.string(),
  grams: z.union([z.number(), z.null()]).optional(),
  kcal: z.union([z.number(), z.null()]).optional(),
  proteinG: z.union([z.number(), z.null()]).optional(),
  carbsG: z.union([z.number(), z.null()]).optional(),
  fatG: z.union([z.number(), z.null()]).optional(),
})

const RawModelSchema = z.object({
  category: z.string(),
  title: z.string(),
  notes: z.union([z.string(), z.null()]).optional(),
  date: z.union([z.string(), z.null()]).optional(),
  time: z.union([z.string(), z.null()]).optional(),
  durationMinutes: z.union([z.number(), z.null()]).optional(),
  mood: z.union([z.number(), z.null()]).optional(),
  items: z.union([z.array(RawFoodItemSchema).max(20), z.null()]).optional(),
  confidence: z.union([z.string(), z.null()]).optional(),
})
export type RawModel = z.infer<typeof RawModelSchema>

// --- suggestion contract (returned to the client) --------------------
// One shape covers every category; the client reads only the fields its
// category uses. `dueDate` is either a day-only 'YYYY-MM-DD' (all-day task /
// diary entry) or a full ISO instant (timed — so notifications can fire).
// A coerced food item (bounds mirror fitness's scannedFoodItemSchema /
// createFoodLogEntrySchema so the cross-app save can never 400 on range).
export const AssistFoodItemSchema = z.object({
  name: z.string().min(1).max(120),
  grams: z.number().finite().min(1).max(5000),
  kcal: z.number().finite().min(0).max(20000),
  proteinG: z.number().finite().min(0).max(2000),
  carbsG: z.number().finite().min(0).max(2000),
  fatG: z.number().finite().min(0).max(2000),
})
export type AssistFoodItem = z.infer<typeof AssistFoodItemSchema>

export const AssistSuggestionSchema = z.object({
  category: z.enum(ASSIST_CATEGORIES),
  title: z.string().min(1).max(100),
  notes: z.string().max(2000).nullable(),
  startAt: z.string().nullable(),
  endAt: z.string().nullable(),
  allDay: z.boolean(),
  dueDate: z.string().nullable(),
  mood: z.number().int().min(1).max(5).nullable(),
  // food only: one entry per food eaten, TOTAL macros for its amount.
  items: z.array(AssistFoodItemSchema).max(20).nullable(),
  confidence: z.enum(ASSIST_CONFIDENCE),
  // Set when the confidence is low BECAUSE a date was lost or looks wrong.
  // Only the server knows that: the client can't tell a date-driven downgrade
  // from a model that was simply unsure about the category, since a
  // backwards-resolved date arrives WITH a startAt — just the wrong one. It
  // decides which field the edit card asks the user to check.
  dateUncertain: z.boolean(),
})
export type AssistSuggestion = z.infer<typeof AssistSuggestionSchema>

// The full response also carries the trace ids (attached by the route after
// the AI call) so the client can echo feedback back to the corpus.
export interface AssistResponse extends AssistSuggestion {
  traceId: string
  responseId: string
}

// --- prompt ----------------------------------------------------------

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/
const HM_RE = /^\d{2}:\d{2}$/

// How many local days an event may sit behind the capture before it reads as
// a date the model resolved backwards ("Oct 23rd" → last October, "next
// Monday" → last Monday) rather than a deliberate back-log. Today and
// yesterday are legitimate — logging last night's gig this morning is normal.
const STALE_START_DAYS = 1

// Deliberately terse — prefill tokens are pure latency on Workers AI, so the
// category definitions are one-liners and the output shape is shown once.
export function assistSystemPrompt(clientNow: string, tz: string): string {
  const { date, time, weekday } = localAnchor(clientNow, tz)
  return `\
Sort one short capture into a category and extract its fields. Local now:
${weekday} ${date} ${time} (${tz}); resolve relative dates against it.
Categories: task (a to-do, e.g. "call the dentist"), shopping (to buy),
event (attend at a date/time), food (something the user ate or drank),
diary (a feeling/mood — set mood 1-5, 1=very negative 5=very positive),
note (info to keep that fits none of the above).
Pull every date/time out of the text into date/time; title is what remains —
the thing itself, never the raw capture ("Madeon at 7pm Oct 23rd" -> title
"Madeon"). A date with no year means its next future occurrence.
Respond with ONLY this JSON:
{"category":"task|shopping|event|food|note|diary","title":"short title",
"notes":"extra detail or null","date":"YYYY-MM-DD or null",
"time":"HH:MM 24h or null","durationMinutes":number or null,
"mood":1-5 or null,"items":[...] or null,"confidence":"low|medium|high"}
items (food ONLY, else null): one entry per food, {"name","grams","kcal",
"proteinG","carbsG","fatG"} — TOTAL macros for the stated amount ("5
cherries"); assume one typical serving when no amount is stated. Honest
estimates, no fake precision.
Use null, not omission. No prose, no code fences.`
}

// The full ai.run input: chat messages + a small token cap + a json_schema
// response format to nudge structured output. The route falls back to
// text-parsing when the runtime returns the object as a string.
export function buildAssistInput(
  text: string,
  clientNow: string,
  tz: string,
): Record<string, unknown> {
  return {
    messages: [
      { role: 'system', content: assistSystemPrompt(clientNow, tz) },
      { role: 'user', content: text },
    ],
    max_tokens: ASSIST_MAX_TOKENS,
    response_format: {
      type: 'json_schema',
      json_schema: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: [...ASSIST_CATEGORIES] },
          title: { type: 'string' },
          notes: { type: ['string', 'null'] },
          date: { type: ['string', 'null'] },
          time: { type: ['string', 'null'] },
          durationMinutes: { type: ['number', 'null'] },
          mood: { type: ['number', 'null'] },
          items: {
            type: ['array', 'null'],
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                grams: { type: ['number', 'null'] },
                kcal: { type: ['number', 'null'] },
                proteinG: { type: ['number', 'null'] },
                carbsG: { type: ['number', 'null'] },
                fatG: { type: ['number', 'null'] },
              },
              required: ['name', 'grams', 'kcal', 'proteinG', 'carbsG', 'fatG'],
            },
          },
          confidence: { type: 'string', enum: [...ASSIST_CONFIDENCE] },
        },
        required: ['category', 'title', 'confidence'],
      },
    },
  }
}

// --- parsing ---------------------------------------------------------

// Validate the model output into the raw shape. Accepts either an already
// parsed object (json_schema runtimes / @rallypoint/ai's recovered payload) or
// a raw text reply — a stray-prose/code-fence reply is recovered via the shared
// balanced-brace extractor (extractFirstJsonObject). Returns null when the
// output can't be recovered or fails the schema — the route maps that to a 422
// so the client falls back to the manual form.
export function parseAssistOutput(raw: unknown): RawModel | null {
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
  const parsed = RawModelSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

// --- coercion --------------------------------------------------------

function normalizeCategory(value: string): AssistCategory {
  const v = value.trim().toLowerCase()
  return (ASSIST_CATEGORIES as readonly string[]).includes(v) ? (v as AssistCategory) : 'note'
}

function normalizeConfidence(value: string | null | undefined): AssistConfidence {
  const v = (value ?? '').trim().toLowerCase()
  return (ASSIST_CONFIDENCE as readonly string[]).includes(v) ? (v as AssistConfidence) : 'medium'
}

function clampTitle(value: string): string {
  const t = value.trim().replace(/\s+/g, ' ')
  if (t === '') return 'Note'
  return t.length > 100 ? `${t.slice(0, 99).trimEnd()}…` : t
}

function normalizeNotes(value: string | null | undefined): string | null {
  if (value == null) return null
  const t = value.trim()
  if (t === '') return null
  return t.length > 2000 ? t.slice(0, 2000) : t
}

function clampMood(value: number | null | undefined): number | null {
  if (value == null || Number.isNaN(value)) return null
  const n = Math.round(value)
  return Math.min(5, Math.max(1, n))
}

// Local midnight of a day, as an instant (for all-day events / day anchoring).
// Delegates to the shared tz resolver (two-pass, DST-aware).
function dayStartInstant(date: string, tz: string): Date | null {
  return wallClockToInstant(date, '00:00', tz)
}

// A model date/time field as the model actually emitted it, or null when it
// carries no value. The prompt asks for explicit nulls, but runtimes surface
// "absent" as blanks and the literal string "null" often enough that treating
// those as a DROPPED value (below) would flag half the notes as suspect.
function rawDateField(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t === '' || t.toLowerCase() === 'null' ? null : t
}

// The local calendar day an instant falls on, or null when it isn't a real
// instant (coerceSuggestion promises never to throw, and Intl rejects an
// invalid Date).
function localDay(instant: string, tz: string): string | null {
  const t = Date.parse(instant)
  if (Number.isNaN(t)) return null
  try {
    return localAnchor(new Date(t).toISOString(), tz).date
  } catch {
    return null
  }
}

// Whole days from one plain YYYY-MM-DD to another. Both are read as UTC
// midnights, so a DST transition in between can't skew the count.
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000)
}

// True when a start sits far enough behind the capture to look backwards-
// resolved. Measured in LOCAL calendar days rather than elapsed hours: an
// hours-based window has to be padded past the longest DST day (a fall-back
// day runs 25 hours), and that padding blinds it to dates that landed only a
// day or two back. Days sidestep DST entirely, so the threshold can stay
// tight. Unjudgeable input fails open — never flag what we can't measure.
function isStaleStart(startAt: string, clientNow: string, tz: string): boolean {
  const start = localDay(startAt, tz)
  const today = localDay(clientNow, tz)
  if (start === null || today === null) return false
  return daysBetween(start, today) > STALE_START_DAYS
}

// Clamp one raw food item into the bounded shape, or drop it (null) when it
// has no usable name or macros. Grams default from a rough kcal density
// (~1.5 kcal/g mixed food) when the model omits them, so the diary row
// always carries a quantity.
function coerceFoodItem(raw: {
  name: string
  grams?: number | null | undefined
  kcal?: number | null | undefined
  proteinG?: number | null | undefined
  carbsG?: number | null | undefined
  fatG?: number | null | undefined
}): AssistFoodItem | null {
  const name = raw.name.trim().replace(/\s+/g, ' ').slice(0, 120)
  if (name === '') return null
  const num = (v: number | null | undefined, max: number): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : null
  const kcal = num(raw.kcal, 20000)
  if (kcal === null) return null
  const grams = num(raw.grams, 5000)
  return {
    name,
    grams: grams !== null && grams >= 1 ? grams : Math.min(5000, Math.max(1, Math.round(kcal / 1.5))),
    kcal: Math.round(kcal),
    proteinG: num(raw.proteinG, 2000) ?? 0,
    carbsG: num(raw.carbsG, 2000) ?? 0,
    fatG: num(raw.fatG, 2000) ?? 0,
  }
}

// Turn the validated raw model output into the AssistSuggestion contract,
// resolving dates/times against the client's zone. Pure and total: never
// throws for in-range raw input (garbage dates degrade to null, unknown
// categories fall back to 'note').
//
// Lost scheduling downgrades `confidence` to 'low' rather than degrading
// silently, because the client AUTO-SAVES anything above low. The failure this
// guards is "Madeon at 7pm Oct 23rd" saved as an untimed event titled with the
// whole capture: a suggestion that dropped a date the user clearly stated is
// worse than no suggestion, so it goes to the edit card for confirmation.
export function coerceSuggestion(raw: RawModel, tz: string, clientNow: string): AssistSuggestion {
  let category = normalizeCategory(raw.category)
  const title = clampTitle(raw.title)
  const notes = normalizeNotes(raw.notes)
  let confidence = normalizeConfidence(raw.confidence)

  const rawDate = rawDateField(raw.date)
  const rawTime = rawDateField(raw.time)
  const date = rawDate !== null && YMD_RE.test(rawDate) ? rawDate : null
  const time = rawTime !== null && HM_RE.test(rawTime) ? rawTime : null
  // The model reached for a date/time and emitted something unreadable, so a
  // stated "when" is about to vanish. Only worth flagging on the categories
  // that carry one: a shopping row keeps no date either way, and making the
  // user confirm a stray field the edit card won't even show is pure friction.
  const unreadableWhen =
    (rawDate !== null && date === null) || (rawTime !== null && time === null)

  let startAt: string | null = null
  let endAt: string | null = null
  let allDay = false
  let dueDate: string | null = null
  let mood: number | null = null
  let items: AssistFoodItem[] | null = null
  let dateUncertain = false

  if (category === 'food') {
    const coerced = (raw.items ?? [])
      .map(coerceFoodItem)
      .filter((i): i is AssistFoodItem => i !== null)
      .slice(0, 20)
    if (coerced.length > 0) {
      items = coerced
    } else {
      // A food capture with nothing loggable can't save anything — degrade
      // to a low-confidence note so the text is still kept.
      category = 'note'
      confidence = 'low'
    }
  }

  if (category === 'event') {
    if (date && time) {
      const start = wallClockToInstant(date, time, tz)
      startAt = start ? start.toISOString() : null
      allDay = start === null
      const dur =
        typeof raw.durationMinutes === 'number' && raw.durationMinutes > 0
          ? Math.min(raw.durationMinutes, 24 * 60)
          : null
      if (start && dur) endAt = new Date(start.getTime() + dur * 60000).toISOString()
    } else if (date) {
      const start = dayStartInstant(date, tz)
      startAt = start ? start.toISOString() : null
      allDay = true
    } else {
      allDay = true
    }
    // An event is a thing you attend at a time. No resolvable start means the
    // model either found no date or lost it; a start well behind the capture
    // means it resolved one backwards. Either way the user confirms.
    dateUncertain = unreadableWhen || startAt === null || isStaleStart(startAt, clientNow, tz)
  } else if (category === 'task' || category === 'diary') {
    if (date && time) {
      const inst = wallClockToInstant(date, time, tz)
      dueDate = inst ? inst.toISOString() : date
    } else if (date) {
      dueDate = date
    }
    if (category === 'diary') mood = clampMood(raw.mood)
    // A stated due date that didn't survive parsing — unlike an event, a
    // task with no date at all is perfectly normal, so only the loss flags.
    dateUncertain = unreadableWhen
  }
  // note / shopping carry no date fields, so a stray unreadable one is moot.

  return AssistSuggestionSchema.parse({
    category,
    title,
    notes,
    startAt,
    endAt,
    allDay,
    dueDate,
    mood,
    items,
    // A lost "when" is the one degradation the client must not auto-save
    // through, so it always outranks whatever the model claimed.
    confidence: dateUncertain ? 'low' : confidence,
    dateUncertain,
  })
}
