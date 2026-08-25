// IANA-timezone wall-clock ↔ UTC-instant helpers, shared across apps.
//
// Several Rallypoint surfaces store times as UTC instants but must answer
// "what falls on the user's local day?" or "what instant is this local
// wall-clock time?" without a stored per-user timezone — the client supplies
// its IANA `tz` and (for day windows) a local `date` (YYYY-MM-DD). These
// helpers resolve that pair. Pure and clock-free (except localAnchor, which
// formats a caller-supplied instant), so composition stays deterministic and
// unit-testable. Dependency-free (Intl + Date only).

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/
const HMS_RE = /^\d{2}:\d{2}(:\d{2})?$/

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
  let year = f.year ?? 1970
  let month = f.month ?? 1
  let day = f.day ?? 1
  // Some engines render midnight as hour 24 on the PRECEDING date (a common
  // Intl pattern at the DST spring-forward boundary). Previously we just
  // zeroed the hour without advancing the day, which left asUtc pointing at
  // midnight of the SAME date — an off-by-24h offset. Advance the calendar by
  // one day via UTC normalisation (handles month/year rollover) when hour=24.
  let hour = f.hour ?? 0
  if (hour === 24) {
    hour = 0
    const advanced = new Date(Date.UTC(year, month - 1, day + 1))
    year = advanced.getUTCFullYear()
    month = advanced.getUTCMonth() + 1
    day = advanced.getUTCDate()
  }
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

// The UTC instant a single day+time buckets into, in `tz`. A timed day
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

// Resolve a local wall-clock ('YYYY-MM-DD' + 'HH:MM'[:SS]) in an IANA zone to a
// real UTC instant, or null when either part is malformed. The two-pass
// zonedWallClockUtc handles DST: inside the ~1h spring-forward gap (a wall
// clock with no real instant) it lands on the post-gap side rather than
// throwing — an accepted edge for capture flows where the user confirms.
export function wallClockToInstant(date: string, time: string, tz: string): Date | null {
  if (!YMD_RE.test(date) || !HMS_RE.test(time)) return null
  const d = zonedWallClockUtc(date, time, tz)
  return Number.isNaN(d.getTime()) ? null : d
}

// The user's local wall-clock anchor, derived from an instant + IANA zone.
// en-CA gives ISO 'YYYY-MM-DD'; the 24h time and weekday give a concrete "now"
// (e.g. to anchor relative-date resolution in a prompt).
export function localAnchor(
  clientNow: string,
  tz: string,
): { date: string; time: string; weekday: string } {
  const d = new Date(clientNow)
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(d)
  return { date, time, weekday }
}
