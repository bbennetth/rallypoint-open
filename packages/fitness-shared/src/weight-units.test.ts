import { describe, it, expect } from 'vitest'
import { KG_PER_LB, scanLoadToKg } from './weight-units.js'

describe('scanLoadToKg', () => {
  it('converts a pounds board load to storage kg', () => {
    // "155/105 lbs" on a whiteboard — the Rx load the scan takes first.
    expect(scanLoadToKg(155, 'lb')).toBe(70.31)
    expect(scanLoadToKg(95, 'lb')).toBe(43.09)
  })

  it('passes kg through, stripping float noise', () => {
    expect(scanLoadToKg(70, 'kg')).toBe(70)
    expect(scanLoadToKg(70.3125, 'kg')).toBe(70.31)
  })

  it('round-trips a pounds load back to the same whole pounds', () => {
    // The composer seeds rows via kgToDisplay(kg, 'lb'), which rounds to
    // whole pounds. A scan of 155 lb must come back out as 155, not 154.
    const kg = scanLoadToKg(155, 'lb')
    expect(Math.round(kg / KG_PER_LB)).toBe(155)
  })

  it('handles zero and rejects non-finite input', () => {
    expect(scanLoadToKg(0, 'lb')).toBe(0)
    expect(scanLoadToKg(0, 'kg')).toBe(0)
    expect(scanLoadToKg(Number.NaN, 'lb')).toBe(0)
    expect(scanLoadToKg(Number.POSITIVE_INFINITY, 'kg')).toBe(0)
  })
})
