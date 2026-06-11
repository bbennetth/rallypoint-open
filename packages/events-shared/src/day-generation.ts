// Quick-create event days from a date range (issue #191, slice "1A").
// Pure + framework-agnostic so apps/events-api generates rows server-side
// and apps/events-web can preview the same result. The event_days table
// has unique (event_id, date) and (event_id, day_label) indexes, so the
// caller passes the dates that already exist and we skip them; labels
// continue numbering past the days already on the event.

const DAY_MS = 86_400_000
// Upper bound on a single generation so a pathological range (or a typo
// in the year) can't mint thousands of rows. A year of festival days is
// already absurd; 366 is a safe ceiling.
const MAX_DAYS = 366

export interface GenerateDaysInput {
  /** Inclusive range start, 'YYYY-MM-DD'. */
  startDate: string
  /** Inclusive range end, 'YYYY-MM-DD'. */
  endDate: string
  /** Dates ('YYYY-MM-DD') already on the event — these are skipped. */
  existing?: readonly string[]
  /**
   * First "Day N" number to assign. Defaults to existing.length + 1 so
   * generated labels continue past days already present without colliding.
   */
  startIndex?: number
}

export interface GeneratedDay {
  dayLabel: string
  date: string
}

// Parse a 'YYYY-MM-DD' string to a UTC epoch, rejecting non-calendar dates
// (e.g. 2026-02-30). Returns null on any malformed/invalid input.
function toUtcEpoch(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const t = Date.UTC(y, mo - 1, d)
  const dt = new Date(t)
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null
  }
  return t
}

function formatUtc(t: number): string {
  const dt = new Date(t)
  const y = dt.getUTCFullYear()
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const d = String(dt.getUTCDate()).padStart(2, '0')
  return `${y}-${mo}-${d}`
}

/**
 * Produce one { dayLabel, date } per calendar date from startDate to
 * endDate inclusive, skipping any date already in `existing`. Labels are
 * "Day N" numbered contiguously for the generated days, starting at
 * startIndex (default existing.length + 1). Returns [] for an invalid or
 * inverted range.
 */
export function generateDays(input: GenerateDaysInput): GeneratedDay[] {
  const start = toUtcEpoch(input.startDate)
  const end = toUtcEpoch(input.endDate)
  if (start === null || end === null || end < start) return []

  const existing = new Set(input.existing ?? [])
  let index = input.startIndex ?? (input.existing?.length ?? 0) + 1

  const out: GeneratedDay[] = []
  let iterations = 0
  for (let t = start; t <= end && iterations < MAX_DAYS; t += DAY_MS, iterations++) {
    const date = formatUtc(t)
    if (existing.has(date)) continue
    out.push({ dayLabel: `Day ${index}`, date })
    index++
  }
  return out
}

// A day's optional time window follows the "date + optional times" model:
// both null = all-day, both set = a timed window. Unlike a lineup set
// (which may cross midnight), a day's own window must not end before it
// starts. Returns the first rule broken, or null when valid. Inputs are
// 'HH:MM' (or null/undefined for "not set").
export type DayTimesIssue = 'both_required' | 'end_before_start'

export function dayTimesIssue(
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): DayTimesIssue | null {
  const s = startTime ?? null
  const e = endTime ?? null
  if ((s === null) !== (e === null)) return 'both_required'
  if (s !== null && e !== null && e < s) return 'end_before_start'
  return null
}
