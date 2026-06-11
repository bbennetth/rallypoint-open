import { createHash } from 'node:crypto'

// IP extraction and daily-salted hashing shared across all Rallypoint
// API apps. Moved from apps/id-api/src/http/extract-ip.ts (pure pieces)
// and apps/id-api/src/crypto/ip-hash.ts so consumer apps can adopt the
// same policy-driven extraction and daily-rotation instead of a
// permanent unsalted sha256 fingerprint.

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export type TrustPolicy = 'legacy' | 'xff' | 'cf-connecting-ip' | 'none'

export interface ExtractIpInput {
  /** The raw fetch Request, OR an object exposing headers via .get/.header. */
  headers: Pick<Headers, 'get'> | { get(name: string): string | null }
  /** Trust policy. Default 'legacy' for backwards compat. */
  policy?: TrustPolicy
  /** Optional socket-address fallback (Node-only; @hono/node-server can supply). */
  socketAddr?: string | null
}

// Extract the request's client IP from the standard reverse-proxy headers.
//
// Trust policies:
//   legacy           — current behavior: leftmost XFF, then cf-connecting-ip,
//                       then 0.0.0.0. Safe behind a single trusted reverse
//                       proxy (Nginx/Caddy/Render/Fly).
//   xff              — strict: leftmost XFF only, no fallback to
//                       cf-connecting-ip.
//   cf-connecting-ip — Cloudflare deploys: ignore XFF, use
//                       cf-connecting-ip exclusively.
//   none             — no proxy at all (rare). Trust no forwarded
//                       headers — IP comes from the socket address.
//
// Default 'legacy' preserves pre-policy behavior. Operators on bare-metal
// public internet should switch to 'none' (or front the API with a proxy
// that strips client-supplied XFF).
export function extractIp(input: ExtractIpInput): string {
  const policy = input.policy ?? 'legacy'
  const headerGet = (name: string): string | null => input.headers.get(name)

  if (policy === 'none') {
    return input.socketAddr || '0.0.0.0'
  }
  if (policy === 'cf-connecting-ip') {
    return headerGet('cf-connecting-ip') || input.socketAddr || '0.0.0.0'
  }
  // 'xff' and 'legacy' both prefer leftmost XFF.
  const xff = headerGet('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  if (policy === 'legacy') {
    const cf = headerGet('cf-connecting-ip')
    if (cf) return cf
  }
  return input.socketAddr || '0.0.0.0'
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

// Audit and rate-limit rows store ip_hash, not the raw IP. We
// salt with a per-day value so an attacker who exfiltrates the DB
// can't pivot a known IP into a query against historical rows
// older than the current day.
//
// The DAILY_SALT itself is derived from a server-side secret +
// the current UTC date — no extra config needed.

export function dailySalt(secret: string, when: Date = new Date()): string {
  const day = when.toISOString().slice(0, 10) // YYYY-MM-DD UTC
  return `${secret}|${day}`
}

export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}|${ip}`, 'utf8').digest('hex')
}

export function hashUserAgent(ua: string): string {
  // No daily salt for UA — UA strings are not pseudonymous
  // identifiers, and we don't want to rotate them out of the audit
  // log (UA changes correlate with device-switch events).
  return createHash('sha256').update(ua, 'utf8').digest('hex')
}
