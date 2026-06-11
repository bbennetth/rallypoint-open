import { describe, it, expect } from 'vitest'
import { createBearerCipher } from './encryption.js'

// Neutral test prefix — the package no longer bakes in any app's
// prefix; each consumer binds its own via createBearerCipher().
const KEY_PREFIX = 'CRYPTO_TEST_KEY_V'
const { encryptBearer, decryptBearer } = createBearerCipher(KEY_PREFIX)

const env = {
  CRYPTO_TEST_KEY_V1: 'v1-secret-' + 'x'.repeat(32),
  CRYPTO_TEST_KEY_V2: 'v2-secret-' + 'y'.repeat(32),
}

const PLAINTEXT = 'rps_abc123.session.bearer.value'
const AAD = 'sha256-id-hash-of-the-events-session'

describe('encryptBearer / decryptBearer round-trip', () => {
  it('decrypts back to the original plaintext', () => {
    const sealed = encryptBearer({ plaintext: PLAINTEXT, aad: AAD, env, keyVersion: 1 })
    const out = decryptBearer({ ...sealed, aad: AAD, env })
    expect(out).toBe(PLAINTEXT)
  })

  it('produces a 12-byte nonce and a ciphertext longer than the tag', () => {
    const sealed = encryptBearer({ plaintext: PLAINTEXT, aad: AAD, env, keyVersion: 1 })
    expect(sealed.nonce.length).toBe(12)
    expect(sealed.ciphertext.length).toBeGreaterThan(16)
    expect(sealed.keyVersion).toBe(1)
  })

  it('handles empty plaintext', () => {
    const sealed = encryptBearer({ plaintext: '', aad: AAD, env, keyVersion: 1 })
    expect(decryptBearer({ ...sealed, aad: AAD, env })).toBe('')
  })
})

describe('authentication (the security-critical branch)', () => {
  it('throws when decrypting with the wrong AAD', () => {
    const sealed = encryptBearer({ plaintext: PLAINTEXT, aad: AAD, env, keyVersion: 1 })
    expect(() => decryptBearer({ ...sealed, aad: 'different-id-hash', env })).toThrow()
  })

  it('throws when the ciphertext is tampered', () => {
    const sealed = encryptBearer({ plaintext: PLAINTEXT, aad: AAD, env, keyVersion: 1 })
    const tampered = Buffer.from(sealed.ciphertext)
    tampered[0] ^= 0xff
    expect(() =>
      decryptBearer({ ...sealed, ciphertext: tampered, aad: AAD, env }),
    ).toThrow()
  })

  it('throws when the nonce is wrong', () => {
    const sealed = encryptBearer({ plaintext: PLAINTEXT, aad: AAD, env, keyVersion: 1 })
    const wrongNonce = Buffer.alloc(12, 0)
    expect(() => decryptBearer({ ...sealed, nonce: wrongNonce, aad: AAD, env })).toThrow()
  })

  it('throws on a ciphertext shorter than the auth tag', () => {
    expect(() =>
      decryptBearer({
        ciphertext: Buffer.alloc(8),
        nonce: Buffer.alloc(12),
        keyVersion: 1,
        aad: AAD,
        env,
      }),
    ).toThrow(/too short/i)
  })
})

describe('nonce uniqueness', () => {
  it('generates 1000 distinct nonces', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const { nonce } = encryptBearer({ plaintext: PLAINTEXT, aad: AAD, env, keyVersion: 1 })
      seen.add(nonce.toString('hex'))
    }
    expect(seen.size).toBe(1000)
  })
})

describe('key versioning', () => {
  it('decrypts with the matching key version', () => {
    const sealed = encryptBearer({ plaintext: PLAINTEXT, aad: AAD, env, keyVersion: 2 })
    expect(sealed.keyVersion).toBe(2)
    expect(decryptBearer({ ...sealed, aad: AAD, env })).toBe(PLAINTEXT)
  })

  it('fails to authenticate when decrypted under a different key version', () => {
    const sealed = encryptBearer({ plaintext: PLAINTEXT, aad: AAD, env, keyVersion: 1 })
    expect(() => decryptBearer({ ...sealed, keyVersion: 2, aad: AAD, env })).toThrow()
  })

  it('throws when encrypting with a missing key version', () => {
    expect(() =>
      encryptBearer({ plaintext: PLAINTEXT, aad: AAD, env, keyVersion: 9 }),
    ).toThrow(/Missing encryption key CRYPTO_TEST_KEY_V9/)
  })

  it('throws when decrypting with a missing key version', () => {
    const sealed = encryptBearer({ plaintext: PLAINTEXT, aad: AAD, env, keyVersion: 1 })
    expect(() => decryptBearer({ ...sealed, keyVersion: 9, aad: AAD, env })).toThrow(
      /Missing encryption key/,
    )
  })
})
