// US Federal Holidays — pure computation, no DB dependency.
// Exported from the package index for use in events-api and tests.

export interface HolidayDef {
  id: string   // e.g. 'us-federal:thanksgiving'
  name: string
}

export interface Holiday {
  id: string
  name: string
  date: string         // YYYY-MM-DD canonical date
  observedDate: string // YYYY-MM-DD with Sat→Fri, Sun→Mon shift
}

// ── Date helpers ─────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`
}

function parseYmd(s: string): { year: number; month: number; day: number } {
  const [yr, mo, dy] = s.split('-').map(Number)
  return { year: yr!, month: mo!, day: dy! }
}

// Sat (6) → Fri; Sun (0) → Mon; else unchanged.
export function observedDate(date: string): string {
  const { year, month, day } = parseYmd(date)
  const dt = new Date(year, month - 1, day)
  const dow = dt.getDay()
  if (dow === 6) {
    // Sat → Fri
    const fri = new Date(year, month - 1, day - 1)
    return ymd(fri.getFullYear(), fri.getMonth() + 1, fri.getDate())
  }
  if (dow === 0) {
    // Sun → Mon
    const mon = new Date(year, month - 1, day + 1)
    return ymd(mon.getFullYear(), mon.getMonth() + 1, mon.getDate())
  }
  return date
}

// nth occurrence of weekday in month (weekday 0=Sun..6=Sat, nth is 1-based).
export function nthWeekday(year: number, month: number, weekday: number, nth: number): string {
  const first = new Date(year, month - 1, 1)
  const firstDow = first.getDay()
  let offset = weekday - firstDow
  if (offset < 0) offset += 7
  const day = 1 + offset + (nth - 1) * 7
  return ymd(year, month, day)
}

// Last occurrence of weekday in month (weekday 0=Sun..6=Sat).
export function lastWeekday(year: number, month: number, weekday: number): string {
  const lastDay = new Date(year, month, 0).getDate()
  const last = new Date(year, month - 1, lastDay)
  const lastDow = last.getDay()
  let offset = lastDow - weekday
  if (offset < 0) offset += 7
  const day = lastDay - offset
  return ymd(year, month, day)
}

// Fixed-date holiday for a given year.
function fixedDate(year: number, month: number, day: number): string {
  return ymd(year, month, day)
}

// ── Holiday definitions ──────────────────────────────────────────────
// 11 US federal holidays.

interface HolidayRule {
  id: string
  name: string
  date: (year: number) => string
}

const HOLIDAY_RULES: HolidayRule[] = [
  {
    id: 'us-federal:new-years',
    name: "New Year's Day",
    date: (y) => fixedDate(y, 1, 1),
  },
  {
    id: 'us-federal:mlk',
    name: 'Martin Luther King Jr. Day',
    date: (y) => nthWeekday(y, 1, 1, 3), // 3rd Monday of January
  },
  {
    id: 'us-federal:washington',
    name: "Washington's Birthday",
    date: (y) => nthWeekday(y, 2, 1, 3), // 3rd Monday of February
  },
  {
    id: 'us-federal:memorial',
    name: 'Memorial Day',
    date: (y) => lastWeekday(y, 5, 1), // Last Monday of May
  },
  {
    id: 'us-federal:juneteenth',
    name: 'Juneteenth National Independence Day',
    date: (y) => fixedDate(y, 6, 19),
  },
  {
    id: 'us-federal:independence',
    name: 'Independence Day',
    date: (y) => fixedDate(y, 7, 4),
  },
  {
    id: 'us-federal:labor',
    name: 'Labor Day',
    date: (y) => nthWeekday(y, 9, 1, 1), // 1st Monday of September
  },
  {
    id: 'us-federal:columbus',
    name: 'Columbus Day',
    date: (y) => nthWeekday(y, 10, 1, 2), // 2nd Monday of October
  },
  {
    id: 'us-federal:veterans',
    name: 'Veterans Day',
    date: (y) => fixedDate(y, 11, 11),
  },
  {
    id: 'us-federal:thanksgiving',
    name: 'Thanksgiving Day',
    date: (y) => nthWeekday(y, 11, 4, 4), // 4th Thursday of November
  },
  {
    id: 'us-federal:christmas',
    name: 'Christmas Day',
    date: (y) => fixedDate(y, 12, 25),
  },
]

// ── Public API ───────────────────────────────────────────────────────

// Returns the HolidayDef catalog (id + name, no year).
export function getHolidayDefs(): HolidayDef[] {
  return HOLIDAY_RULES.map((r) => ({ id: r.id, name: r.name }))
}

/**
 * Returns all US federal holidays whose observedDate falls in [fromYmd, toYmd]
 * inclusive, sorted by observedDate ascending.
 */
export function expandHolidays(fromYmd: string, toYmd: string): Holiday[] {
  const { year: fromYear } = parseYmd(fromYmd)
  const { year: toYear } = parseYmd(toYmd)

  const results: Holiday[] = []

  for (let year = fromYear; year <= toYear; year++) {
    for (const rule of HOLIDAY_RULES) {
      const date = rule.date(year)
      const obs = observedDate(date)
      // Include if observed date falls in window
      if (obs >= fromYmd && obs <= toYmd) {
        results.push({ id: rule.id, name: rule.name, date, observedDate: obs })
      }
    }
  }

  // Sort by observedDate
  results.sort((a, b) => a.observedDate.localeCompare(b.observedDate))

  return results
}
