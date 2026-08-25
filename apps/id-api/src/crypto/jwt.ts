import {
  base64urlToBytes,
  bytesToBase64url,
  utf8ToBytes,
  bytesToUtf8,
} from './webauthn/base64url.js'

// Hand-rolled JWT verification (OIDC id_token) + Apple client-secret
// signing, both on WebCrypto. Supports the two algorithms Google and
// Apple actually use for id_tokens (RS256) and the ES256 Apple requires
// for the client-secret JWT. No jose dependency.

export class JwtError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JwtError'
  }
}

export interface Jwk {
  kty: string
  kid?: string
  alg?: string
  use?: string
  n?: string
  e?: string
  x?: string
  y?: string
  crv?: string
}

export interface Jwks {
  keys: Jwk[]
}

interface JwtHeader {
  alg: string
  kid?: string
  typ?: string
}

interface DecodedJwt {
  header: JwtHeader
  payload: Record<string, unknown>
  signingInput: Uint8Array
  signature: Uint8Array
}

function decodeJwt(token: string): DecodedJwt {
  const parts = token.split('.')
  if (parts.length !== 3) throw new JwtError('malformed JWT (expected 3 segments)')
  const headerB64 = parts[0]!
  const payloadB64 = parts[1]!
  const signatureB64 = parts[2]!
  let header: JwtHeader
  let payload: Record<string, unknown>
  try {
    header = JSON.parse(bytesToUtf8(base64urlToBytes(headerB64))) as JwtHeader
    payload = JSON.parse(bytesToUtf8(base64urlToBytes(payloadB64))) as Record<string, unknown>
  } catch {
    throw new JwtError('JWT header/payload is not valid base64url JSON')
  }
  return {
    header,
    payload,
    signingInput: utf8ToBytes(`${headerB64}.${payloadB64}`),
    signature: base64urlToBytes(signatureB64),
  }
}

async function importVerifyKey(alg: string, jwk: Jwk) {
  if (alg === 'RS256') {
    if (!jwk.n || !jwk.e) throw new JwtError('RSA JWK missing modulus/exponent')
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    return { key, algorithm: { name: 'RSASSA-PKCS1-v1_5' } }
  }
  if (alg === 'ES256') {
    if (!jwk.x || !jwk.y) throw new JwtError('EC JWK missing coordinates')
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    // JWT ES256 signatures are already raw r||s — no DER conversion (unlike
    // WebAuthn assertions).
    return { key, algorithm: { name: 'ECDSA', hash: 'SHA-256' } }
  }
  throw new JwtError(`unsupported JWT algorithm ${alg}`)
}

function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === 'string') return aud === expected
  if (Array.isArray(aud)) return aud.includes(expected)
  return false
}

// Verify an OIDC id_token: signature (via the provider JWKS) + iss/aud/exp
// (+ nonce when supplied). Returns the validated claims on success.
export async function verifyIdToken(input: {
  idToken: string
  jwks: Jwks
  issuers: readonly string[]
  audience: string
  nonce?: string
  now?: number // ms epoch; injectable for tests
  clockToleranceSec?: number
}): Promise<Record<string, unknown>> {
  const { header, payload, signingInput, signature } = decodeJwt(input.idToken)

  const jwk =
    input.jwks.keys.find((k) => k.kid === header.kid) ??
    (input.jwks.keys.length === 1 ? input.jwks.keys[0] : undefined)
  if (!jwk) throw new JwtError('no JWK matches the token kid')

  const { key, algorithm } = await importVerifyKey(header.alg, jwk)
  const valid = await crypto.subtle.verify(algorithm, key, signature, signingInput)
  if (!valid) throw new JwtError('id_token signature verification failed')

  const now = input.now ?? Date.now()
  const toleranceMs = (input.clockToleranceSec ?? 60) * 1000

  const iss = payload['iss']
  if (typeof iss !== 'string' || !input.issuers.includes(iss)) throw new JwtError('issuer mismatch')
  if (!audienceMatches(payload['aud'], input.audience)) throw new JwtError('audience mismatch')

  const exp = payload['exp']
  if (typeof exp !== 'number' || now > exp * 1000 + toleranceMs) throw new JwtError('id_token expired')
  const iat = payload['iat']
  if (typeof iat === 'number' && iat * 1000 > now + toleranceMs) {
    throw new JwtError('id_token issued in the future')
  }
  if (input.nonce !== undefined && payload['nonce'] !== input.nonce) {
    throw new JwtError('nonce mismatch')
  }

  return payload
}

// Apple requires the OAuth client_secret to be an ES256 JWT signed with
// the developer's private key (a .p8 PKCS8 PEM). Build + sign it here.
export async function signAppleClientSecret(input: {
  teamId: string
  keyId: string
  clientId: string // the Services ID (OAuth client_id)
  privateKeyPkcs8Pem: string
  now?: number
  expiresInSec?: number
}): Promise<string> {
  const nowSec = Math.floor((input.now ?? Date.now()) / 1000)
  const expSec = nowSec + (input.expiresInSec ?? 3600)
  const header = { alg: 'ES256', kid: input.keyId, typ: 'JWT' }
  const payload = {
    iss: input.teamId,
    iat: nowSec,
    exp: expSec,
    aud: 'https://appleid.apple.com',
    sub: input.clientId,
  }
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`
  const key = await importApplePrivateKey(input.privateKeyPkcs8Pem)
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8ToBytes(signingInput))
  return `${signingInput}.${bytesToBase64url(new Uint8Array(sig))}`
}

function b64urlJson(obj: unknown): string {
  return bytesToBase64url(utf8ToBytes(JSON.stringify(obj)))
}

async function importApplePrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
  const der = new Uint8Array(Buffer.from(body, 'base64')) // standard base64, not base64url
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}
