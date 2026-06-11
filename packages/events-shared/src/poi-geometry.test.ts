import { describe, it, expect } from 'vitest'
import {
  clampPct,
  isValidPct,
  pctToPixels,
  pixelsToPct,
  isPointInPolygon,
} from './poi-geometry.js'

describe('clampPct', () => {
  it.each([
    [-5, 0],
    [0, 0],
    [42.5, 42.5],
    [100, 100],
    [120, 100],
  ])('clamps %s → %s', (input, expected) => {
    expect(clampPct(input)).toBe(expected)
  })

  it('treats NaN as 0', () => {
    expect(clampPct(Number.NaN)).toBe(0)
  })
})

describe('isValidPct', () => {
  it.each([0, 50, 100])('accepts %s', (v) => expect(isValidPct(v)).toBe(true))
  it.each([-0.1, 100.1, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s', (v) =>
    expect(isValidPct(v)).toBe(false),
  )
})

describe('pctToPixels / pixelsToPct round-trip', () => {
  const box = { width: 800, height: 400 }

  it('maps a percentage point to pixels', () => {
    expect(pctToPixels({ xPct: 50, yPct: 25 }, box)).toEqual({ x: 400, y: 100 })
  })

  it('maps pixels back to a percentage point', () => {
    expect(pixelsToPct({ x: 400, y: 100 }, box)).toEqual({ xPct: 50, yPct: 25 })
  })

  it('round-trips without drift', () => {
    const start = { xPct: 33.33, yPct: 66.67 }
    const px = pctToPixels(start, box)
    const back = pixelsToPct(px, box)
    expect(back.xPct).toBeCloseTo(start.xPct, 5)
    expect(back.yPct).toBeCloseTo(start.yPct, 5)
  })

  it('clamps an overshooting drag back into range', () => {
    expect(pixelsToPct({ x: 1000, y: -50 }, box)).toEqual({ xPct: 100, yPct: 0 })
  })

  it('guards against a zero-size box', () => {
    expect(pixelsToPct({ x: 10, y: 10 }, { width: 0, height: 0 })).toEqual({ xPct: 0, yPct: 0 })
  })
})

describe('isPointInPolygon', () => {
  const square = [
    { xPct: 10, yPct: 10 },
    { xPct: 90, yPct: 10 },
    { xPct: 90, yPct: 90 },
    { xPct: 10, yPct: 90 },
  ]

  it('returns true for a point inside', () => {
    expect(isPointInPolygon({ xPct: 50, yPct: 50 }, square)).toBe(true)
  })

  it('returns false for a point outside', () => {
    expect(isPointInPolygon({ xPct: 5, yPct: 5 }, square)).toBe(false)
    expect(isPointInPolygon({ xPct: 95, yPct: 50 }, square)).toBe(false)
  })

  it('returns false for a degenerate ring (< 3 vertices)', () => {
    expect(isPointInPolygon({ xPct: 50, yPct: 50 }, [{ xPct: 0, yPct: 0 }])).toBe(false)
    expect(isPointInPolygon({ xPct: 50, yPct: 50 }, [])).toBe(false)
  })

  it('handles a concave polygon (right-pointing chevron with a left notch)', () => {
    const arrow = [
      { xPct: 0, yPct: 0 },
      { xPct: 100, yPct: 50 },
      { xPct: 0, yPct: 100 },
      { xPct: 30, yPct: 50 },
    ]
    // The notch sits at x=30 on the centerline, so the body spans x∈(30,100).
    expect(isPointInPolygon({ xPct: 50, yPct: 50 }, arrow)).toBe(true)
    expect(isPointInPolygon({ xPct: 80, yPct: 50 }, arrow)).toBe(true)
    // Left of the notch — inside the concavity, outside the polygon.
    expect(isPointInPolygon({ xPct: 10, yPct: 50 }, arrow)).toBe(false)
    // Above the upper edge.
    expect(isPointInPolygon({ xPct: 50, yPct: 5 }, arrow)).toBe(false)
  })
})
