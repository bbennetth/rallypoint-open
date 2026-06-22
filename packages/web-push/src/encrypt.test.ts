import { describe, it, expect } from 'vitest'
import { encryptPayload } from './encrypt.js'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function concat(...chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  lengthBytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    lengthBytes * 8,
  )
  return new Uint8Array(bits)
}

// Reference receiver: reverse the RFC 8291 / RFC 8188 transform using the UA
// private key. Proves the produced body is decryptable by a conforming
// recipient (which is exactly what a real browser push service does).
async function decryptPayload(
  body: Uint8Array,
  uaKeyPair: CryptoKeyPair,
  authSecret: Uint8Array,
): Promise<Uint8Array> {
  const salt = body.slice(0, 16)
  const idlen = body[20]!
  const serverPublicKey = body.slice(21, 21 + idlen)
  const ciphertext = body.slice(21 + idlen)

  const uaPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', uaKeyPair.publicKey))
  const serverKey = await crypto.subtle.importKey(
    'raw',
    serverPublicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, uaKeyPair.privateKey, 256),
  )
  const keyInfo = concat(textEncoder.encode('WebPush: info\0'), uaPublicKey, serverPublicKey)
  const ikm = await hkdf(sharedSecret, authSecret, keyInfo, 32)
  const cek = await hkdf(ikm, salt, textEncoder.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(ikm, salt, textEncoder.encode('Content-Encoding: nonce\0'), 12)
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt'])
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ciphertext),
  )
  // Strip the trailing 0x02 last-record delimiter.
  expect(plain[plain.length - 1]).toBe(0x02)
  return plain.slice(0, plain.length - 1)
}

async function freshSubscriberKeys(): Promise<{
  keyPair: CryptoKeyPair
  publicKey: Uint8Array
  authSecret: Uint8Array
}> {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey))
  const authSecret = crypto.getRandomValues(new Uint8Array(16))
  return { keyPair, publicKey, authSecret }
}

describe('encryptPayload (RFC 8291 / aes128gcm)', () => {
  it('round-trips: a conforming recipient decrypts to the original plaintext', async () => {
    const ua = await freshSubscriberKeys()
    const message = 'When I grow up, I want to be a watermelon'
    const { body } = await encryptPayload({
      uaPublicKey: ua.publicKey,
      authSecret: ua.authSecret,
      payload: textEncoder.encode(message),
    })
    const decrypted = await decryptPayload(body, ua.keyPair, ua.authSecret)
    expect(textDecoder.decode(decrypted)).toBe(message)
  })

  it('emits a well-formed aes128gcm header (salt, rs=4096, idlen=65 keyid)', async () => {
    const ua = await freshSubscriberKeys()
    const payload = textEncoder.encode('hello')
    const { body, serverPublicKey, salt } = await encryptPayload({
      uaPublicKey: ua.publicKey,
      authSecret: ua.authSecret,
      payload,
    })
    expect(salt.length).toBe(16)
    expect(body.slice(0, 16)).toEqual(salt)
    expect(new DataView(body.buffer, body.byteOffset).getUint32(16, false)).toBe(4096)
    expect(body[20]).toBe(65)
    expect(serverPublicKey.length).toBe(65)
    expect(body.slice(21, 86)).toEqual(serverPublicKey)
    // ciphertext = plaintext + 0x02 delimiter + 16-byte GCM tag.
    expect(body.length - 86).toBe(payload.length + 1 + 16)
  })

  it('is deterministic when the salt + ephemeral keypair are injected', async () => {
    const ua = await freshSubscriberKeys()
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const serverKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    )
    const args = {
      uaPublicKey: ua.publicKey,
      authSecret: ua.authSecret,
      payload: textEncoder.encode('stable'),
      salt,
      serverKeyPair,
    }
    const a = await encryptPayload(args)
    const b = await encryptPayload(args)
    expect(a.body).toEqual(b.body)
  })
})
