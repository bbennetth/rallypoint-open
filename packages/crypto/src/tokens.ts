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

// Keyed variant of hashToken, backed by WebCrypto (available in both
// Workers/workerd and Node) so the same implementation runs in every
// runtime this monorepo ships to. Used for id-api's own session idHash
// (SESSION_HMAC_KEY) so a stored idHash can't be recomputed by anyone
// who only knows the token-hashing algorithm (sha256) — the key must
// also be known. Distinct from `hashToken`, which remains unkeyed and
// is still correct for the token families that don't need this
// property (email verification, password reset, SSO codes, and the
// consumer apps' own local session-store lookups via api-kit, which
// hash their own separately-namespaced bearer against their own DB —
// not id-api's session table).
export async function hashTokenHmac(token: string, key: string): Promise<string> {
  const enc = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(token))
  return Buffer.from(sig).toString('hex')
}

// Constant-time compare of two strings.
//
// Previously this short-circuited on `a.length !== b.length`, leaking
// the secret's byte length via response timing (audit E1 #23) — an
// attacker probing any token-compare site could distinguish "wrong
// length" (O(1)) from "right length, wrong bytes" (O(n)) and recover
// the secret's length, narrowing the brute-force search.
//
// Fix: always run timingSafeEqual on equal-length padded buffers, then
// AND the result with an explicit length-equality check. The padded
// compare and the length compare are both data-independent in cost, so
// total wall time only depends on max(|a|, |b|), not on whether the
// lengths matched or where the first byte differed.
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const aBytes = Buffer.from(a, 'utf8')
  const bBytes = Buffer.from(b, 'utf8')
  // Floor at 1 so timingSafeEqual never sees zero-length buffers and
  // the cost floor is identical for the empty-string case.
  const maxLen = Math.max(aBytes.length, bBytes.length, 1)
  const aPadded = Buffer.alloc(maxLen)
  const bPadded = Buffer.alloc(maxLen)
  aBytes.copy(aPadded)
  bBytes.copy(bPadded)
  const bytesEqual = timingSafeEqual(aPadded, bPadded)
  // Defence-in-depth length check: a shorter input padded with zeros
  // could match a longer input that genuinely ends in zeros. Without
  // this gate, constantTimeEqual('abc', 'abc\0') would return true.
  return bytesEqual && aBytes.length === bBytes.length
}

// Returns true iff `token` starts with `prefix` (constant-time
// on the prefix portion). Used to fail-fast on malformed input
// before any DB round-trip.
export function tokenHasPrefix(token: string, prefix: string): boolean {
  if (token.length < prefix.length) return false
  return constantTimeEqual(token.slice(0, prefix.length), prefix)
}
