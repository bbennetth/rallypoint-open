// Pure scheduling helpers for the My Day aggregator (slice 9b, #131).
//
// Events stores wall-clock times with NO timezone: event_days.date is a
// Postgres DATE ('YYYY-MM-DD'); event_artists / rallies start/end are
// Postgres TIME ('HH:MM' or 'HH:MM:SS'). My Day composes a date + a time
// into a comparable epoch-ms instant by treating every wall-clock value as
// UTC — a single common frame, so comparisons *within a festival day* are
// sound. It does NOT convert between zones; a festival in a non-UTC zone is
// a known v1 limitation. (Task due_date is a real timestamptz instant and is
// compared as-is by the conflict resolver.)

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/

const DAY_MS = 24 * 60 * 60 * 1000

// Compose a 'YYYY-MM-DD' date and an 'HH:MM[:SS]' time into epoch ms (UTC).
// Returns null when the time is absent or either part is malformed/out of
// range — callers treat null as "not placeable on the timeline".
export function composeInstant(date: string, time: string | null | undefined): number | null {
  if (!time) return null
  const dm = DATE_RE.exec(date)
  const tm = TIME_RE.exec(time)
  if (!dm || !tm) return null
  const year = Number(dm[1])
  const month = Number(dm[2])
  const day = Number(dm[3])
  const hour = Number(tm[1])
  const minute = Number(tm[2])
  const second = tm[3] === undefined ? 0 : Number(tm[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  if (hour > 23 || minute > 59 || second > 59) return null
  const ms = Date.UTC(year, month - 1, day, hour, minute, second)
  // Reject impossible calendar dates (e.g. 2026-02-31): Date.UTC silently
  // rolls them over, so round-trip the date part to confirm it survived.
  const back = new Date(ms)
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    return null
  }
  return ms
}

// A half-open [start, end) instant range for a lineup set.
export interface SetRange {
  start: number
  end: number
}

// Build the [start, end) range for a set on a given date. Handles the
// midnight-cross case: an end at or before the start rolls to the next day
// (e.g. a 23:00–01:00 set ends the following morning). Returns null when
// either time is missing — a set without both bounds has no detectable span.
export function setRange(
  date: string,
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): SetRange | null {
  const start = composeInstant(date, startTime)
  const end = composeInstant(date, endTime)
  if (start === null || end === null) return null
  return { start, end: end <= start ? end + DAY_MS : end }
}
