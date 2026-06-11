// Decide whether a touch gesture is a horizontal tab-swipe and which direction.
// Returns -1 (swipe right → previous tab), +1 (swipe left → next tab), or 0
// (not a tab swipe: too short, too slow, or too vertical). Thresholds tuned so
// vertical scrolls and pull-to-refresh never register as swipes.
export function swipeDirection(dx: number, dy: number, dtMs: number): -1 | 0 | 1 {
  const MIN_DISTANCE = 60
  const MAX_DURATION = 600
  const HORIZONTAL_RATIO = 1.4 // |dx| must dominate |dy|
  if (dtMs > MAX_DURATION) return 0
  if (Math.abs(dx) < MIN_DISTANCE) return 0
  if (Math.abs(dx) < Math.abs(dy) * HORIZONTAL_RATIO) return 0
  return dx < 0 ? 1 : -1
}

// Given current index, nav length, and a direction, the destination index,
// clamped to [0, len-1] (no wrap-around). Returns the same index when at an end.
export function nextTabIndex(current: number, len: number, dir: -1 | 0 | 1): number {
  if (dir === 0 || current < 0) return current
  const next = current + dir
  if (next < 0 || next >= len) return current
  return next
}
