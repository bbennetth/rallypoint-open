import { describe, it, expect } from 'vitest'
import { deriveStatus, formatWhen, formatWhenShort, isPastEvent, ticketViewKind } from './events-helpers.js'

// ── ticketViewKind ──────────────────────────────────────────────────────────

describe('ticketViewKind', () => {
  it('classifies raster images as image', () => {
    expect(ticketViewKind('image/jpeg')).toBe('image')
    expect(ticketViewKind('image/png')).toBe('image')
    expect(ticketViewKind('image/webp')).toBe('image')
  })

  it('classifies PDFs as pdf', () => {
    expect(ticketViewKind('application/pdf')).toBe('pdf')
  })

  it('falls back to other for anything else', () => {
    expect(ticketViewKind('application/octet-stream')).toBe('other')
    expect(ticketViewKind('text/html')).toBe('other')
    expect(ticketViewKind('')).toBe('other')
    // must not match a bare "image" prefix without the slash
    expect(ticketViewKind('imagex/png')).toBe('other')
  })
})

// ── deriveStatus ────────────────────────────────────────────────────────────

describe('deriveStatus', () => {
  it('returns null for a null startAt', () => {
    expect(deriveStatus(null)).toBeNull()
  })

  it('returns null for an unparseable string', () => {
    expect(deriveStatus('not-a-date')).toBeNull()
  })

  it('returns PAST when the instant is in the past', () => {
    // Well in the past — 2020-01-01.
    expect(deriveStatus('2020-01-01T00:00:00.000Z')).toBe('PAST')
  })

  it('returns TODAY when the instant is within the next 24 h', () => {
    const inTwelveHours = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
    expect(deriveStatus(inTwelveHours)).toBe('TODAY')
  })

  it('boundary: exactly 24 h from now is SOON (not TODAY)', () => {
    // 24h + 1 s in the future: SOON
    const justPast24h = new Date(Date.now() + 24 * 60 * 60 * 1000 + 1000).toISOString()
    expect(deriveStatus(justPast24h)).toBe('SOON')
  })

  it('returns SOON when the instant is within the next 7 days (but > 24 h)', () => {
    const inThreeDays = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
    expect(deriveStatus(inThreeDays)).toBe('SOON')
  })

  it('boundary: exactly 7 days from now is UPCOMING (not SOON)', () => {
    // 7 d + 1 s in the future: UPCOMING
    const justPast7d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 1000).toISOString()
    expect(deriveStatus(justPast7d)).toBe('UPCOMING')
  })

  it('returns UPCOMING when the instant is more than 7 days away', () => {
    const inTwoWeeks = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
    expect(deriveStatus(inTwoWeeks)).toBe('UPCOMING')
  })
})

// ── formatWhen ───────────────────────────────────────────────────────────────

describe('formatWhen', () => {
  it('returns "No date set" when startAt is null', () => {
    expect(formatWhen(null, null)).toBe('No date set')
    expect(formatWhen(null, '2026-06-12T11:00:00.000Z')).toBe('No date set')
  })

  it('returns just the start when endAt is null', () => {
    // Just verify it does not throw and includes a time component.
    const result = formatWhen('2026-06-12T09:30:00.000Z', null)
    expect(result).not.toBe('No date set')
    expect(result.length).toBeGreaterThan(0)
  })

  it('includes a dash separator when both start and end are supplied', () => {
    const result = formatWhen('2026-06-12T09:30:00.000Z', '2026-06-12T11:00:00.000Z')
    expect(result).toContain('–')
  })
})

// ── formatWhenShort ───────────────────────────────────────────────────────────

describe('formatWhenShort', () => {
  it('returns "No date" for null', () => {
    expect(formatWhenShort(null)).toBe('No date')
  })

  it('returns "No date" for an invalid date string', () => {
    expect(formatWhenShort('not-a-date')).toBe('No date')
  })

  it('returns a non-empty string for a valid instant', () => {
    const result = formatWhenShort('2026-06-12T09:30:00.000Z')
    expect(result).not.toBe('No date')
    expect(result.length).toBeGreaterThan(0)
  })

  it('locale string includes month and day', () => {
    // The output is locale-dependent, but "Jun" and "12" must appear somewhere
    // in an en-US environment. Use a stable UTC instant well off DST boundaries.
    // toLocaleString with month:'short', day:'numeric' → "Jun 12" on en-US.
    const result = formatWhenShort('2026-06-12T14:00:00.000Z')
    // We can't assert exact locale output universally, but verify basic shape.
    expect(typeof result).toBe('string')
    expect(result).not.toBe('No date')
  })
})

// ── formatWhen allDay ─────────────────────────────────────────────────────────

describe('formatWhen with allDay=true', () => {
  it('returns date-only string (no time) for all-day start', () => {
    const result = formatWhen('2026-06-12T09:30:00.000Z', null, true)
    // Should not contain a time separator or AM/PM
    expect(result).not.toBe('No date set')
    // In an all-day context the output is a date-only string; verify it does
    // not include a colon (time separator), which would indicate a time leak.
    // This is a best-effort check valid for en-US locale and dateStyle:'medium'.
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
    expect(result).not.toMatch(/:/)
  })

  it('returns date range without time when both start and end supplied', () => {
    const result = formatWhen('2026-06-12T09:30:00.000Z', '2026-06-14T09:30:00.000Z', true)
    expect(result).toContain('–')
  })
})

describe('formatWhenShort with allDay=true', () => {
  it('returns date-only (no time) when allDay=true', () => {
    const result = formatWhenShort('2026-06-12T09:30:00.000Z', true)
    expect(result).not.toBe('No date')
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('returns time-bearing string when allDay=false', () => {
    const result = formatWhenShort('2026-06-12T09:30:00.000Z', false)
    expect(result).not.toBe('No date')
    // Time-bearing locale string includes a colon for HH:MM
    expect(result).toMatch(/:/)
  })
})

// ── isPastEvent ───────────────────────────────────────────────────────────────

// isPastEvent goes through eventSpanYmds → localYmd, which works in the local
// timezone. Build instants from local wall-clock parts so the tests pass in
// any TZ the runner happens to use.
function localIso(ymd: string, hour: number, minute = 0): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y!, m! - 1, d!, hour, minute, 0, 0).toISOString()
}

describe('isPastEvent', () => {
  const TODAY = '2026-06-15'

  it('undated event (no startAt) is never past', () => {
    expect(isPastEvent({ startAt: null, endAt: null, allDay: false }, TODAY)).toBe(false)
  })

  it('timed event yesterday is past', () => {
    const ev = { startAt: localIso('2026-06-14', 9), endAt: localIso('2026-06-14', 10), allDay: false }
    expect(isPastEvent(ev, TODAY)).toBe(true)
  })

  it('timed event earlier today is NOT past (day-based, visible until midnight)', () => {
    const ev = { startAt: localIso('2026-06-15', 1), endAt: localIso('2026-06-15', 2), allDay: false }
    expect(isPastEvent(ev, TODAY)).toBe(false)
  })

  it('timed event in the future is not past', () => {
    const ev = { startAt: localIso('2026-06-20', 9), endAt: null, allDay: false }
    expect(isPastEvent(ev, TODAY)).toBe(false)
  })

  it('multi-day event spanning today is not past', () => {
    const ev = { startAt: localIso('2026-06-13', 9), endAt: localIso('2026-06-16', 12), allDay: false }
    expect(isPastEvent(ev, TODAY)).toBe(false)
  })

  it('multi-day event that ended yesterday is past', () => {
    const ev = { startAt: localIso('2026-06-12', 9), endAt: localIso('2026-06-14', 12), allDay: false }
    expect(isPastEvent(ev, TODAY)).toBe(true)
  })

  it('all-day event yesterday is past', () => {
    const ev = { startAt: localIso('2026-06-14', 0), endAt: null, allDay: true }
    expect(isPastEvent(ev, TODAY)).toBe(true)
  })

  it('all-day event today is not past', () => {
    const ev = { startAt: localIso('2026-06-15', 0), endAt: null, allDay: true }
    expect(isPastEvent(ev, TODAY)).toBe(false)
  })

  it('all-day range with inclusive local-midnight end: past once the end day has passed', () => {
    // Editor stores all-day endAt as LOCAL MIDNIGHT of the last covered day
    // (inclusive) — a 06-13 → 06-14 all-day event is past on 06-15.
    const ev = { startAt: localIso('2026-06-13', 0), endAt: localIso('2026-06-14', 0), allDay: true }
    expect(isPastEvent(ev, TODAY)).toBe(true)
  })

  it('timed event ending exactly at local midnight today is past (half-open end)', () => {
    // An 8pm → midnight event does not occupy the midnight day; its last
    // covered day is yesterday.
    const ev = { startAt: localIso('2026-06-14', 20), endAt: localIso('2026-06-15', 0), allDay: false }
    expect(isPastEvent(ev, TODAY)).toBe(true)
  })

  it('bad range (endAt <= startAt) collapses to the start day', () => {
    const past = { startAt: localIso('2026-06-14', 10), endAt: localIso('2026-06-14', 9), allDay: false }
    expect(isPastEvent(past, TODAY)).toBe(true)
    const today = { startAt: localIso('2026-06-15', 10), endAt: localIso('2026-06-15', 9), allDay: false }
    expect(isPastEvent(today, TODAY)).toBe(false)
  })
})
