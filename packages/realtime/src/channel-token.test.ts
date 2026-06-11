import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  mintChannelToken,
  verifyChannelToken,
  DEFAULT_CHANNEL_TOKEN_TTL_MS,
} from './channel-token.js'

const KEY = 'test-realtime-hmac-key-not-a-real-secret'
const CHANNEL = 'lists:list:lst_01H000000000000000000000'

describe('channel-token', () => {
  it('mints a token that verifies for the same channel + key', () => {
    const now = 1_700_000_000_000
    const token = mintChannelToken({ channel: CHANNEL, key: KEY, now })
    const res = verifyChannelToken({ token, key: KEY, now })
    expect(res).toEqual({ ok: true, channel: CHANNEL, exp: now + DEFAULT_CHANNEL_TOKEN_TTL_MS })
  })

  it('honors a custom ttl', () => {
    const now = 1_700_000_000_000
    const token = mintChannelToken({ channel: CHANNEL, key: KEY, now, ttlMs: 1000 })
    expect(verifyChannelToken({ token, key: KEY, now: now + 999 })).toMatchObject({ ok: true })
    expect(verifyChannelToken({ token, key: KEY, now: now + 1000 })).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('rejects an expired token', () => {
    const now = 1_700_000_000_000
    const token = mintChannelToken({ channel: CHANNEL, key: KEY, now })
    const res = verifyChannelToken({
      token,
      key: KEY,
      now: now + DEFAULT_CHANNEL_TOKEN_TTL_MS + 1,
    })
    expect(res).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects a token signed with a different key', () => {
    const token = mintChannelToken({ channel: CHANNEL, key: KEY })
    expect(verifyChannelToken({ token, key: 'other-key' })).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
  })

  it('rejects a tampered payload (channel swap)', () => {
    // Forge a token for a different channel by re-encoding the payload but
    // keeping the original tag — the signature no longer matches.
    const token = mintChannelToken({ channel: CHANNEL, key: KEY })
    const tag = token.slice(token.indexOf('.') + 1)
    const forgedPayload = Buffer.from(
      JSON.stringify({ c: 'lists:list:lst_attacker', e: Date.now() + 60_000 }),
      'utf8',
    ).toString('base64url')
    const forged = `${forgedPayload}.${tag}`
    expect(verifyChannelToken({ token: forged, key: KEY })).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
  })

  it.each(['', 'no-dot', '.onlytag', 'onlysegment.', 'a.b.c'])(
    'rejects a malformed token %j',
    (token) => {
      const res = verifyChannelToken({ token, key: KEY })
      // Malformed shapes fail either on structure or on signature; both are
      // rejections (never ok:true).
      expect(res.ok).toBe(false)
    },
  )

  it('rejects a well-signed token whose payload is not valid JSON shape', () => {
    // Sign a non-conforming payload with the real key: signature passes,
    // but the shape check must still reject it.
    const segment = Buffer.from(JSON.stringify({ nope: 1 }), 'utf8').toString('base64url')
    const tag = createHmac('sha256', KEY).update(segment, 'utf8').digest('base64url')
    expect(verifyChannelToken({ token: `${segment}.${tag}`, key: KEY })).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })
})
