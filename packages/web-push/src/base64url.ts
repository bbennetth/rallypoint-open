// base64url <-> bytes with no Buffer dependency, so the same code runs under
// workerd (no `Buffer` guaranteed) and Node. `btoa`/`atob` are global in both.

// ArrayBuffer-backed bytes. WebCrypto's BufferSource is ArrayBufferView<ArrayBuffer>,
// so the byte buffers we hand to crypto.subtle must be pinned to ArrayBuffer
// (not TS 5.7's default Uint8Array<ArrayBufferLike>, which also admits
// SharedArrayBuffer). Every value here is built via `new Uint8Array(...)` /
// TextEncoder / getRandomValues, all of which already yield this shape.
export type Bytes = Uint8Array<ArrayBuffer>

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlToBytes(value: string): Bytes {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  const binary = atob(b64 + pad)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
