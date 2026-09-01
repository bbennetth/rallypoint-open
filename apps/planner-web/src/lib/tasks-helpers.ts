// Stable partition of a task list by completion, so the Tasks page can render
// open items first and tuck completed ones under a collapsed section. Both
// groups keep the API's relative order.
export function partitionTasks<T extends { completed: boolean }>(
  items: readonly T[],
): { open: T[]; completed: T[] } {
  const open: T[] = []
  const completed: T[] = []
  for (const item of items) (item.completed ? completed : open).push(item)
  return { open, completed }
}

// ── Date bucketing (Soft Ink Tasks sections, #762 PR4) ──────────────────────
// Open tasks group under Overdue / Today / This week / Later / No date
// headers. All comparisons are on the client-local calendar date — dueDate is
// a genuine instant (the BFF resolves recurring floating dues), and the
// planner convention is client-supplied local time, no stored timezone.
// "This week" is the current ISO week (Mon–Sun): on a Sunday the bucket is
// empty, since tomorrow already belongs to next week.

export type TaskBucket = 'overdue' | 'today' | 'thisWeek' | 'later' | 'undated'

export const TASK_BUCKET_ORDER: readonly TaskBucket[] = [
  'overdue',
  'today',
  'thisWeek',
  'later',
  'undated',
]

export const TASK_BUCKET_LABELS: Record<TaskBucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  thisWeek: 'This week',
  later: 'Later',
  undated: 'No date',
}

// Midnight starting the given instant's local calendar day.
function localDayStart(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function bucketTasks<
  T extends { completed: boolean; dueDate: string | null; status?: string | null },
>(items: readonly T[], now: Date): Record<TaskBucket, T[]> {
  const today = localDayStart(now)
  // Days left through Sunday of the current ISO week (getDay: Sun=0 → Mon=0).
  const daysToSunday = 6 - ((now.getDay() + 6) % 7)
  const weekEnd = localDayStart(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysToSunday),
  )

  const buckets: Record<TaskBucket, T[]> = {
    overdue: [],
    today: [],
    thisWeek: [],
    later: [],
    undated: [],
  }
  // Parsed due-day per dated item, so the sort below doesn't re-parse.
  const dueDay = new Map<T, number>()

  for (const item of items) {
    // Skipped occurrences carry completed=true, so the first check already
    // drops them; the status guard is a defensive belt should a caller
    // ever pass rows where the mirror drifted.
    if (item.completed || item.status === 'skipped') continue
    const due = item.dueDate ? new Date(item.dueDate) : null
    if (!due || Number.isNaN(due.getTime())) {
      buckets.undated.push(item)
      continue
    }
    const day = localDayStart(due)
    dueDay.set(item, day)
    if (day < today) buckets.overdue.push(item)
    else if (day === today) buckets.today.push(item)
    else if (day <= weekEnd) buckets.thisWeek.push(item)
    else buckets.later.push(item)
  }

  // Dated buckets read soonest-first; sort() is stable, so same-day items
  // keep the API's relative order. `undated` stays in API order untouched.
  for (const key of ['overdue', 'today', 'thisWeek', 'later'] as const) {
    buckets[key].sort((a, b) => (dueDay.get(a) ?? 0) - (dueDay.get(b) ?? 0))
  }
  return buckets
}

// The due chip a bucketed row shows, per the Soft Ink frame: Today rows show
// none (the header says it), This week shows the weekday, Later the date, and
// Overdue the missed date in the hot variant. `locale` exists so tests can
// pin en-US; the page passes nothing (browser default).
export function dueChip(
  bucket: TaskBucket,
  dueDate: string | null,
  locale?: string,
): { label: string; hot: boolean } | null {
  if (bucket === 'today' || bucket === 'undated') return null
  if (!dueDate) return null
  const d = new Date(dueDate)
  if (Number.isNaN(d.getTime())) return null
  if (bucket === 'thisWeek') {
    return { label: d.toLocaleDateString(locale, { weekday: 'short' }), hot: false }
  }
  return {
    label: d.toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
    hot: bucket === 'overdue',
  }
}
