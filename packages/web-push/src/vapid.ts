// Voluntary Application Server Identification (VAPID, RFC 8292): a short-lived
// ES256 JWT the push service uses to attribute and rate-limit the sender.
// WebCrypto's ECDSA P-256 signature is already the raw r‖s ("IEEE P1363")
// format JWT ES256 expects, so no DER unwrapping is needed.

import { base64UrlToBytes, bytesToBase64Url } from './base64url.js'

export interface VapidKeys {
  /** base64url raw 65-byte uncompressed P-256 point (the applicationServerKey). */
  publicKey: string
  /** base64url 32-byte private scalar `d`. */
  privateKey: string
  /** Contact URI — `mailto:...` or an https URL. */
  subject: string
}

const textEncoder = new TextEncoder()

function jsonToBase64Url(value: unknown): string {
  return bytesToBase64Url(textEncoder.encode(JSON.stringify(value)))
}

// Reconstruct a JWK from the public point (X/Y) + the private scalar (d) and
// import it for signing. WebCrypto can't import a bare raw private scalar, so
// the JWK form is the portable path.
async function importSigningKey(keys: VapidKeys): Promise<CryptoKey> {
  const point = base64UrlToBytes(keys.publicKey) // 0x04 || X(32) || Y(32)
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: keys.privateKey,
    x: bytesToBase64Url(point.slice(1, 33)),
    y: bytesToBase64Url(point.slice(33, 65)),
    ext: true,
  }
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

export interface VapidJwtOptions {
  /** `scheme://host` of the push endpoint (no path). */
  audience: string
  keys: VapidKeys
  /** Token lifetime; spec caps it at 24h. Default 12h. */
  expiresInSeconds?: number
  /** Override the clock (ms since epoch) for deterministic tests. */
  now?: number
}

export async function signVapidJwt(opts: VapidJwtOptions): Promise<string> {
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000)
  const exp = nowSec + (opts.expiresInSeconds ?? 12 * 60 * 60)
  const header = { typ: 'JWT', alg: 'ES256' }
  const payload = { aud: opts.audience, exp, sub: opts.keys.subject }
  const signingInput = `${jsonToBase64Url(header)}.${jsonToBase64Url(payload)}`
  const key = await importSigningKey(opts.keys)
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      textEncoder.encode(signingInput),
    ),
  )
  return `${signingInput}.${bytesToBase64Url(signature)}`
}
