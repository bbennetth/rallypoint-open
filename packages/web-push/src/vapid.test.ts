import { describe, it, expect } from 'vitest'
import { base64UrlToBytes } from './base64url.js'
import { generateVapidKeys } from './keys.js'
import { signVapidJwt } from './vapid.js'

const textDecoder = new TextDecoder()

function decodeJson(segment: string): Record<string, unknown> {
  return JSON.parse(textDecoder.decode(base64UrlToBytes(segment))) as Record<string, unknown>
}

describe('signVapidJwt (RFC 8292 ES256)', () => {
  it('produces a JWT whose signature verifies against the public key', async () => {
    const keys = await generateVapidKeys('mailto:ops@example.com')
    const jwt = await signVapidJwt({
      audience: 'https://push.example.com',
      keys,
      now: 1_700_000_000_000,
    })

    const [headerB64, payloadB64, signatureB64] = jwt.split('.')
    expect(decodeJson(headerB64!)).toEqual({ typ: 'JWT', alg: 'ES256' })

    const payload = decodeJson(payloadB64!)
    expect(payload.aud).toBe('https://push.example.com')
    expect(payload.sub).toBe('mailto:ops@example.com')
    expect(payload.exp).toBe(1_700_000_000 + 12 * 60 * 60)

    const verifyKey = await crypto.subtle.importKey(
      'raw',
      base64UrlToBytes(keys.publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      base64UrlToBytes(signatureB64!),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    )
    expect(ok).toBe(true)
  })

  it('honors a custom expiry', async () => {
    const keys = await generateVapidKeys('mailto:ops@example.com')
    const jwt = await signVapidJwt({
      audience: 'https://push.example.com',
      keys,
      now: 1_700_000_000_000,
      expiresInSeconds: 3600,
    })
    const payload = decodeJson(jwt.split('.')[1]!)
    expect(payload.exp).toBe(1_700_000_000 + 3600)
  })
})
