// Message Encryption for Web Push (RFC 8291) over the aes128gcm
// content-encoding (RFC 8188), implemented with WebCrypto only so it runs
// unchanged on Cloudflare Workers (workerd) and Node.
//
//   ECDH(P-256) shared secret
//     -> HKDF-SHA256 with the WebPush key-info  => IKM (32 bytes)
//     -> HKDF-SHA256 with the record salt        => CEK (16) + NONCE (12)
//   AES-128-GCM( CEK, NONCE, plaintext || 0x02 )
//   body = salt(16) || rs(4) || idlen(1) || serverPublicKey || ciphertext

import type { Bytes } from './base64url.js'

const textEncoder = new TextEncoder()

// Single-record content size advertised in the aes128gcm header. Our payloads
// are tiny (one JSON notification), so one record always suffices.
const RECORD_SIZE = 4096

function concatBytes(...chunks: Bytes[]): Bytes {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

async function hkdf(
  ikm: Bytes,
  salt: Bytes,
  info: Bytes,
  lengthBytes: number,
): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    lengthBytes * 8,
  )
  return new Uint8Array(bits)
}

export interface EncryptInput {
  /** The subscription `p256dh` key: the UA public key as a raw 65-byte point. */
  uaPublicKey: Bytes
  /** The subscription `auth` secret (16 bytes). */
  authSecret: Bytes
  /** The plaintext to encrypt. */
  payload: Bytes
  /** Override the random 16-byte record salt (deterministic tests only). */
  salt?: Bytes
  /** Override the ephemeral server ECDH keypair (deterministic tests only). */
  serverKeyPair?: CryptoKeyPair
}

export interface EncryptResult {
  /** The full aes128gcm body (header + single ciphertext record). */
  body: Bytes
  /** The ephemeral server public key (raw 65-byte point) used as the keyid. */
  serverPublicKey: Bytes
  /** The record salt used. */
  salt: Bytes
}

export async function encryptPayload(input: EncryptInput): Promise<EncryptResult> {
  const salt = input.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const serverKeyPair =
    input.serverKeyPair ??
    (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']))
  const serverPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeyPair.publicKey))

  const uaKey = await crypto.subtle.importKey(
    'raw',
    input.uaPublicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, serverKeyPair.privateKey, 256),
  )

  // RFC 8291 §3.4 — combine the auth secret + ECDH secret into the IKM.
  const keyInfo = concatBytes(
    textEncoder.encode('WebPush: info\0'),
    input.uaPublicKey,
    serverPublicKey,
  )
  const ikm = await hkdf(sharedSecret, input.authSecret, keyInfo, 32)

  // RFC 8188 — derive the content-encryption key + nonce from the IKM + salt.
  const cek = await hkdf(ikm, salt, textEncoder.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(ikm, salt, textEncoder.encode('Content-Encoding: nonce\0'), 12)

  // Single, final record: plaintext followed by the 0x02 last-record delimiter.
  const padded = concatBytes(input.payload, new Uint8Array([0x02]))
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt'])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded),
  )

  // Header: salt(16) || rs(4, big-endian) || idlen(1) || keyid(serverPublicKey).
  const header = new Uint8Array(16 + 4 + 1 + serverPublicKey.length)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false)
  header[20] = serverPublicKey.length
  header.set(serverPublicKey, 21)

  return { body: concatBytes(header, ciphertext), serverPublicKey, salt }
}
