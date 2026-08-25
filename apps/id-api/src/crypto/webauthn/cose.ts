import { decodeCborStrict, type CborValue } from './cbor.js'
import { bytesToBase64url } from './base64url.js'

// COSE_Key parsing + WebCrypto import for WebAuthn credential public
// keys, and the DER→raw ECDSA signature conversion assertions need.
//
// We support exactly the two algorithms every mainstream authenticator
// uses: ES256 (-7, EC P-256) and RS256 (-257, RSA). Anything else is
// rejected at registration so we never store a key we can't verify.

export const COSE_ALG_ES256 = -7
export const COSE_ALG_RS256 = -257

// COSE_Key common + type-specific label constants.
const COSE_LABEL_KTY = 1
const COSE_LABEL_ALG = 3
const COSE_LABEL_EC_CRV = -1
const COSE_LABEL_EC_X = -2
const COSE_LABEL_EC_Y = -3
const COSE_LABEL_RSA_N = -1
const COSE_LABEL_RSA_E = -2
const COSE_KTY_EC2 = 2
const COSE_KTY_RSA = 3
const COSE_CRV_P256 = 1

function asCoseMap(bytes: Uint8Array): Map<number | string, CborValue> {
  const decoded = decodeCborStrict(bytes)
  if (!(decoded instanceof Map)) throw new Error('cose: key is not a CBOR map')
  return decoded
}

export function coseKeyAlg(coseBytes: Uint8Array): number {
  const alg = asCoseMap(coseBytes).get(COSE_LABEL_ALG)
  if (typeof alg !== 'number') throw new Error('cose: missing/invalid alg')
  return alg
}

// Import a stored COSE public key into a WebCrypto verify key. Return the
// alg too so the caller picks the right verify algorithm + (for ES256)
// applies the DER→raw signature conversion.
export async function importCosePublicKey(
  coseBytes: Uint8Array,
): Promise<{ key: CryptoKey; alg: number }> {
  const map = asCoseMap(coseBytes)
  const kty = map.get(COSE_LABEL_KTY)
  const alg = map.get(COSE_LABEL_ALG)
  if (typeof alg !== 'number') throw new Error('cose: missing/invalid alg')

  if (kty === COSE_KTY_EC2) {
    if (alg !== COSE_ALG_ES256) throw new Error(`cose: unsupported EC alg ${alg}`)
    if (map.get(COSE_LABEL_EC_CRV) !== COSE_CRV_P256) throw new Error('cose: unsupported EC curve')
    const x = map.get(COSE_LABEL_EC_X)
    const y = map.get(COSE_LABEL_EC_Y)
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
      throw new Error('cose: bad EC coordinates')
    }
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: bytesToBase64url(x), y: bytesToBase64url(y), ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    return { key, alg }
  }

  if (kty === COSE_KTY_RSA) {
    if (alg !== COSE_ALG_RS256) throw new Error(`cose: unsupported RSA alg ${alg}`)
    const n = map.get(COSE_LABEL_RSA_N)
    const e = map.get(COSE_LABEL_RSA_E)
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) {
      throw new Error('cose: bad RSA parameters')
    }
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: bytesToBase64url(n), e: bytesToBase64url(e), ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    return { key, alg }
  }

  throw new Error(`cose: unsupported key type ${String(kty)}`)
}

// WebAuthn ES256 assertion signatures are ASN.1 DER (SEQUENCE of two
// INTEGERs r,s). WebCrypto ECDSA verify wants the raw IEEE-P1363 r||s
// (64 bytes). Convert, stripping DER's sign-bit leading zeros and
// left-padding each coordinate to 32 bytes.
export function derToRawEcdsaSignature(der: Uint8Array): Uint8Array {
  const dv = new DataView(der.buffer, der.byteOffset, der.byteLength)
  const cursor = { i: 0 }
  const readByte = (): number => {
    if (cursor.i >= der.length) throw new Error('ecdsa der: unexpected end')
    return dv.getUint8(cursor.i++)
  }
  const readLength = (): number => {
    const first = readByte()
    if ((first & 0x80) === 0) return first
    let len = 0
    for (let n = first & 0x7f; n > 0; n--) len = (len << 8) | readByte()
    return len
  }
  const readInteger = (): Uint8Array => {
    if (readByte() !== 0x02) throw new Error('ecdsa der: expected INTEGER')
    const len = readLength()
    const start = cursor.i
    const end = start + len
    if (end > der.length) throw new Error('ecdsa der: integer out of range')
    cursor.i = end
    return der.subarray(start, end)
  }
  if (readByte() !== 0x30) throw new Error('ecdsa der: expected SEQUENCE')
  readLength() // total sequence length — not needed, both integers follow
  const r = readInteger()
  const s = readInteger()
  const out = new Uint8Array(64)
  out.set(leftPad32(stripLeadingZeros(r)), 0)
  out.set(leftPad32(stripLeadingZeros(s)), 32)
  return out
}

function stripLeadingZeros(bytes: Uint8Array): Uint8Array {
  let i = 0
  while (i < bytes.length - 1 && bytes[i] === 0) i++
  return bytes.subarray(i)
}

function leftPad32(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 32) return bytes
  if (bytes.length > 32) throw new Error('ecdsa der: coordinate longer than 32 bytes')
  const out = new Uint8Array(32)
  out.set(bytes, 32 - bytes.length)
  return out
}
