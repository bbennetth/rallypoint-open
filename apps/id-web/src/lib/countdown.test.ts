import { describe, it, expect } from 'vitest'
import { secondsRemaining } from './countdown.js'

describe('secondsRemaining', () => {
  it('returns the ceiling of the remaining seconds', () => {
    expect(secondsRemaining(10_000, 9_001)).toBe(1) // 999 ms left -> 1s
    expect(secondsRemaining(10_000, 8_500)).toBe(2) // 1500 ms left -> 2s
    expect(secondsRemaining(10_000, 7_001)).toBe(3) // 2999 ms left -> 3s
  })

  it('returns 0 when now is at or past the deadline', () => {
    expect(secondsRemaining(10_000, 10_000)).toBe(0)
    expect(secondsRemaining(10_000, 12_000)).toBe(0)
  })

  it('returns 3 for a freshly-set 3-second deadline', () => {
    const now = 1_000_000
    expect(secondsRemaining(now + 3_000, now)).toBe(3)
  })

  it('counts down across whole seconds as time advances', () => {
    const deadline = 10_000
    expect(secondsRemaining(deadline, 7_000)).toBe(3)
    expect(secondsRemaining(deadline, 8_000)).toBe(2)
    expect(secondsRemaining(deadline, 9_000)).toBe(1)
    expect(secondsRemaining(deadline, 10_000)).toBe(0)
  })

  it('never returns a negative value', () => {
    expect(secondsRemaining(0, 1_000_000)).toBe(0)
  })
})
