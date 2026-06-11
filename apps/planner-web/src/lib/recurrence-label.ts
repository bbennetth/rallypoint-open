// Pure, display-only helpers for recurring task series in Planner.
//
// The Recurring section reads series *rules* directly (the BFF computes a
// bounded next-occurrence preview without materializing), so the UI needs
// to turn an RFC-5545-subset rule into a human phrase ("Every weekday",
// "Every 2 weeks on Mon, Wed") and to summarize the upcoming dates. These
// are kept pure (no React/DOM, UTC-deterministic) so they're unit-testable.

export type RecurrenceFreq = 'daily' | 'weekly'

/** The subset of a series rule needed to describe it. */
export interface RecurrenceRuleLike {
  freq: RecurrenceFreq
  interval: number
  byDay?: string[] | null
  until?: string | null
  count?: number | null
}

// RFC BYDAY codes in week order (Mon-first, matching lists-shared DAY_CODES).
const DAY_ORDER = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
const DAY_LABEL: Record<string, string> = {
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
}
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR']
const WEEKEND = ['SA', 'SU']

function ymdToUtc(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1))
}

/** "Jun 11, 2026" — stable across runner timezones (formatted in UTC). */
export function formatRuleDate(ymd: string): string {
  return ymdToUtc(ymd).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function sortDays(days: string[]): string[] {
  return days
    .filter((d) => d in DAY_LABEL)
    .sort((a, b) => DAY_ORDER.indexOf(a as never) - DAY_ORDER.indexOf(b as never))
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((d) => set.has(d))
}

function dayList(days: string[]): string {
  return sortDays(days)
    .map((d) => DAY_LABEL[d])
    .join(', ')
}

function freqPhrase(rule: RecurrenceRuleLike): string {
  const interval = rule.interval > 0 ? rule.interval : 1
  if (rule.freq === 'daily') {
    return interval === 1 ? 'Every day' : `Every ${interval} days`
  }
  // weekly
  const days = sortDays(rule.byDay ?? [])
  if (interval === 1) {
    if (days.length === 0) return 'Weekly'
    if (sameSet(days, WEEKDAYS)) return 'Every weekday'
    if (sameSet(days, WEEKEND)) return 'Every weekend'
    return `Weekly on ${dayList(days)}`
  }
  return days.length === 0
    ? `Every ${interval} weeks`
    : `Every ${interval} weeks on ${dayList(days)}`
}

function terminationPhrase(rule: RecurrenceRuleLike): string {
  if (rule.until) return `until ${formatRuleDate(rule.until)}`
  if (rule.count && rule.count > 0) return `· ${rule.count} times`
  return ''
}

/** Human-readable description of a recurrence rule, e.g.
 * "Every weekday", "Every 2 weeks on Mon, Wed until Jun 11, 2026". */
export function describeRecurrence(rule: RecurrenceRuleLike): string {
  const base = freqPhrase(rule)
  const suffix = terminationPhrase(rule)
  return suffix ? `${base} ${suffix}` : base
}

/** First upcoming occurrence date (YYYY-MM-DD), or null when the preview
 * window is empty (finite series already exhausted). */
export function nextOccurrence(next: readonly string[] | null | undefined): string | null {
  return next && next.length > 0 ? next[0] : null
}

/** Short upcoming-dates summary for a series row, e.g.
 * "Next Jun 11 · then Jun 15, Jun 18". Returns "No upcoming dates" when empty.
 * `limit` caps how many dates are shown (min 1); with `limit <= 1` only the
 * next date is emitted ("Next Jun 11", no "· then …" suffix). */
export function summarizeNext(next: readonly string[] | null | undefined, limit = 3): string {
  const dates = (next ?? []).slice(0, Math.max(1, limit))
  if (dates.length === 0) return 'No upcoming dates'
  const [first, ...rest] = dates.map((d) => formatRuleDateShort(d))
  return rest.length ? `Next ${first} · then ${rest.join(', ')}` : `Next ${first}`
}

/** "Jun 11" — month + day only, for compact rows. */
export function formatRuleDateShort(ymd: string): string {
  return ymdToUtc(ymd).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}
