import { expandHolidays } from '@rallypoint/events-shared'

// Holidays SDK core. Pure computation — no deps needed.
// The handler validates the YYYY-MM-DD shape + 3-year cap and translates
// failures to the route's 422 envelope; the core fn assumes well-formed
// input and just expands the window.

export type HolidayValidationError =
  | { kind: 'missing_window' }
  | { kind: 'bad_from' }
  | { kind: 'bad_to' }
  | { kind: 'from_after_to' }
  | { kind: 'window_too_large' }

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_SPAN_DAYS = 366 * 3

function isValidYmd(s: string): boolean {
  if (!YMD_RE.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y!, m! - 1, d!)
  return dt.getFullYear() === y && dt.getMonth() + 1 === m && dt.getDate() === d
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = new Date(fromYmd).getTime()
  const b = new Date(toYmd).getTime()
  return Math.round((b - a) / 86_400_000)
}

export function validateHolidaysWindow(
  from: string | undefined,
  to: string | undefined,
): HolidayValidationError | { kind: 'ok'; from: string; to: string } {
  if (!from || !to) return { kind: 'missing_window' }
  if (!isValidYmd(from)) return { kind: 'bad_from' }
  if (!isValidYmd(to)) return { kind: 'bad_to' }
  if (from > to) return { kind: 'from_after_to' }
  if (daysBetween(from, to) > MAX_SPAN_DAYS) return { kind: 'window_too_large' }
  return { kind: 'ok', from, to }
}

export interface HolidayDto {
  id: string
  name: string
  date: string
  observedDate: string
}

export function listHolidaysCore(from: string, to: string): HolidayDto[] {
  return expandHolidays(from, to) as HolidayDto[]
}
