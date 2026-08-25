import { describe, expect, it } from 'vitest'
import { verifyIdToken, signAppleClientSecret, JwtError } from './jwt.js'
import { bytesToBase64url } from './webauthn/base64url.js'

const b64urlJson = (o: unknown): string => bytesToBase64url(new TextEncoder().encode(JSON.stringify(o)))
const NOW = 1_800_000_000_000 // fixed ms epoch for deterministic exp checks

async function makeRs256Token(
  payload: Record<string, unknown>,
  opts: { kid?: string; tamper?: boolean } = {},
): Promise<{ token: string; jwks: { keys: unknown[] } }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
  const kid = opts.kid ?? 'rsa-test-1'
  const pubJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const signingInput = `${b64urlJson({ alg: 'RS256', kid, typ: 'JWT' })}.${b64urlJson(payload)}`
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      pair.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  )
  if (opts.tamper) sig[0] ^= 0xff
  return {
    token: `${signingInput}.${bytesToBase64url(sig)}`,
    jwks: { keys: [{ kty: 'RSA', n: pubJwk.n, e: pubJwk.e, kid, alg: 'RS256' }] },
  }
}

const goodPayload = () => ({
  iss: 'https://accounts.google.com',
  aud: 'client-123',
  sub: 'user-1',
  nonce: 'nonce-xyz',
  iat: Math.floor(NOW / 1000) - 10,
  exp: Math.floor(NOW / 1000) + 3600,
})

describe('verifyIdToken (RS256)', () => {
  it('accepts a well-formed token and returns the claims', async () => {
    const { token, jwks } = await makeRs256Token(goodPayload())
    const claims = await verifyIdToken({
      idToken: token,
      jwks,
      issuers: ['https://accounts.google.com'],
      audience: 'client-123',
      nonce: 'nonce-xyz',
      now: NOW,
    })
    expect(claims['sub']).toBe('user-1')
  })

  it('rejects expired, wrong-audience, wrong-nonce, wrong-issuer, and tampered tokens', async () => {
    const base = {
      issuers: ['https://accounts.google.com'],
      audience: 'client-123',
      now: NOW,
    }
    const expired = await makeRs256Token({ ...goodPayload(), exp: Math.floor(NOW / 1000) - 3600 })
    await expect(verifyIdToken({ idToken: expired.token, jwks: expired.jwks, ...base })).rejects.toBeInstanceOf(
      JwtError,
    )

    const good = await makeRs256Token(goodPayload())
    await expect(
      verifyIdToken({ idToken: good.token, jwks: good.jwks, ...base, audience: 'someone-else' }),
    ).rejects.toBeInstanceOf(JwtError)
    await expect(
      verifyIdToken({ idToken: good.token, jwks: good.jwks, ...base, nonce: 'wrong' }),
    ).rejects.toBeInstanceOf(JwtError)
    await expect(
      verifyIdToken({ idToken: good.token, jwks: good.jwks, ...base, issuers: ['https://evil'] }),
    ).rejects.toBeInstanceOf(JwtError)

    const tampered = await makeRs256Token(goodPayload(), { tamper: true })
    await expect(
      verifyIdToken({ idToken: tampered.token, jwks: tampered.jwks, ...base }),
    ).rejects.toBeInstanceOf(JwtError)
  })
})

describe('signAppleClientSecret (ES256) round-trips through verifyIdToken', () => {
  it('produces a JWT that verifies against the matching EC public key', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
    const b64 = Buffer.from(pkcs8).toString('base64')
    const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`

    const secret = await signAppleClientSecret({
      teamId: 'TEAM123456',
      keyId: 'KEY7890',
      clientId: 'com.rallypoint.id',
      privateKeyPkcs8Pem: pem,
      now: NOW,
    })

    const pubJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    const claims = await verifyIdToken({
      idToken: secret,
      jwks: { keys: [{ kty: 'EC', crv: 'P-256', x: pubJwk.x, y: pubJwk.y, kid: 'KEY7890', alg: 'ES256' }] },
      issuers: ['TEAM123456'],
      audience: 'https://appleid.apple.com',
      now: NOW,
    })
    expect(claims['sub']).toBe('com.rallypoint.id')
    expect(claims['iss']).toBe('TEAM123456')
  })
})
