// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { spanText } from './ProgressCompare.js'

describe('spanText', () => {
  it('reads "same day" for two timestamps on one local day', () => {
    expect(spanText('2026-06-22T08:00:00.000Z', '2026-06-22T18:00:00.000Z')).toBe('same day')
  })

  it('reads "1 day" for a sub-24h gap that crosses a local midnight', () => {
    // 20h apart but on different local days → never "0 days".
    const older = new Date(2026, 5, 22, 23, 0).toISOString()
    const newer = new Date(2026, 5, 23, 19, 0).toISOString()
    expect(spanText(older, newer)).toBe('1 day')
  })

  it('stays in days under two weeks', () => {
    expect(spanText('2026-06-01T12:00:00.000Z', '2026-06-10T12:00:00.000Z')).toBe('9 days')
  })

  it('switches to whole weeks at 14 days', () => {
    expect(spanText('2026-06-01T12:00:00.000Z', '2026-06-15T12:00:00.000Z')).toBe('2 weeks')
    expect(spanText('2026-05-01T12:00:00.000Z', '2026-08-28T12:00:00.000Z')).toBe('17 weeks')
  })
})
