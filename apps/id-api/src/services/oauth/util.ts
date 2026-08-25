import type { JwksCache } from './jwks-cache.js'

export interface ProviderDeps {
  jwks: JwksCache
  fetchImpl?: typeof fetch
  now?: () => number
}

// Apple/Google send email_verified as a real boolean OR (Apple, sometimes)
// the string "true"/"false". Coerce both; anything else is unverified.
export function coerceVerified(v: unknown): boolean {
  return v === true || v === 'true'
}

export function splitName(name: string | null): {
  firstName: string | null
  lastName: string | null
} {
  if (!name) return { firstName: null, lastName: null }
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstName: null, lastName: null }
  if (parts.length === 1) return { firstName: parts[0]!, lastName: null }
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') }
}

export function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}
