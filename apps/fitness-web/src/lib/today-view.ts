// Pure helpers for the redesigned /log "Today" view. Everything time-
// sensitive takes the local "today" as input (ISO yyyy-mm-dd) so the
// computation stays deterministic and unit-testable — the surrounding
// React layer is the one source of `new Date()`.
//
// Week boundaries follow ISO convention: Monday is day 0 of the week,
// Sunday is day 6. The design handoff's week strip renders Mon→Sun.

import {
  DAY_KEYS,
  DAY_TYPE_LABELS,
  isPresetDayType,
  summarizeWorkoutSets,
  type DayKey,
  type DayType,
  type DayTypesMap,
  type TrainingPlanItemDto,
} from '@rallypoint/fitness-shared'
import type { WorkoutDto } from './api.js'

/** Day-of-week labels in display order — matches the prototype's strip. */
export const WEEK_DAYS_MON_SUN = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const

/** Offset of `dayKey` from `todayDayKey` in the Mon→Sun cycle: 0 = today,
 *  1 = tomorrow, … 6 = six days out. Used to order plan items into a
 *  rolling "next up" list that wraps across the week boundary (Sunday's
 *  view still surfaces next week's Monday). */
export function dayOffsetFromToday(dayKey: DayKey, todayDayKey: DayKey): number {
  return (DAY_KEYS.indexOf(dayKey) - DAY_KEYS.indexOf(todayDayKey) + 7) % 7
}

/** The next scheduled plan sessions in the weekly rotation, starting from
 *  `todayDayKey` and wrapping across the week boundary. Ordered by
 *  (day-offset-from-today, position). `skipItemId` drops the item already
 *  shown in the hero card. Returns at most `limit` items. Pure — the
 *  React layer supplies the current day-key. */
export function upcomingPlanSessions(
  items: readonly TrainingPlanItemDto[],
  todayDayKey: DayKey,
  opts: { skipItemId?: string | null; limit?: number } = {},
): TrainingPlanItemDto[] {
  const { skipItemId = null, limit = 6 } = opts
  // `.filter()` already returns a fresh array, so the following `.sort()`
  // never mutates the caller's `items`.
  return items
    .filter((it) => it.id !== skipItemId)
    .sort(
      (a, b) =>
        dayOffsetFromToday(a.dayKey, todayDayKey) - dayOffsetFromToday(b.dayKey, todayDayKey) ||
        a.position - b.position,
    )
    .slice(0, limit)
}

/** Local date helpers — no UTC drift. The caller supplies a `Date`; we
 *  read its local components. */
function dateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Parse a yyyy-mm-dd string (or a full ISO timestamp) to a Date at
 *  local midnight — without losing a day to a UTC shift. */
function parseLocalDate(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return new Date(NaN)
  // m[1..3] are all guaranteed-defined captures from the regex above.
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  return new Date(y, mo - 1, d)
}

/** Compute the Monday of the week containing `today` (yyyy-mm-dd). */
export function weekStartMonday(today: string): string {
  const d = parseLocalDate(today)
  // getDay(): Sun=0, Mon=1, … Sat=6. Shift to Mon=0..Sun=6.
  const wd = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - wd)
  return dateKey(d)
}

/** Half-open `[start, end)` for the Mon→Sun week containing `today`.
 *  end = the following Monday. */
export function weekRange(today: string): { start: string; end: string } {
  const start = weekStartMonday(today)
  const sd = parseLocalDate(start)
  const ed = new Date(sd)
  ed.setDate(ed.getDate() + 7)
  return { start, end: dateKey(ed) }
}

/** Truthy mask of which days Mon..Sun have at least one workout (any
 *  modality) that fell inside the Mon→Sun week of `today`. Workouts are
 *  bucketed by their `performedAt` local date. */
export function computeWeekHits(workouts: readonly WorkoutDto[], today: string): boolean[] {
  const { start, end } = weekRange(today)
  const startD = parseLocalDate(start)
  const out = [false, false, false, false, false, false, false]
  for (const w of workouts) {
    if (!w.performedAt) continue
    const dk = dateKey(new Date(w.performedAt))
    if (dk < start || dk >= end) continue
    const wd = parseLocalDate(dk)
    const idx = Math.round((wd.getTime() - startD.getTime()) / 86_400_000)
    if (idx >= 0 && idx < 7) out[idx] = true
  }
  return out
}

/** Length of the consecutive-day workout streak that ends on `today`
 *  (today counted only if the user trained today; otherwise the streak
 *  ends yesterday). Walks back day-by-day looking for at least one
 *  workout per local date. Capped at 365 to avoid pathological loops. */
export function computeStreak(workouts: readonly WorkoutDto[], today: string): number {
  const trained = new Set<string>()
  for (const w of workouts) {
    if (!w.performedAt) continue
    trained.add(dateKey(new Date(w.performedAt)))
  }
  if (trained.size === 0) return 0
  // Anchor: if the user trained today, today counts; otherwise start at
  // yesterday so a missed-today streak still reads "12-day streak".
  const anchor = parseLocalDate(today)
  if (!trained.has(dateKey(anchor))) anchor.setDate(anchor.getDate() - 1)
  let n = 0
  while (n < 365) {
    if (!trained.has(dateKey(anchor))) break
    n += 1
    anchor.setDate(anchor.getDate() - 1)
  }
  return n
}

/** Number of distinct training days inside the Mon→Sun week of `today`. */
export function trainingsThisWeek(workouts: readonly WorkoutDto[], today: string): number {
  return computeWeekHits(workouts, today).filter(Boolean).length
}

/** Total tonnage (kg) lifted inside the Mon→Sun week of `today` — the
 *  Today view's "Volume" stat tile. Same local-date week window as
 *  computeWeekHits; warmup sets never count toward tonnage. */
export function weekVolumeKg(workouts: readonly WorkoutDto[], today: string): number {
  const { start, end } = weekRange(today)
  let kg = 0
  for (const w of workouts) {
    if (!w.performedAt) continue
    const dk = dateKey(new Date(w.performedAt))
    if (dk < start || dk >= end) continue
    kg += summarizeWorkoutSets(w.sets.filter((set) => set.setType !== 'warmup')).tonnageKg
  }
  return kg
}

/** Format the page-head eyebrow: `THURSDAY · 26 JUN`. Pure, takes a
 *  `Date` so the test can pin it. */
export function formatTodayEyebrow(d: Date): string {
  const day = d.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase()
  const dom = d.getDate()
  const mon = d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()
  return `${day} · ${dom} ${mon}`
}

/** Local-midnight of the day AFTER `now`, as ms-since-epoch. Used by
 *  the Today view's rollover tick so the page re-fetches its data the
 *  instant the day flips (and a Wednesday plan item doesn't keep
 *  showing as TODAY on Thursday morning — code-review F9/F10). DST is
 *  handled by Date constructor's wall-clock semantics: setting hour=0
 *  on the next calendar date lands on local midnight regardless of
 *  the spring-forward / fall-back transition. */
export function nextMidnightMs(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0)
  return next.getTime()
}

/** Fallback card shown on the Today view when the training plan has
 *  nothing scheduled for today but the user has assigned a workout type
 *  to today's weekday (Settings → Training → Weekly rhythm). A scheduled
 *  plan item always wins — callers only invoke this once they've
 *  confirmed there are no plan items for `dayKey`. */
export interface TodayFallback {
  /** The matched preset, or `null` when today's value is a free-text label
   *  (in which case `label` holds the user's raw text). */
  type: DayType | null
  label: string
  blurb: string
  cta: { label: string; to: string } | null
}

/** Blurb for a free-text day — we don't know what "CrossFit class" entails,
 *  so keep it generic and offer no preset-specific CTA. */
const CUSTOM_FALLBACK_BLURB = "Today's your own session — start when you're ready."

const TODAY_FALLBACK_BLURB: Record<DayType, string> = {
  strength: 'Get under the bar — quick-start a strength session.',
  cardio: 'Lace up and log some distance.',
  hiit: 'Pick a WOD from the library and get moving.',
  mobility: 'Take some time to move and stretch.',
  rest: 'Recovery day — take it easy.',
}

const TODAY_FALLBACK_CTA: Record<DayType, { label: string; to: string } | null> = {
  strength: { label: 'Start strength session', to: '/composer?mode=strength' },
  cardio: { label: 'Log cardio', to: '/run/log' },
  hiit: { label: 'Browse WODs', to: '/library/wods' },
  mobility: { label: 'Browse library', to: '/library' },
  rest: null,
}

export function resolveTodayFallback(dayKey: DayKey, dayTypes: DayTypesMap): TodayFallback | null {
  const value = dayTypes[dayKey]
  if (!value) return null
  if (isPresetDayType(value)) {
    return {
      type: value,
      label: DAY_TYPE_LABELS[value],
      blurb: TODAY_FALLBACK_BLURB[value],
      cta: TODAY_FALLBACK_CTA[value],
    }
  }
  // Free-text day: render the label verbatim, generic blurb, no preset CTA.
  return { type: null, label: value, blurb: CUSTOM_FALLBACK_BLURB, cta: null }
}

// --- today's training, for the /log dashboard ---------------------------
// One resolver feeds the START WORKOUT hero tile — the single entry point
// into today's training (the old detail card under it was removed as
// redundant): start the one open session, pick among several, or read
// "Workout complete" once everything scheduled is logged.

/** One of today's plan rows, flattened to what it takes to start it. */
export interface StartableToday {
  itemId: string
  name: string
  /** Uppercase type chip — 'STRENGTH' / 'ROUNDS FOR TIME' / 'RUN'. */
  meta: string
  /** The route that starts this session. Run rows keep a /run/log deep
   *  link for hosts without an inline sheet; the /log dashboard opens
   *  its cardio sheet via `run` instead. */
  to: string
  /** The source template id (WOD or strength) — the key `doneTemplateIds`
   *  matching uses. Null for run rows (they self-delete on save). */
  templateId: string | null
  /** Run rows: the plan ref a host needs to open the cardio log sheet
   *  and clear the item after a save. Null for template-backed rows. */
  run: { planId: string; planItemId: string; note: string | null } | null
}

/** A resolved plan row as the Today view sees it, structurally — keeps
 *  this module free of the DTO shapes in `api.ts`. `template: null` means
 *  the row points at a template that's since been deleted. */
export interface TodayRowInput {
  itemId: string
  planId: string
  note: string | null
  /** A standalone run row — no template; starts the quick-log form. */
  run: boolean
  template: { id: string; name: string; kind: 'wod' | 'strength'; wodType: string | null } | null
}

/** Flatten one row into something startable, or `null` when there is
 *  nothing to run (a deleted template). Used for the hero pick AND the
 *  Upcoming rows, so both route a given kind identically. */
export function startableFromRow(row: TodayRowInput): StartableToday | null {
  if (row.run) {
    // Pass the plan item through so a successful save clears it off the
    // schedule.
    const params = new URLSearchParams({ planId: row.planId, planItemId: row.itemId })
    if (row.note) params.set('note', row.note)
    return {
      itemId: row.itemId,
      name: row.note ?? 'Run',
      meta: 'RUN',
      to: `/run/log?${params.toString()}`,
      templateId: null,
      run: { planId: row.planId, planItemId: row.itemId, note: row.note },
    }
  }
  const tpl = row.template
  if (!tpl) return null
  if (tpl.kind === 'strength') {
    return {
      itemId: row.itemId,
      name: tpl.name,
      meta: 'STRENGTH',
      to: `/live/strength/new?templateId=${encodeURIComponent(tpl.id)}`,
      templateId: tpl.id,
      run: null,
    }
  }
  return {
    itemId: row.itemId,
    name: tpl.name,
    meta: (tpl.wodType ?? 'wod').replace(/_/g, ' ').toUpperCase(),
    to: `/live/wod/${encodeURIComponent(tpl.id)}/run`,
    templateId: tpl.id,
    run: null,
  }
}

export type TrainingCtaAction = { kind: 'nav'; to: string } | { kind: 'start-strength' }
export interface TrainingCta {
  label: string
  action: TrainingCtaAction
}

/** What a genuinely empty day offers. All three START something rather
 *  than navigating you somewhere to plan it — 'Free strength' seeds a
 *  blank live session (as the FAB does), NOT the composer's builder form
 *  that the weekly-rhythm fallback uses. "Plan your week" is deliberately
 *  absent; the Plan tab is one tap away in the bottom nav. */
export const NOTHING_SCHEDULED_CTAS: readonly TrainingCta[] = [
  { label: 'Free strength', action: { kind: 'start-strength' } },
  { label: 'Browse WODs', action: { kind: 'nav', to: '/library/wods' } },
  { label: 'Log cardio', action: { kind: 'nav', to: '/run/log' } },
]

export type TodayTraining =
  | { kind: 'session'; session: StartableToday }
  /** 2+ scheduled sessions still undone — the tile opens a picker. */
  | { kind: 'choice'; sessions: readonly StartableToday[] }
  /** Something was scheduled and it's all been logged. */
  | { kind: 'complete' }
  | { kind: 'fallback'; fallback: TodayFallback }
  | { kind: 'empty'; ctas: readonly TrainingCta[] }

/** How many workouts logged on `today` (local date) came from each
 *  template. The WOD engine stamps `payload.templateId` on every save;
 *  the strength engine stamps `payload.sourceTemplateId` for any
 *  template start (its `templateId` is custom-only — it powers "update
 *  the template" — so benchmarks would read never-done through it).
 *  Counts, not a set, so a template scheduled twice today needs two logs
 *  before both rows read done. Run rows never appear here — a saved
 *  scheduled run deletes its plan item, so it drops out of `todaysRows`
 *  instead. */
export function doneTemplateCountsOn(
  workouts: readonly WorkoutDto[],
  today: string,
): Map<string, number> {
  const done = new Map<string, number>()
  for (const w of workouts) {
    if (!w.performedAt) continue
    if (dateKey(new Date(w.performedAt)) !== today) continue
    const raw = w.payload?.sourceTemplateId ?? w.payload?.templateId
    if (typeof raw === 'string' && raw) done.set(raw, (done.get(raw) ?? 0) + 1)
  }
  return done
}

/** Today's training in priority order: scheduled sessions beat the
 *  weekly-rhythm guess, which beats the empty state. `todaysRows` is
 *  today's rows in schedule order, already flattened by `startableFromRow`
 *  — nulls (deleted templates) are dropped, so a stale row can't hide a
 *  startable one, and an all-stale day falls through to fallback/empty.
 *  `doneCounts` (from doneTemplateCountsOn) marks rows already logged —
 *  consumed row-by-row in schedule order, so a template scheduled twice
 *  with one log leaves exactly one row open. One undone row starts
 *  directly, several undone offer a choice, and a day whose every real
 *  row is done reads complete. */
export function resolveTodayTraining(
  todaysRows: readonly (StartableToday | null)[],
  fallback: TodayFallback | null,
  doneCounts: ReadonlyMap<string, number> = new Map(),
): TodayTraining {
  const rows = todaysRows.filter((r): r is StartableToday => r !== null)
  if (rows.length > 0) {
    const remaining = new Map(doneCounts)
    const undone = rows.filter((r) => {
      if (r.templateId == null) return true
      const n = remaining.get(r.templateId) ?? 0
      if (n <= 0) return true
      remaining.set(r.templateId, n - 1)
      return false
    })
    if (undone.length === 0) return { kind: 'complete' }
    const first = undone[0]!
    if (undone.length === 1) return { kind: 'session', session: first }
    return { kind: 'choice', sessions: undone }
  }
  if (fallback) return { kind: 'fallback', fallback }
  return { kind: 'empty', ctas: NOTHING_SCHEDULED_CTAS }
}

/** The START WORKOUT tile: a big line over a small qualifier. A rest day
 *  says so rather than urging a session — the tile still opens the picker
 *  if you want one anyway, and a completed day celebrates instead of
 *  nagging (tapping it offers to start another). */
export function trainingTileVm(today: TodayTraining): { value: string; sub: string } {
  if (today.kind === 'session') {
    return { value: today.session.name, sub: today.session.meta }
  }
  if (today.kind === 'choice') {
    return { value: 'Start a workout', sub: `${today.sessions.length} SCHEDULED` }
  }
  if (today.kind === 'complete') {
    return { value: 'Workout complete', sub: 'TAP TO START ANOTHER' }
  }
  if (today.kind === 'fallback') {
    if (today.fallback.type === 'rest') return { value: 'Rest day', sub: 'RECOVERY' }
    return { value: 'Start a workout', sub: today.fallback.label.toUpperCase() }
  }
  return { value: 'Start a workout', sub: 'NOTHING SCHEDULED' }
}
