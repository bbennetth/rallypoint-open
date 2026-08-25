import { describe, expect, it } from 'vitest'
import { verifyRegistration } from './verify-registration.js'
import { verifyAuthentication } from './verify-authentication.js'
import { WebAuthnError } from './errors.js'
import { base64urlToBytes, bytesToBase64url } from './base64url.js'

// End-to-end WebAuthn ceremony tests. We drive the FULL pipeline — CBOR
// decode, COSE import, authData parse, rpId/flag/counter checks, DER↔raw
// conversion, and real WebCrypto signature verification — by minting real
// ES256/RS256 keys and constructing the exact bytes an authenticator
// would return (a minimal CTAP-canonical CBOR encoder + a raw→DER ECDSA
// packer live in this file). If any byte-level detail of the hand-rolled
// decoders were wrong, the real crypto.subtle.verify would reject.

const RP_ID = 'localhost'
const ORIGIN = 'http://localhost:5173'

// --- minimal CBOR encoder (test-only) -------------------------------
function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const a of arrs) {
    out.set(a, o)
    o += a.length
  }
  return out
}
function head(major: number, arg: number): Uint8Array {
  if (arg < 24) return new Uint8Array([(major << 5) | arg])
  if (arg < 0x100) return new Uint8Array([(major << 5) | 24, arg])
  if (arg < 0x10000) return new Uint8Array([(major << 5) | 25, (arg >> 8) & 0xff, arg & 0xff])
  return new Uint8Array([
    (major << 5) | 26,
    (arg >>> 24) & 0xff,
    (arg >>> 16) & 0xff,
    (arg >>> 8) & 0xff,
    arg & 0xff,
  ])
}
const encInt = (n: number): Uint8Array => (n < 0 ? head(1, -1 - n) : head(0, n))
const encBytes = (b: Uint8Array): Uint8Array => concat(head(2, b.length), b)
const encText = (s: string): Uint8Array => {
  const b = new TextEncoder().encode(s)
  return concat(head(3, b.length), b)
}
const encMap = (pairs: [Uint8Array, Uint8Array][]): Uint8Array =>
  concat(head(5, pairs.length), ...pairs.flat())

const coseEc2 = (x: Uint8Array, y: Uint8Array): Uint8Array =>
  encMap([
    [encInt(1), encInt(2)], // kty: EC2
    [encInt(3), encInt(-7)], // alg: ES256
    [encInt(-1), encInt(1)], // crv: P-256
    [encInt(-2), encBytes(x)],
    [encInt(-3), encBytes(y)],
  ])
const coseRsa = (n: Uint8Array, e: Uint8Array): Uint8Array =>
  encMap([
    [encInt(1), encInt(3)], // kty: RSA
    [encInt(3), encInt(-257)], // alg: RS256
    [encInt(-1), encBytes(n)],
    [encInt(-2), encBytes(e)],
  ])

// --- authenticator-data + signature construction --------------------
async function buildAuthData(opts: {
  rpId: string
  up?: boolean
  uv?: boolean
  at?: boolean
  signCount: number
  credId?: Uint8Array
  coseKey?: Uint8Array
}): Promise<Uint8Array> {
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(opts.rpId)),
  )
  let flags = 0
  if (opts.up ?? true) flags |= 0x01
  if (opts.uv) flags |= 0x04
  if (opts.at) flags |= 0x40
  const sc = new Uint8Array(4)
  new DataView(sc.buffer).setUint32(0, opts.signCount)
  const parts = [rpIdHash, new Uint8Array([flags]), sc]
  if (opts.at) {
    const aaguid = new Uint8Array(16)
    const credId = opts.credId!
    const credIdLen = new Uint8Array(2)
    new DataView(credIdLen.buffer).setUint16(0, credId.length)
    parts.push(aaguid, credIdLen, credId, opts.coseKey!)
  }
  return concat(...parts)
}

function rawToDerEcdsa(raw: Uint8Array): Uint8Array {
  const derInt = (bytes: Uint8Array): Uint8Array => {
    let i = 0
    while (i < bytes.length - 1 && bytes[i] === 0) i++
    let v = bytes.subarray(i)
    if ((v[0]! & 0x80) !== 0) v = concat(new Uint8Array([0]), v) // keep positive
    return concat(new Uint8Array([0x02, v.length]), v)
  }
  const body = concat(derInt(raw.subarray(0, 32)), derInt(raw.subarray(32, 64)))
  return concat(new Uint8Array([0x30, body.length]), body)
}

const randomChallenge = (): string => bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)))
const jsonBytes = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o))

async function genEc(): Promise<{ pair: CryptoKeyPair; cose: Uint8Array }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return { pair, cose: coseEc2(base64urlToBytes(jwk.x!), base64urlToBytes(jwk.y!)) }
}

describe('WebAuthn registration', () => {
  it('verifies a ceremony and extracts credentialId + public key', async () => {
    const { cose } = await genEc()
    const credId = crypto.getRandomValues(new Uint8Array(32))
    const authData = await buildAuthData({
      rpId: RP_ID,
      up: true,
      uv: true,
      at: true,
      signCount: 0,
      credId,
      coseKey: cose,
    })
    const attestationObject = encMap([
      [encText('fmt'), encText('none')],
      [encText('attStmt'), encMap([])],
      [encText('authData'), encBytes(authData)],
    ])
    const challenge = randomChallenge()
    const result = await verifyRegistration({
      attestationObjectB64: bytesToBase64url(attestationObject),
      clientDataJSONB64: bytesToBase64url(
        jsonBytes({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: false }),
      ),
      expectedChallenge: challenge,
      rpId: RP_ID,
      allowedOrigins: [ORIGIN],
      requireUserVerification: true,
    })
    expect(result.credentialId).toBe(bytesToBase64url(credId))
    expect(result.publicKey).toBe(bytesToBase64url(cose))
    expect(result.signCount).toBe(0)
  })

  it('rejects a wrong origin and a UV-required-but-absent ceremony', async () => {
    const { cose } = await genEc()
    const credId = crypto.getRandomValues(new Uint8Array(16))
    const challenge = randomChallenge()
    const authData = await buildAuthData({
      rpId: RP_ID,
      up: true,
      uv: false, // no user verification
      at: true,
      signCount: 0,
      credId,
      coseKey: cose,
    })
    const attestationObject = encMap([
      [encText('fmt'), encText('none')],
      [encText('attStmt'), encMap([])],
      [encText('authData'), encBytes(authData)],
    ])
    const base = {
      attestationObjectB64: bytesToBase64url(attestationObject),
      expectedChallenge: challenge,
      rpId: RP_ID,
      allowedOrigins: [ORIGIN],
    }
    // Wrong origin.
    await expect(
      verifyRegistration({
        ...base,
        clientDataJSONB64: bytesToBase64url(
          jsonBytes({ type: 'webauthn.create', challenge, origin: 'https://evil.example' }),
        ),
        requireUserVerification: false,
      }),
    ).rejects.toBeInstanceOf(WebAuthnError)
    // UV required but the flag is unset.
    await expect(
      verifyRegistration({
        ...base,
        clientDataJSONB64: bytesToBase64url(
          jsonBytes({ type: 'webauthn.create', challenge, origin: ORIGIN }),
        ),
        requireUserVerification: true,
      }),
    ).rejects.toBeInstanceOf(WebAuthnError)
  })
})

describe('WebAuthn authentication', () => {
  async function assertOnce(opts: {
    pair: CryptoKeyPair
    cose: Uint8Array
    signCount: number
    storedCounter: number
    challenge: string
    origin?: string
    tamper?: boolean
  }) {
    const authData = await buildAuthData({
      rpId: RP_ID,
      up: true,
      uv: true,
      signCount: opts.signCount,
    })
    const clientData = jsonBytes({
      type: 'webauthn.get',
      challenge: opts.challenge,
      origin: opts.origin ?? ORIGIN,
    })
    const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientData))
    const signedData = concat(authData, clientDataHash)
    const rawSig = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, opts.pair.privateKey, signedData),
    )
    if (opts.tamper) rawSig[0] ^= 0xff
    return verifyAuthentication({
      authenticatorDataB64: bytesToBase64url(authData),
      clientDataJSONB64: bytesToBase64url(clientData),
      signatureB64: bytesToBase64url(rawToDerEcdsa(rawSig)),
      storedPublicKey: bytesToBase64url(opts.cose),
      storedCounter: opts.storedCounter,
      expectedChallenge: opts.challenge,
      rpId: RP_ID,
      allowedOrigins: [ORIGIN],
      requireUserVerification: true,
    })
  }

  it('verifies an ES256 assertion and returns the advanced counter', async () => {
    const { pair, cose } = await genEc()
    const res = await assertOnce({
      pair,
      cose,
      signCount: 5,
      storedCounter: 3,
      challenge: randomChallenge(),
    })
    expect(res.newCounter).toBe(5)
  })

  it('accepts the 0/0 counter carve-out for platform authenticators', async () => {
    const { pair, cose } = await genEc()
    const res = await assertOnce({
      pair,
      cose,
      signCount: 0,
      storedCounter: 0,
      challenge: randomChallenge(),
    })
    expect(res.newCounter).toBe(0)
  })

  it('rejects a stalled counter (possible clone)', async () => {
    const { pair, cose } = await genEc()
    await expect(
      assertOnce({ pair, cose, signCount: 5, storedCounter: 5, challenge: randomChallenge() }),
    ).rejects.toBeInstanceOf(WebAuthnError)
  })

  it('rejects a challenge mismatch and a tampered signature', async () => {
    const { pair, cose } = await genEc()
    // Sign over one challenge but claim we expected another.
    const signed = await buildAssertionForChallenge(pair, cose, randomChallenge())
    await expect(
      verifyAuthentication({ ...signed, expectedChallenge: randomChallenge() }),
    ).rejects.toBeInstanceOf(WebAuthnError)
    await expect(
      assertOnce({ pair, cose, signCount: 9, storedCounter: 1, challenge: randomChallenge(), tamper: true }),
    ).rejects.toBeInstanceOf(WebAuthnError)
  })

  // Helper that returns a full verifyAuthentication input for a matching
  // challenge, so a test can then swap the expectedChallenge.
  async function buildAssertionForChallenge(pair: CryptoKeyPair, cose: Uint8Array, challenge: string) {
    const authData = await buildAuthData({ rpId: RP_ID, up: true, uv: true, signCount: 2 })
    const clientData = jsonBytes({ type: 'webauthn.get', challenge, origin: ORIGIN })
    const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientData))
    const rawSig = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        concat(authData, clientDataHash),
      ),
    )
    return {
      authenticatorDataB64: bytesToBase64url(authData),
      clientDataJSONB64: bytesToBase64url(clientData),
      signatureB64: bytesToBase64url(rawToDerEcdsa(rawSig)),
      storedPublicKey: bytesToBase64url(cose),
      storedCounter: 0,
      rpId: RP_ID,
      allowedOrigins: [ORIGIN] as string[],
      requireUserVerification: true,
    }
  }

  it('verifies an RS256 assertion (RSA branch)', async () => {
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
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    const cose = coseRsa(base64urlToBytes(jwk.n!), base64urlToBytes(jwk.e!))
    const authData = await buildAuthData({ rpId: RP_ID, up: true, signCount: 1 })
    const challenge = randomChallenge()
    const clientData = jsonBytes({ type: 'webauthn.get', challenge, origin: ORIGIN })
    const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientData))
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'RSASSA-PKCS1-v1_5' },
        pair.privateKey,
        concat(authData, clientDataHash),
      ),
    )
    const res = await verifyAuthentication({
      authenticatorDataB64: bytesToBase64url(authData),
      clientDataJSONB64: bytesToBase64url(clientData),
      signatureB64: bytesToBase64url(sig),
      storedPublicKey: bytesToBase64url(cose),
      storedCounter: 0,
      expectedChallenge: challenge,
      rpId: RP_ID,
      allowedOrigins: [ORIGIN],
      requireUserVerification: false,
    })
    expect(res.newCounter).toBe(1)
  })
})
