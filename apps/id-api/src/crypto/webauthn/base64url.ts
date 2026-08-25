// Byte/base64url/utf8 encoding helpers for the WebAuthn + OIDC crypto.
// base64url via Buffer (nodejs_compat is on — same idiom as
// packages/crypto/tokens.ts) so padding/URL-safety is handled for us.

export function bytesToBase64url(input: Uint8Array | ArrayBuffer): string {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input
  return Buffer.from(bytes).toString('base64url')
}

export function base64urlToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'))
}

export function utf8ToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

export function bytesToUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b)
}

// SHA-256 over raw bytes, via WebCrypto (workerd + Node). Async by
// construction — every caller here already awaits crypto.subtle.
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return new Uint8Array(digest)
}

export async function sha256Base64url(data: Uint8Array): Promise<string> {
  return bytesToBase64url(await sha256(data))
}

// Constant-time byte compare (WebAuthn challenge / rpIdHash checks).
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number)
  return diff === 0
}
