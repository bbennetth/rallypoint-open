import { describe, it, expect } from 'vitest'
import { computeAvatarResize } from './avatar-geometry.js'

describe('computeAvatarResize', () => {
  // ---- Typical downscale -------------------------------------------------

  it('downscales a landscape photo to a centered square', () => {
    // 4000 × 3000 source, 512 target
    const g = computeAvatarResize(4000, 3000, 512)
    // Crop: largest square = 3000 × 3000, centered horizontally
    expect(g.sw).toBe(3000)
    expect(g.sy).toBe(0)
    expect(g.sx).toBe(500) // (4000 - 3000) / 2
    // Output: clamp to 512
    expect(g.outputSize).toBe(512)
  })

  it('downscales a portrait photo to a centered square', () => {
    // 3000 × 4000 source, 512 target
    const g = computeAvatarResize(3000, 4000, 512)
    expect(g.sw).toBe(3000)
    expect(g.sx).toBe(0)
    expect(g.sy).toBe(500) // (4000 - 3000) / 2
    expect(g.outputSize).toBe(512)
  })

  it('downscales a square photo to exactly the target', () => {
    const g = computeAvatarResize(2000, 2000, 512)
    expect(g.sx).toBe(0)
    expect(g.sy).toBe(0)
    expect(g.sw).toBe(2000)
    expect(g.outputSize).toBe(512)
  })

  // ---- Never-upscale rule ------------------------------------------------

  it('does not upscale a small square image', () => {
    // Source is 200 × 200 — smaller than the 512 target
    const g = computeAvatarResize(200, 200, 512)
    expect(g.outputSize).toBe(200) // clamped to crop side, not 512
    expect(g.sw).toBe(200)
    expect(g.sx).toBe(0)
    expect(g.sy).toBe(0)
  })

  it('does not upscale a small landscape image', () => {
    // 300 × 200 source, target 512 — narrow side is 200
    const g = computeAvatarResize(300, 200, 512)
    expect(g.outputSize).toBe(200)
    expect(g.sw).toBe(200)
    expect(g.sx).toBe(50) // (300 - 200) / 2
    expect(g.sy).toBe(0)
  })

  // ---- Exactly-at-target -------------------------------------------------

  it('keeps outputSize == targetDimension when source equals target', () => {
    const g = computeAvatarResize(512, 512, 512)
    expect(g.outputSize).toBe(512)
    expect(g.sw).toBe(512)
    expect(g.sx).toBe(0)
    expect(g.sy).toBe(0)
  })

  it('clamps output when source crop equals target exactly', () => {
    // 600 × 512 — crop side is 512, equals target
    const g = computeAvatarResize(600, 512, 512)
    expect(g.sw).toBe(512)
    expect(g.outputSize).toBe(512)
    expect(g.sx).toBe(44) // floor((600 - 512) / 2)
    expect(g.sy).toBe(0)
  })

  // ---- Extreme aspect ratios ---------------------------------------------

  it('handles a very wide panorama (10000 × 500)', () => {
    const g = computeAvatarResize(10000, 500, 512)
    // Crop side = 500 (shorter dimension)
    expect(g.sw).toBe(500)
    expect(g.sx).toBe(4750) // (10000 - 500) / 2
    expect(g.sy).toBe(0)
    // Never upscale: 500 < 512, so output = 500
    expect(g.outputSize).toBe(500)
  })

  it('handles a very tall thin image (100 × 8000)', () => {
    const g = computeAvatarResize(100, 8000, 512)
    expect(g.sw).toBe(100) // crop side = narrower (width)
    expect(g.sx).toBe(0)
    expect(g.sy).toBe(3950) // (8000 - 100) / 2
    // Never upscale: 100 < 512
    expect(g.outputSize).toBe(100)
  })

  it('handles a 1 × 1 pixel image', () => {
    const g = computeAvatarResize(1, 1, 512)
    expect(g.sw).toBe(1)
    expect(g.outputSize).toBe(1)
  })

  // ---- Error cases --------------------------------------------------------

  it('throws on zero or negative dimensions', () => {
    expect(() => computeAvatarResize(0, 500, 512)).toThrow(RangeError)
    expect(() => computeAvatarResize(500, 0, 512)).toThrow(RangeError)
    expect(() => computeAvatarResize(500, 500, 0)).toThrow(RangeError)
    expect(() => computeAvatarResize(-1, 500, 512)).toThrow(RangeError)
  })
})
