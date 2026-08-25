import { describe, it, expect } from 'vitest'
import { PutMemberLocationSchema } from './location-validators.js'

describe('PutMemberLocationSchema', () => {
  it('accepts a full pin', () => {
    const r = PutMemberLocationSchema.safeParse({ layer: 'site', xPct: 42.5, yPct: 61 })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toEqual({ layer: 'site', xPct: 42.5, yPct: 61 })
  })

  it('accepts the boundary percentages', () => {
    expect(PutMemberLocationSchema.safeParse({ layer: 'camp', xPct: 0, yPct: 100 }).success).toBe(
      true,
    )
  })

  it('rejects a missing field', () => {
    expect(PutMemberLocationSchema.safeParse({ layer: 'site', xPct: 10 }).success).toBe(false)
    expect(PutMemberLocationSchema.safeParse({ xPct: 10, yPct: 20 }).success).toBe(false)
  })

  it('rejects out-of-range percentages', () => {
    expect(PutMemberLocationSchema.safeParse({ layer: 'site', xPct: -1, yPct: 20 }).success).toBe(
      false,
    )
    expect(PutMemberLocationSchema.safeParse({ layer: 'site', xPct: 10, yPct: 101 }).success).toBe(
      false,
    )
  })

  it('rejects a bogus layer', () => {
    expect(
      PutMemberLocationSchema.safeParse({ layer: 'parking', xPct: 10, yPct: 20 }).success,
    ).toBe(false)
  })
})
