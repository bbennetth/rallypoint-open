// Safe-redirect allowlist for the ?returnTo= query param.
// Mirrors the festival-planner pattern (CLAUDE.md cross-cutting
// note: "Safe-redirect allowlist (src/lib/authReturnTo.ts): mirror
// exactly for the hosted-UI returnTo query param").
//
// Rules:
// 1. The URL must parse.
// 2. If absolute, the origin must match VITE_UI_ORIGIN or appear
//    in the comma-separated VITE_RETURN_TO_ALLOWED_ORIGINS list.
// 3. Relative paths are always allowed (same origin).
// 4. javascript: / data: / vbscript: / file: schemes are rejected.

const ALLOWED_ORIGINS = (
  (import.meta.env.VITE_RETURN_TO_ALLOWED_ORIGINS as string | undefined) ?? ''
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const UI_ORIGIN = (import.meta.env.VITE_UI_ORIGIN as string | undefined) ?? ''

export function safeReturnTo(input: string | null | undefined, fallback = '/'): string {
  if (!input) return fallback
  const trimmed = input.trim()
  if (!trimmed) return fallback
  if (trimmed.startsWith('//')) return fallback
  if (trimmed.startsWith('/')) return trimmed
  try {
    const u = new URL(trimmed)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return fallback
    const here = typeof window !== 'undefined' ? window.location.origin : UI_ORIGIN
    if (u.origin === here) return u.toString()
    if (UI_ORIGIN && u.origin === UI_ORIGIN) return u.toString()
    if (ALLOWED_ORIGINS.includes(u.origin)) return u.toString()
    return fallback
  } catch {
    return fallback
  }
}
