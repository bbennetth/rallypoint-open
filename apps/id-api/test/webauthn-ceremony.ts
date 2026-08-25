// Test-only WebAuthn ceremony builder: mints real ES256 keys and
// assembles the exact base64url `credential` payloads the id-api
// handlers expect, using a minimal CTAP-canonical CBOR encoder + a
// raw→DER ECDSA packer. Shared by the handler D1 tests.
import { bytesToBase64url, base64urlToBytes } from '../src/crypto/webauthn/base64url.js'

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
  return new Uint8Array([(major << 5) | 25, (arg >> 8) & 0xff, arg & 0xff])
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
    [encInt(1), encInt(2)],
    [encInt(3), encInt(-7)],
    [encInt(-1), encInt(1)],
    [encInt(-2), encBytes(x)],
    [encInt(-3), encBytes(y)],
  ])

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
  if (opts.uv ?? true) flags |= 0x04
  if (opts.at) flags |= 0x40
  const sc = new Uint8Array(4)
  new DataView(sc.buffer).setUint32(0, opts.signCount)
  const parts = [rpIdHash, new Uint8Array([flags]), sc]
  if (opts.at) {
    const credId = opts.credId!
    const credIdLen = new Uint8Array(2)
    new DataView(credIdLen.buffer).setUint16(0, credId.length)
    parts.push(new Uint8Array(16), credIdLen, credId, opts.coseKey!)
  }
  return concat(...parts)
}

function rawToDerEcdsa(raw: Uint8Array): Uint8Array {
  const derInt = (bytes: Uint8Array): Uint8Array => {
    let i = 0
    while (i < bytes.length - 1 && bytes[i] === 0) i++
    let v = bytes.subarray(i)
    if ((v[0]! & 0x80) !== 0) v = concat(new Uint8Array([0]), v)
    return concat(new Uint8Array([0x02, v.length]), v)
  }
  const body = concat(derInt(raw.subarray(0, 32)), derInt(raw.subarray(32, 64)))
  return concat(new Uint8Array([0x30, body.length]), body)
}

const jsonBytes = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o))

export interface RegistrationCeremony {
  privateKey: CryptoKey
  credentialId: string
  credential: {
    id: string
    response: { clientDataJSON: string; attestationObject: string; transports: string[] }
  }
}

export async function buildRegistrationCredential(opts: {
  rpId: string
  origin: string
  challenge: string
  uv?: boolean
}): Promise<RegistrationCeremony> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const cose = coseEc2(base64urlToBytes(jwk.x!), base64urlToBytes(jwk.y!))
  const credId = crypto.getRandomValues(new Uint8Array(32))
  const authData = await buildAuthData({
    rpId: opts.rpId,
    up: true,
    uv: opts.uv ?? true,
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
  const clientData = jsonBytes({
    type: 'webauthn.create',
    challenge: opts.challenge,
    origin: opts.origin,
    crossOrigin: false,
  })
  const id = bytesToBase64url(credId)
  return {
    privateKey: pair.privateKey,
    credentialId: id,
    credential: {
      id,
      response: {
        clientDataJSON: bytesToBase64url(clientData),
        attestationObject: bytesToBase64url(attestationObject),
        transports: ['internal'],
      },
    },
  }
}

export async function buildAssertionCredential(opts: {
  rpId: string
  origin: string
  challenge: string
  privateKey: CryptoKey
  credentialId: string
  signCount: number
}): Promise<{
  id: string
  response: { clientDataJSON: string; authenticatorData: string; signature: string }
}> {
  const authData = await buildAuthData({
    rpId: opts.rpId,
    up: true,
    uv: true,
    signCount: opts.signCount,
  })
  const clientData = jsonBytes({ type: 'webauthn.get', challenge: opts.challenge, origin: opts.origin })
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientData))
  const rawSig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      opts.privateKey,
      concat(authData, clientDataHash),
    ),
  )
  return {
    id: opts.credentialId,
    response: {
      clientDataJSON: bytesToBase64url(clientData),
      authenticatorData: bytesToBase64url(authData),
      signature: bytesToBase64url(rawToDerEcdsa(rawSig)),
    },
  }
}
