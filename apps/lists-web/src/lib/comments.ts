// Pure comment helpers (RPL v1.0.0 S7 UI). The author gate mirrors the
// server's edit/delete rule; relative-time keeps timestamps compact.

export function canManageComment(authorId: string, selfUserId: string | null): boolean {
  return selfUserId !== null && authorId === selfUserId
}

// Compact "x ago" label. `nowMs` is injected so it's deterministic to test
// and callers pass Date.now() at render.
export function relativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const min = Math.floor(Math.max(0, nowMs - then) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}
