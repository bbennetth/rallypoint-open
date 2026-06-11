// Tiny pure helper for the verify-email auto-redirect countdown.
// Extracted so the rounding semantics can be unit-tested without
// mounting a React tree.

export function secondsRemaining(deadlineMs: number, nowMs: number): number {
  if (nowMs >= deadlineMs) return 0
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000))
}
