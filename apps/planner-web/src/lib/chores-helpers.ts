import type { CreateTaskSeriesInput, MyDayTask } from './api.js'
import { SHOW_CHORES_IN_FEEDS_KEY } from './api.js'

// Pure decision helpers for the Chores surface (#546). Kept out of the React
// component so they can be unit-tested in isolation (no DOM).

export type ChoreFreq = 'daily' | 'weekly'
export type ChoreBound = 'count' | 'until' | 'forever'

export interface ChoreRecurrenceForm {
  title: string
  freq: ChoreFreq
  interval: number
  byDay: string[]
  dtstart: string
  bound: ChoreBound
  count: number
  until: string
  timeOfDay: string
}

// Build the CreateTaskSeriesInput from the recurrence form state, or return an
// error string when the form is invalid (e.g. an 'until' bound with no date).
// Mirrors the inline logic in TasksPage.onCreateItem so the two stay in lockstep
// while staying testable. byDay is weekly-only; an 'until' bound requires a date.
export function buildChoreSeriesInput(
  form: ChoreRecurrenceForm,
): { ok: true; input: CreateTaskSeriesInput } | { ok: false; error: string } {
  const title = form.title.trim()
  if (!title) return { ok: false, error: 'Enter a chore name.' }

  const input: CreateTaskSeriesInput = {
    title,
    freq: form.freq,
    interval: form.interval,
    dtstart: form.dtstart,
  }
  if (form.freq === 'weekly' && form.byDay.length > 0) input.byDay = form.byDay
  if (form.timeOfDay) input.timeOfDay = form.timeOfDay
  if (form.bound === 'count') input.count = form.count
  else if (form.bound === 'until') {
    if (!form.until) {
      return { ok: false, error: 'Pick an end date, or choose a different end condition.' }
    }
    input.until = form.until
  }
  return { ok: true, input }
}

// Pure read of the chores-in-feeds setting from a planner settings blob.
// Absent → true (ON by default); only an explicit `false` turns it off.
// Mirrors the server-side choresInFeedsEnabled so client + BFF agree.
export function choresInFeedsEnabled(settings: Record<string, unknown>): boolean {
  return settings[SHOW_CHORES_IN_FEEDS_KEY] !== false
}

// Split a My Day task list into (non-chore tasks, chore tasks). Used by the
// agenda renderer to lift chores out of the All-day / Schedule lists into
// their own always-visible "Chores" section.
//
// When `choresListId` is null (no chores list yet, or the lookup hadn't
// resolved at split time) the input is returned untouched as `tasks` with no
// chores. Order is preserved within each bucket.
export function splitChoresFromTasks(
  tasks: MyDayTask[],
  choresListId: string | null,
): { tasks: MyDayTask[]; chores: MyDayTask[] } {
  if (!choresListId) return { tasks, chores: [] }
  const out: { tasks: MyDayTask[]; chores: MyDayTask[] } = { tasks: [], chores: [] }
  for (const t of tasks) {
    if (t.listId === choresListId) out.chores.push(t)
    else out.tasks.push(t)
  }
  return out
}

// Pure decision: how should a pending check-in input be committed into the
// running added-tasks list? Splits on newlines, trims each line, drops
// blanks, and skips entries whose title already appears (case-insensitive,
// whitespace-collapsed) in `existing` or earlier in the same paste. Returns
// the next list (never mutates the input).
export interface CheckinDraftTask {
  // Client-side identifier for the pending row before commit. Format
  // `mc-<index>` so tests are deterministic; the commit-to-server path
  // discards these and uses the real lit_… id returned by createTaskItem.
  id: string
  title: string
}

export function commitCheckinInput(
  input: string,
  existing: readonly CheckinDraftTask[],
  idPrefix = 'mc',
): CheckinDraftTask[] {
  const trimmed = input.trim()
  if (!trimmed) return [...existing]
  const seen = new Set(existing.map((t) => normTitle(t.title)))
  // Find the highest numeric suffix among existing IDs so new additions never
  // collide with a survivor after a remove+add cycle. The old length-based
  // counter (existing.length + additions.length) reused IDs when the user
  // removed earlier items, producing duplicate React keys and corrupting
  // which row the × button removed.
  let nextSeq = existing.length
  const suffixRe = new RegExp(`^${escapeRegex(idPrefix)}-(\\d+)$`)
  for (const t of existing) {
    const m = suffixRe.exec(t.id)
    if (!m) continue
    const n = Number.parseInt(m[1]!, 10)
    if (Number.isFinite(n) && n + 1 > nextSeq) nextSeq = n + 1
  }
  const additions: CheckinDraftTask[] = []
  for (const raw of trimmed.split('\n')) {
    const title = raw.trim()
    if (!title) continue
    const key = normTitle(title)
    if (seen.has(key)) continue
    seen.add(key)
    additions.push({ id: `${idPrefix}-${nextSeq + additions.length}`, title })
  }
  return [...existing, ...additions]
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normTitle(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

// Compact trailing label for a chore row on the My Day Chores section.
//
//   • "Today" when there's no series and the chore's due-day matches today
//     (the handoff calls these out as "Today" rather than the dated form).
//   • "Daily" / "Weekly" / "Every 2 days" / "Every 2 weeks" when the chore is
//     an occurrence of a recurring series.
//   • Otherwise the localized short date ("Jun 28") for one-off chores with a
//     dueYmd, or "" when truly undated.
//
// Pure for unit testing — the caller resolves the chore's `dueYmd`
// (local-zone YYYY-MM-DD via planner-helpers.localYmd) and supplies the
// locale-sensitive date label so this helper never touches Intl directly.
export function formatChoreTrailingLabel(args: {
  dueYmd: string | null
  todayYmd: string
  seriesFreq: 'daily' | 'weekly' | null
  seriesInterval: number | null
  dateLabel: (dueYmd: string) => string
}): string {
  const { dueYmd, todayYmd, seriesFreq, seriesInterval } = args
  if (seriesFreq) {
    const interval = seriesInterval && seriesInterval > 0 ? seriesInterval : 1
    if (seriesFreq === 'daily') {
      return interval === 1 ? 'Daily' : `Every ${interval} days`
    }
    return interval === 1 ? 'Weekly' : `Every ${interval} weeks`
  }
  if (!dueYmd) return ''
  if (dueYmd === todayYmd) return 'Today'
  return args.dateLabel(dueYmd)
}
