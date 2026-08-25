import { describe, expect, it } from 'vitest'
import { fitWithin, SCAN_MAX_EDGE_PX } from './image.js'

describe('fitWithin', () => {
  it('scales a landscape image down to the max edge', () => {
    expect(fitWithin(4032, 3024, 1536)).toEqual({ width: 1536, height: 1152 })
  })

  it('scales a portrait image down to the max edge', () => {
    expect(fitWithin(3024, 4032, 1536)).toEqual({ width: 1152, height: 1536 })
  })

  it('never upscales an image already within bounds', () => {
    expect(fitWithin(800, 600, 1536)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(1536, 1536, 1536)).toEqual({ width: 1536, height: 1536 })
  })

  it('rounds to whole pixels and never collapses below 1', () => {
    const { width, height } = fitWithin(10000, 3, 1536)
    expect(width).toBe(1536)
    expect(height).toBe(1) // 3 * (1536/10000) rounds to 0 without the clamp
  })

  it('passes degenerate dimensions through unchanged', () => {
    expect(fitWithin(0, 0, 1536)).toEqual({ width: 0, height: 0 })
    expect(fitWithin(-5, 100, 1536)).toEqual({ width: -5, height: 100 })
    expect(fitWithin(Number.NaN, 100, 1536)).toEqual({ width: Number.NaN, height: 100 })
  })

  it('exports a default cap that keeps uploads under the API limit', () => {
    expect(SCAN_MAX_EDGE_PX).toBeLessThanOrEqual(2048)
  })
})
