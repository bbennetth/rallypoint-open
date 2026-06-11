import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

// Opaque-bearer-token helpers shared by every slice that issues
// or validates a token (sessions, email verification, password
// reset, email change). Each token is:
//
//   <prefix><base64url(256 random bits)>
//
// The raw token only ever leaves the server in the user's
// response or email; at-rest we store `sha256(token)` (hex) as
// the row's PK. Lookups hash the inbound token and compare in
// constant time.

const RAW_BYTES = 32 // 256 bits

export function generateRawToken(prefix: string): string {
  const raw = randomBytes(RAW_BYTES).toString('base64url')
  return `${prefix}${raw}`
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

// Constant-time compare of two equal-length hex/string values.
// `timingSafeEqual` itself throws if lengths differ — we collapse
// that into a boolean so callers don't leak length via a thrown
// exception path.
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

// Returns true iff `token` starts with `prefix` (constant-time
// on the prefix portion). Used to fail-fast on malformed input
// before any DB round-trip.
export function tokenHasPrefix(token: string, prefix: string): boolean {
  if (token.length < prefix.length) return false
  return constantTimeEqual(token.slice(0, prefix.length), prefix)
}
