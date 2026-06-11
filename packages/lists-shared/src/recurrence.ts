// Pure recurrence logic for Rallypoint Lists (Planner slice 1). A
// `list_item_series` row holds an RFC-5545-subset rule; concrete
// occurrences are projected into `list_items` carrying (seriesId,
// occurrenceDate). This module owns BOTH the wire validators for the
// rule and the framework-agnostic expansion that turns a rule + a
// bounded window into the calendar dates it fires on. It is reused by
// apps/lists-api (projection on write) and apps/lists-web (preview);
// evolve the rule HERE, never in two places. Lives apart from
// validators.ts so the expansion is testable on its own and to keep the
// festival-planner-ported validator shape close to the expansion it
// guards.

import { z } from 'zod'
import { assignedToField, itemNotesField, itemTitleField, taskPriorityField } from './validators.js'

// --- Enums -----------------------------------------------------------

// Supported recurrence frequencies — the RFC-5545 subset Planner V1
// ships (design doc §4): DAILY and WEEKLY only. MONTHLY/YEARLY are
// deliberately out of scope; adding one is a new enum value + an
// expansion branch, no schema change (freq is plain text on the row).
export const RECURRENCE_FREQS = ['daily', 'weekly'] as const
export const recurrenceFreqField = z.enum(RECURRENCE_FREQS)
export type RecurrenceFreq = (typeof RECURRENCE_FREQS)[number]

// RFC-5545 BYDAY weekday codes. Stored as a JSONB string[] on the row
// (weekly only; null for daily). Order is RFC's (week starts Monday).
export const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
export const dayCodeField = z.enum(DAY_CODES)
export type DayCode = (typeof DAY_CODES)[number]

// Hard ceiling on how many occurrences one expansion may yield. An
// open-ended series ("every Monday", no until/count) is materialised a
// bounded window at a time, so a well-formed expansion always stays
// under this. Exceeding it means the caller passed an unbounded window
// or a runaway rule — expandOccurrences throws rather than fan out
// unboundedly. Ported from festival-planner's 50-instance guard.
export const MAX_INSTANCES_PER_SERIES = 50

// JS getUTCDay() is 0=Sun..6=Sat; map the RFC codes onto it.
const DAY_CODE_TO_WEEKDAY: Record<DayCode, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
}

// --- Field-level building blocks -------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
// A plain calendar date `YYYY-MM-DD` (no time, no zone). Matches the
// `date` columns dtstart/until. Rejects malformed strings AND real
// calendar nonsense (2026-02-31) by round-tripping through UTC.
export const calendarDateField = z
  .string()
  .trim()
  .regex(ISO_DATE_RE, 'Date must be in YYYY-MM-DD format.')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`)
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
  }, 'Date is not a valid calendar date.')

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/
// Optional wall-clock time-of-day `HH:MM` or `HH:MM:SS` (matches the
// `time` column). Empty string normalises to null. Combined with each
// occurrence date into the generated item's dueDate (see
// occurrenceDueDate). nullable+optional so an OMITTED time stays
// undefined, distinct from an explicit null clear.
export const timeOfDayField = z
  .string()
  .trim()
  .refine((s) => s === '' || TIME_RE.test(s), 'Time must be in HH:MM or HH:MM:SS format.')
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .optional()

// interval >= 1 ("every 2 weeks"). Defaults to 1 when omitted.
export const intervalField = z
  .number()
  .int('Interval must be an integer.')
  .min(1, 'Interval must be at least 1.')

// count: total number of occurrences from dtstart (RFC COUNT). Bounded
// by the per-series cap so a finite series can't be defined larger than
// a single expansion may yield. Mutually exclusive with `until` (below).
export const countField = z
  .number()
  .int('Count must be an integer.')
  .min(1, 'Count must be at least 1.')
  .max(MAX_INSTANCES_PER_SERIES, `Count must be at most ${MAX_INSTANCES_PER_SERIES}.`)
  .nullable()
  .optional()

// byDay: the weekdays a WEEKLY rule fires on. Non-empty, deduped, at
// most one of each of the seven codes. Omitted on a weekly rule means
// "the weekday of dtstart" (RFC default). Forbidden on a daily rule
// (enforced by the cross-field refine on the request schemas).
export const byDayField = z
  .array(dayCodeField)
  .min(1, 'byDay must list at least one day.')
  .max(7, 'byDay can list at most seven days.')
  .transform((days) => [...new Set(days)])

// --- Request schemas -------------------------------------------------

// Shared cross-field rule for a complete (create) rule: byDay belongs to
// weekly only, and UNTIL/COUNT are mutually exclusive (RFC-5545), and
// until (if given) must not precede dtstart.
function refineRule(
  v: {
    freq?: RecurrenceFreq | undefined
    byDay?: DayCode[] | undefined
    until?: string | null | undefined
    count?: number | null | undefined
    dtstart?: string | undefined
  },
  ctx: z.RefinementCtx,
): void {
  if (v.byDay !== undefined && v.freq !== undefined && v.freq !== 'weekly') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['byDay'],
      message: 'byDay is only valid for a weekly recurrence.',
    })
  }
  if (v.until != null && v.count != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['until'],
      message: 'Specify at most one of until or count.',
    })
  }
  if (v.until != null && v.dtstart != null && v.until < v.dtstart) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['until'],
      message: 'until must not be before dtstart.',
    })
  }
}

// POST .../series — define a recurring item. title/notes/assignedTo/
// priority are the template stamped onto each generated occurrence
// (reusing the item-level validators). The remaining fields are the
// recurrence rule. interval defaults to 1.
export const CreateSeriesSchema = z
  .object({
    title: itemTitleField,
    notes: itemNotesField,
    assignedTo: assignedToField,
    priority: taskPriorityField.optional(),
    freq: recurrenceFreqField,
    interval: intervalField.default(1),
    byDay: byDayField.optional(),
    dtstart: calendarDateField,
    until: calendarDateField.nullable().optional(),
    count: countField,
    timeOfDay: timeOfDayField,
  })
  .superRefine(refineRule)
export type CreateSeriesInput = z.infer<typeof CreateSeriesSchema>

// PATCH .../series/:seriesId — sparse update. Every field optional; at
// least one must be present. Cross-field rules (byDay-vs-freq,
// until-vs-count) only fire when both sides are present in the patch;
// the route re-validates against the merged row before re-projecting.
export const UpdateSeriesSchema = z
  .object({
    title: itemTitleField.optional(),
    notes: itemNotesField,
    assignedTo: assignedToField,
    priority: taskPriorityField.optional(),
    freq: recurrenceFreqField.optional(),
    interval: intervalField.optional(),
    byDay: byDayField.nullable().optional(),
    dtstart: calendarDateField.optional(),
    until: calendarDateField.nullable().optional(),
    count: countField,
    timeOfDay: timeOfDayField,
  })
  .superRefine((v, ctx) => {
    if (Object.values(v).every((x) => x === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'At least one field must be supplied.',
      })
    }
    refineRule({ ...v, byDay: v.byDay ?? undefined }, ctx)
  })
export type UpdateSeriesInput = z.infer<typeof UpdateSeriesSchema>

// --- Expansion -------------------------------------------------------

// The minimal rule shape the expander needs — a structural subset of a
// stored series row, so the API can pass the row straight in.
export interface RecurrenceRule {
  freq: RecurrenceFreq
  interval: number
  byDay?: DayCode[] | null
  dtstart: string
  until?: string | null
  count?: number | null
}

// Inclusive `[from, to]` calendar-date window to materialise within.
export interface ExpansionWindow {
  from: string
  to: string
}

const MS_PER_DAY = 86_400_000

function parseDate(s: string): Date {
  return new Date(`${s}T00:00:00Z`)
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY)
}

// The Monday on or before `d` (RFC WKST default = MO), used as the
// week-interval anchor so "every 2 weeks" counts whole weeks from the
// start of dtstart's week regardless of which weekday dtstart is.
function startOfWeekMonday(d: Date): Date {
  const weekday = d.getUTCDay() // 0=Sun..6=Sat
  const back = (weekday + 6) % 7 // days since Monday
  return new Date(d.getTime() - back * MS_PER_DAY)
}

// Build the per-rule "does this date fire?" predicate plus the resolved
// interval. Shared by expandOccurrences and materializeOccurrences so the
// daily-step / weekly-byDay / multi-week-anchor semantics live once.
function buildMatcher(rule: RecurrenceRule): { matches: (cursor: Date) => boolean; interval: number } {
  const dtstart = parseDate(rule.dtstart)
  const interval = rule.interval >= 1 ? rule.interval : 1

  // Target weekday set for weekly rules. Empty/absent byDay → dtstart's
  // own weekday (RFC default).
  const weekdaySet = new Set<number>()
  if (rule.freq === 'weekly') {
    const codes = rule.byDay && rule.byDay.length > 0 ? rule.byDay : null
    if (codes) {
      for (const c of codes) weekdaySet.add(DAY_CODE_TO_WEEKDAY[c])
    } else {
      weekdaySet.add(dtstart.getUTCDay())
    }
  }
  const weekAnchor = rule.freq === 'weekly' ? startOfWeekMonday(dtstart) : dtstart

  const matches = (cursor: Date): boolean => {
    if (rule.freq === 'daily') {
      return daysBetween(dtstart, cursor) % interval === 0
    }
    if (!weekdaySet.has(cursor.getUTCDay())) return false
    const weekIdx = Math.floor(daysBetween(weekAnchor, cursor) / 7)
    return weekIdx % interval === 0
  }
  return { matches, interval }
}

// Expand a recurrence rule into the ISO calendar dates it fires on
// within `range` (inclusive on both ends). Occurrences are counted in
// the global sequence from dtstart so `count` and the window compose
// correctly (a window starting after dtstart still sees only the first
// `count` occurrences). Throws RangeError if more than
// MAX_INSTANCES_PER_SERIES dates fall in the window — the signal that
// the caller handed an unbounded window or runaway rule. Use this for
// validation / bounded previews; for open-ended projection where you
// want "the next N, no matter the rule" use materializeOccurrences.
export function expandOccurrences(rule: RecurrenceRule, range: ExpansionWindow): string[] {
  const dtstart = parseDate(rule.dtstart)
  const windowFrom = parseDate(range.from)
  const windowTo = parseDate(range.to)
  const until = rule.until != null ? parseDate(rule.until) : null
  const { matches } = buildMatcher(rule)

  // Effective last day we'll ever scan: the earlier of window end and
  // (if set) the until bound. count is handled by the sequence counter.
  const scanEnd = until != null && until.getTime() < windowTo.getTime() ? until : windowTo

  const out: string[] = []
  let seq = 0
  // Start scanning at dtstart (occurrences never precede it) and step a
  // day at a time. Day-by-day keeps weekly BYDAY expansion trivial and
  // the loop bounded — it can only run for the window's span of days.
  for (
    let cursor = new Date(dtstart.getTime());
    cursor.getTime() <= scanEnd.getTime();
    cursor = new Date(cursor.getTime() + MS_PER_DAY)
  ) {
    if (!matches(cursor)) continue
    seq += 1
    if (rule.count != null && seq > rule.count) break
    if (cursor.getTime() >= windowFrom.getTime()) {
      out.push(toISODate(cursor))
      if (out.length > MAX_INSTANCES_PER_SERIES) {
        throw new RangeError(
          `Recurrence expansion exceeded ${MAX_INSTANCES_PER_SERIES} occurrences; window is unbounded relative to the rule.`,
        )
      }
    }
  }
  return out
}

export interface MaterializeOptions {
  // Earliest date to emit (inclusive, YYYY-MM-DD). Occurrences before
  // this are still counted toward `count` but not returned — this is the
  // rolling-window start (e.g. "today"), so past occurrences aren't
  // backfilled while a finite series still terminates correctly.
  from: string
  // Hard ceiling on returned occurrences. Defaults to (and is clamped to)
  // MAX_INSTANCES_PER_SERIES. Unlike expandOccurrences this TRUNCATES
  // rather than throws — projecting the next N is the point.
  limit?: number
}

// Rolling-window projection: the next up-to-`limit` ISO dates a rule
// fires on, on or after `options.from`. This is what the API materialises
// into list_items. An open-ended rule ("every Monday") yields exactly
// `limit` dates; a finite rule (until/count) yields fewer once exhausted.
// `count` is still measured in the global sequence from dtstart, so a
// `from` past dtstart correctly sees the remaining tail only.
export function materializeOccurrences(rule: RecurrenceRule, options: MaterializeOptions): string[] {
  const dtstart = parseDate(rule.dtstart)
  const from = parseDate(options.from)
  const until = rule.until != null ? parseDate(rule.until) : null
  const limit = Math.min(
    options.limit != null && options.limit >= 0 ? options.limit : MAX_INSTANCES_PER_SERIES,
    MAX_INSTANCES_PER_SERIES,
  )
  const { matches } = buildMatcher(rule)

  const out: string[] = []
  let seq = 0
  for (
    let cursor = new Date(dtstart.getTime());
    until == null || cursor.getTime() <= until.getTime();
    cursor = new Date(cursor.getTime() + MS_PER_DAY)
  ) {
    if (matches(cursor)) {
      seq += 1
      if (rule.count != null && seq > rule.count) break
      if (cursor.getTime() >= from.getTime()) {
        if (out.length >= limit) break
        out.push(toISODate(cursor))
      }
    }
  }
  return out
}

// Combine an occurrence's calendar date with the series' optional
// time-of-day into the dueDate timestamp stamped on the generated item.
// A null time anchors to start-of-day. NOTE: the result is built in UTC
// (`…Z`); per-user timezone handling for "today"/Upcoming boundaries is
// the planner-api BFF's concern (deferred — see slice 2). Returns an ISO
// string the API casts to a timestamptz.
export function occurrenceDueDate(occurrenceDate: string, timeOfDay: string | null): string {
  const time = timeOfDay ?? '00:00:00'
  const hms = time.length === 5 ? `${time}:00` : time
  return `${occurrenceDate}T${hms}.000Z`
}
