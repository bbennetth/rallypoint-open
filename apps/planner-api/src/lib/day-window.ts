// UTC instant bounds of a single local calendar day in a given IANA timezone.
//
// The planner session carries no timezone (see context.ts) and personal-event
// rows store times as UTC instants, so "what falls on the user's today?" can
// only be answered if the client tells us its local `date` (YYYY-MM-DD) and
// IANA `tz`. This resolves that pair into the half-open UTC window
// [start, end) that both the Lists due-date filter and the Events start_at
// window share. Pure and clock-free so My Day / Upcoming composition stays
// deterministic and unit-testable.

// Offset (ms) from UTC for `instant` in `tz`: read the wall clock in `tz`,
// reinterpret those fields as if they were UTC, and subtract the real instant.
// Positive east of UTC (e.g. +19_800_000 for Asia/Kolkata, +05:30).
function tzOffsetMs(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const f: Record<string, number> = {}
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== 'literal') f[p.type] = Number(p.value)
  }
  const year = f.year ?? 1970
  const month = f.month ?? 1
  const day = f.day ?? 1
  // Some engines render midnight as hour 24; normalise to 0.
  const rawHour = f.hour ?? 0
  const hour = rawHour === 24 ? 0 : rawHour
  const asUtc = Date.UTC(year, month - 1, day, hour, f.minute ?? 0, f.second ?? 0)
  return asUtc - instant.getTime()
}

// The UTC instant of a wall-clock time (`date` at HH:MM[:SS]) in `tz`. Two
// passes converge across DST gaps/overlaps: estimate the offset at the naive
// UTC reading, correct by it, then re-read the offset at the corrected instant
// (which lands on the right side of any transition).
function zonedWallClockUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const [hh, mm, ss] = time.split(':').map(Number) as [number, number, number?]
  const naive = Date.UTC(y, m - 1, d, hh, mm, ss ?? 0)
  const off1 = tzOffsetMs(new Date(naive), tz)
  const off2 = tzOffsetMs(new Date(naive - off1), tz)
  return new Date(naive - off2)
}

// The UTC instant of wall-clock midnight (`date` at 00:00:00) in `tz`.
function zonedMidnightUtc(date: string, tz: string): Date {
  return zonedWallClockUtc(date, '00:00:00', tz)
}

// The UTC instant a single event day buckets into, in `tz`. A timed day
// (startTime set) resolves to that wall-clock time on `date`; an all-day day
// (startTime null) pins to the start of the local day so it sorts to the top
// of, and buckets into, the right calendar day.
export function dayInstant(date: string, startTime: string | null, tz: string): string {
  const d = startTime == null ? zonedMidnightUtc(date, tz) : zonedWallClockUtc(date, startTime, tz)
  return d.toISOString()
}

// The calendar date one day after `date` (YYYY-MM-DD), with month/year
// rollover handled by UTC normalisation.
export function nextCalendarDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

export interface DayWindow {
  start: string // ISO instant, inclusive — local midnight of `date`
  end: string // ISO instant, exclusive — local midnight of the next day
}

// The half-open UTC window covering all of local `date` in `tz`.
export function zonedDayWindow(date: string, tz: string): DayWindow {
  return {
    start: zonedMidnightUtc(date, tz).toISOString(),
    end: zonedMidnightUtc(nextCalendarDate(date), tz).toISOString(),
  }
}
