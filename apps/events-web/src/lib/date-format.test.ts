import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { formatEventDay } from './date-format.js'

// Pinned to America/Los_Angeles (UTC-7 in June) so the UTC-vs-local divergence
// is observable even on UTC CI hosts. Under UTC the old buggy `new Date(str)`
// path and the fixed one print the same day, so the regression would be
// invisible without pinning to a negative-offset zone.
describe('formatEventDay', () => {
  const ORIG_TZ = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'America/Los_Angeles'
  })
  afterAll(() => {
    if (ORIG_TZ === undefined) delete process.env.TZ
    else process.env.TZ = ORIG_TZ
  })

  it('renders the named calendar day, not a UTC-shifted one', () => {
    // `new Date('2026-06-12')` is the 11th locally in LA; the helper must still
    // show the 12th — the day the event actually happens.
    expect(formatEventDay('2026-06-12', 'medium')).toBe('Jun 12, 2026')
    expect(formatEventDay('2026-06-12', 'long')).toBe('June 12, 2026')
  })

  it('defaults to the long style', () => {
    expect(formatEventDay('2026-01-01')).toBe('January 1, 2026')
  })

  it('uses only the date part of a full ISO instant', () => {
    expect(formatEventDay('2026-06-12T00:00:00.000Z', 'medium')).toBe('Jun 12, 2026')
  })

  it('returns an em dash for null / blank / malformed input', () => {
    expect(formatEventDay(null)).toBe('—')
    expect(formatEventDay('')).toBe('—')
    expect(formatEventDay('not-a-date')).toBe('—')
  })
})
