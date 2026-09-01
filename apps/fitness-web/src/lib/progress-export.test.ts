// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EXPORT,
  computeExportLayout,
  coverRect,
  progressExportFileName,
  renderProgressExport,
  shareOrDownload,
  type Box,
} from './progress-export.js'

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function withinCanvas(box: Box): boolean {
  return (
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.w <= EXPORT.width &&
    box.y + box.h <= EXPORT.height
  )
}

describe('computeExportLayout', () => {
  it('lays out a single photo within the canvas, respecting pad', () => {
    const layout = computeExportLayout(1)
    expect(layout.canvas).toEqual({ width: EXPORT.width, height: EXPORT.height })
    expect(layout.photoBoxes).toHaveLength(1)
    expect(layout.captionBoxes).toHaveLength(1)
    expect(layout.deltaBox).toBeNull()
    for (const box of [...layout.photoBoxes, ...layout.captionBoxes, layout.footerBox]) {
      expect(withinCanvas(box)).toBe(true)
    }
    expect(layout.photoBoxes[0]!.x).toBe(EXPORT.pad)
    expect(!overlaps(layout.photoBoxes[0]!, layout.captionBoxes[0]!)).toBe(true)
    expect(!overlaps(layout.captionBoxes[0]!, layout.footerBox)).toBe(true)
  })

  it('keeps the 1-up photo+caption group vertically padded and attached', () => {
    const layout = computeExportLayout(1)
    const photo = layout.photoBoxes[0]!
    const caption = layout.captionBoxes[0]!
    expect(photo.y).toBeGreaterThanOrEqual(EXPORT.pad)
    expect(caption.y).toBeCloseTo(photo.y + photo.h)
    expect(caption.y + caption.h).toBeLessThanOrEqual(layout.footerBox.y)
    expect(photo.h).toBeLessThanOrEqual(photo.w * 1.4 + 0.01)
  })

  it('places the footer at the bottom of the canvas', () => {
    const layout = computeExportLayout(1)
    expect(layout.footerBox.y + layout.footerBox.h).toBe(EXPORT.height)
    expect(layout.footerBox.h).toBe(EXPORT.footerH)
  })

  it('splits the photo band into two equal columns with a gutter for 2-up', () => {
    const layout = computeExportLayout(2)
    expect(layout.photoBoxes).toHaveLength(2)
    expect(layout.captionBoxes).toHaveLength(2)
    expect(layout.deltaBox).not.toBeNull()

    const [left, right] = layout.photoBoxes as [Box, Box]
    expect(left.w).toBeCloseTo(right.w)
    expect(right.x - (left.x + left.w)).toBeCloseTo(EXPORT.gutter)
    expect(left.x).toBe(EXPORT.pad)
    expect(right.x + right.w).toBeCloseTo(EXPORT.width - EXPORT.pad)

    for (const box of [
      ...layout.photoBoxes,
      ...layout.captionBoxes,
      layout.deltaBox as Box,
      layout.footerBox,
    ]) {
      expect(withinCanvas(box)).toBe(true)
    }
    expect(!overlaps(left, right)).toBe(true)
    expect(!overlaps(layout.deltaBox as Box, layout.footerBox)).toBe(true)
    expect(!overlaps(layout.captionBoxes[0]!, layout.deltaBox as Box)).toBe(true)
  })

  it('caps 2-up photo boxes at 1.4x their width (no savage portrait cropping)', () => {
    const layout = computeExportLayout(2)
    const [left, right] = layout.photoBoxes as [Box, Box]
    const epsilon = 0.01
    expect(left.h).toBeLessThanOrEqual(left.w * 1.4 + epsilon)
    expect(right.h).toBeLessThanOrEqual(right.w * 1.4 + epsilon)
  })

  it('sits captions immediately below the photo in each 2-up column', () => {
    const layout = computeExportLayout(2)
    layout.photoBoxes.forEach((box, i) => {
      const caption = layout.captionBoxes[i]!
      expect(caption.y).toBeCloseTo(box.y + box.h)
    })
  })
})

describe('coverRect', () => {
  it('crops the sides of a wide source into a taller box', () => {
    const r = coverRect(2000, 1000, { x: 0, y: 0, w: 100, h: 200 })
    expect(r.sy).toBe(0)
    expect(r.sh).toBe(1000)
    expect(r.sw).toBeCloseTo(500) // 1000 * (100/200)
    expect(r.sx).toBeCloseTo((2000 - 500) / 2)
  })

  it('crops the top/bottom of a tall source into a wider box', () => {
    const r = coverRect(1000, 2000, { x: 0, y: 0, w: 200, h: 100 })
    expect(r.sx).toBe(0)
    expect(r.sw).toBe(1000)
    expect(r.sh).toBeCloseTo(500) // 1000 * (100/200)
    expect(r.sy).toBeCloseTo((2000 - 500) / 2)
  })

  it('passes through unchanged when aspect ratios match exactly', () => {
    const r = coverRect(400, 200, { x: 0, y: 0, w: 200, h: 100 })
    expect(r).toEqual({ sx: 0, sy: 0, sw: 400, sh: 200 })
  })

  it('passes through the full source for degenerate inputs', () => {
    expect(coverRect(0, 0, { x: 0, y: 0, w: 100, h: 100 })).toEqual({ sx: 0, sy: 0, sw: 0, sh: 0 })
    expect(coverRect(Number.NaN, 100, { x: 0, y: 0, w: 100, h: 100 })).toEqual({
      sx: 0,
      sy: 0,
      sw: Number.NaN,
      sh: 100,
    })
    expect(coverRect(100, 100, { x: 0, y: 0, w: 0, h: 100 })).toEqual({ sx: 0, sy: 0, sw: 100, sh: 100 })
  })
})

describe('progressExportFileName', () => {
  it('names a single-photo export by its local date', () => {
    expect(progressExportFileName([{ takenAt: '2026-06-22T08:00:00.000Z' }])).toBe(
      'rallypoint-progress-2026-06-22.jpg',
    )
  })

  it('orders unsorted two-photo input oldest-vs-newest', () => {
    const photos = [{ takenAt: '2026-06-22T08:00:00.000Z' }, { takenAt: '2026-05-01T08:00:00.000Z' }]
    expect(progressExportFileName(photos)).toBe('rallypoint-progress-2026-05-01-vs-2026-06-22.jpg')
  })
})

describe('renderProgressExport', () => {
  it('rejects when the browser has no 2D canvas context', async () => {
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = (() => null) as never
    try {
      await expect(
        renderProgressExport([{ url: 'blob:x', dateText: 'Jun 22', weightText: null }]),
      ).rejects.toThrow('Canvas export is not supported on this browser.')
    } finally {
      HTMLCanvasElement.prototype.getContext = original
    }
  })
})

describe('shareOrDownload', () => {
  const blob = new Blob(['x'], { type: 'image/jpeg' })

  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:mock'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('shares via the Web Share API when canShare is true and share resolves', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      canShare: () => true,
      share: vi.fn().mockResolvedValue(undefined),
    })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    const result = await shareOrDownload(blob, 'test.jpg')
    expect(result).toBe('shared')
    expect(clickSpy).not.toHaveBeenCalled()
  })

  it('returns cancelled and does not download when share rejects with AbortError', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' })
    vi.stubGlobal('navigator', {
      ...navigator,
      canShare: () => true,
      share: vi.fn().mockRejectedValue(abortError),
    })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    const result = await shareOrDownload(blob, 'test.jpg')
    expect(result).toBe('cancelled')
    expect(clickSpy).not.toHaveBeenCalled()
  })

  it('downloads when canShare is absent', async () => {
    vi.stubGlobal('navigator', { ...navigator, canShare: undefined, share: undefined })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const result = await shareOrDownload(blob, 'test.jpg')
    expect(result).toBe('downloaded')
    expect(clickSpy).toHaveBeenCalled()
  })

  it('falls through to download when share rejects with a non-Abort error', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      canShare: () => true,
      share: vi.fn().mockRejectedValue(new Error('boom')),
    })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const result = await shareOrDownload(blob, 'test.jpg')
    expect(result).toBe('downloaded')
    expect(clickSpy).toHaveBeenCalled()
  })
})
