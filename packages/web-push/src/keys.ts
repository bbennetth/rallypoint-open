import { bytesToBase64Url } from './base64url.js'
import type { VapidKeys } from './vapid.js'

// Generate a fresh VAPID (P-256) keypair. `publicKey` is the base64url raw
// 65-byte point used as the browser's `applicationServerKey`; `privateKey` is
// the base64url `d` scalar. Run once per environment: store the private key as
// a secret and expose the public key to the client. (Used by
// scripts/gen-vapid-keys.ts.)
export async function generateVapidKeys(subject: string): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  if (!jwk.d) throw new Error('failed to export VAPID private scalar')
  return { publicKey: bytesToBase64Url(rawPublic), privateKey: jwk.d, subject }
}
