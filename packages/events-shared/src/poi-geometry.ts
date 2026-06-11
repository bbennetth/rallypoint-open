// Pure geometry for the map editor. POI positions persist as
// percentages (0..100) of the map image so they survive any display
// size; the editor converts to/from on-screen pixels. No-go zones are
// polygons of the same percentage points. Shared so the browser
// renderer and any server-side hit-testing agree.

export interface PctPoint {
  xPct: number
  yPct: number
}

export interface PixelPoint {
  x: number
  y: number
}

// Clamp a percentage into the valid 0..100 range.
export function clampPct(value: number): number {
  if (Number.isNaN(value)) return 0
  if (value < 0) return 0
  if (value > 100) return 100
  return value
}

export function isValidPct(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100
}

// Percentage point → on-screen pixel within a rendered box.
export function pctToPixels(point: PctPoint, box: { width: number; height: number }): PixelPoint {
  return {
    x: (clampPct(point.xPct) / 100) * box.width,
    y: (clampPct(point.yPct) / 100) * box.height,
  }
}

// On-screen pixel → percentage point. Result is clamped to 0..100 so a
// drag that overshoots the image edge still stores a valid value.
export function pixelsToPct(point: PixelPoint, box: { width: number; height: number }): PctPoint {
  const xPct = box.width > 0 ? (point.x / box.width) * 100 : 0
  const yPct = box.height > 0 ? (point.y / box.height) * 100 : 0
  return { xPct: clampPct(xPct), yPct: clampPct(yPct) }
}

// Ray-casting point-in-polygon test. polygon is an ordered ring of
// percentage points (implicitly closed). Returns false for degenerate
// rings (< 3 vertices). Used to hit-test clicks against a no-go zone.
export function isPointInPolygon(point: PctPoint, polygon: readonly PctPoint[]): boolean {
  if (polygon.length < 3) return false
  const { xPct: px, yPct: py } = point
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!
    const b = polygon[j]!
    const intersects =
      a.yPct > py !== b.yPct > py &&
      px < ((b.xPct - a.xPct) * (py - a.yPct)) / (b.yPct - a.yPct) + a.xPct
    if (intersects) inside = !inside
  }
  return inside
}
