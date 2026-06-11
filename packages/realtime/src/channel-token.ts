import { createHmac, timingSafeEqual } from 'node:crypto'

// Short-lived, HMAC-signed authorization for a single realtime channel
// (#313, Phase 3). The Worker runs the existing read-authorization check
// (loadListForRead / assertScopeReadable) and, on success, mints a token
// bound to the exact channel name. The RealtimeHub Durable Object
// re-verifies the signature + expiry before accepting (or keeping) a
// WebSocket. The Worker routes the upgrade to idFromName(token.channel),
// so a client can never reach a channel it lacks a signed token for —
// the channel travels *inside* the signed payload, not as a spoofable
// query param.
//
// Token = `<base64url(payload)>.<base64url(hmac)>` where payload is
// `{ c: channel, e: expEpochMs }`. HMAC-SHA256 over the payload segment
// keyed by REALTIME_TOKEN_HMAC_KEY. This mirrors the node:crypto
// createHmac pattern already used for signin codes
// (apps/id-api/src/crypto/signin-code.ts) rather than adding a new
// dependency; node:crypto runs under `nodejs_compat` in a Worker.

export const DEFAULT_CHANNEL_TOKEN_TTL_MS = 5 * 60 * 1000 // 5 minutes

interface ChannelTokenPayload {
  c: string // channel
  e: number // expiry, epoch ms
}

function sign(payloadSegment: string, key: string): string {
  return createHmac('sha256', key).update(payloadSegment, 'utf8').digest('base64url')
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

export interface MintChannelTokenOptions {
  channel: string
  key: string
  // Absolute expiry epoch ms. Defaults to now + DEFAULT_CHANNEL_TOKEN_TTL_MS.
  // `now` is injectable for deterministic tests.
  now?: number
  ttlMs?: number
}

export function mintChannelToken(opts: MintChannelTokenOptions): string {
  const now = opts.now ?? Date.now()
  const ttl = opts.ttlMs ?? DEFAULT_CHANNEL_TOKEN_TTL_MS
  const payload: ChannelTokenPayload = { c: opts.channel, e: now + ttl }
  const segment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${segment}.${sign(segment, opts.key)}`
}

export type VerifyChannelTokenResult =
  | { ok: true; channel: string; exp: number }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' }

export interface VerifyChannelTokenOptions {
  token: string
  key: string
  now?: number
}

export function verifyChannelToken(opts: VerifyChannelTokenOptions): VerifyChannelTokenResult {
  const now = opts.now ?? Date.now()
  const dot = opts.token.indexOf('.')
  if (dot <= 0 || dot === opts.token.length - 1) return { ok: false, reason: 'malformed' }
  const segment = opts.token.slice(0, dot)
  const tag = opts.token.slice(dot + 1)

  // Signature first: never parse attacker-controlled payload we haven't
  // authenticated. Constant-time compare so a forged tag can't be probed
  // byte-by-byte.
  if (!constantTimeEqual(tag, sign(segment, opts.key))) return { ok: false, reason: 'bad_signature' }

  let payload: ChannelTokenPayload
  try {
    const json = Buffer.from(segment, 'base64url').toString('utf8')
    const parsed = JSON.parse(json) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as ChannelTokenPayload).c !== 'string' ||
      typeof (parsed as ChannelTokenPayload).e !== 'number'
    ) {
      return { ok: false, reason: 'malformed' }
    }
    payload = parsed as ChannelTokenPayload
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  if (payload.e <= now) return { ok: false, reason: 'expired' }
  return { ok: true, channel: payload.c, exp: payload.e }
}
