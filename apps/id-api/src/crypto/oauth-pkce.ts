import { randomBytes } from 'node:crypto'
import { bytesToBase64url, utf8ToBytes, sha256 } from './webauthn/base64url.js'

// PKCE (RFC 7636) + opaque state/nonce generation for the OAuth flows.
// 256 bits of entropy each; base64url (43 chars, unpadded).

export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

export async function codeChallengeS256(verifier: string): Promise<string> {
  // challenge = base64url(SHA-256(ASCII(verifier)))
  return bytesToBase64url(await sha256(utf8ToBytes(verifier)))
}

export function generateStateToken(): string {
  return randomBytes(32).toString('base64url')
}

export function generateNonce(): string {
  return randomBytes(32).toString('base64url')
}

// The per-transaction browser-bind secret set as an HttpOnly cookie at
// /oauth/:provider/start and required (by hash) at the callback.
export function generateBrowserBind(): string {
  return randomBytes(32).toString('base64url')
}
