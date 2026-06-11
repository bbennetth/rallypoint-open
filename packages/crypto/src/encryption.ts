import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

// Authenticated encryption-at-rest for an SSO session bearer that a
// peer app must replay to RPID's verifySession() (design doc §3.13).
// Unlike the local session bearer — which we only ever compare by
// hash — this secret has to come back out in plaintext, so it cannot
// be hashed. We seal it with AES-256-GCM:
//
//   - Key: SHA-256(<keyEnvPrefix><n>) → exactly 32 bytes. Deriving via
//     SHA-256 means we don't trust the env var to be exactly 32 bytes
//     wide; any sufficiently-random secret works.
//   - Nonce: 12 fresh random bytes per encryption (GCM's standard IV
//     width). Stored per row; never reused under a given key.
//   - AAD: the row's id_hash. Binds the ciphertext to its row so a
//     ciphertext lifted into another row fails authentication.
//   - keyVersion: stored per row so a future key rotation can add a
//     V2 key and still decrypt V1 rows.
//
// The 16-byte GCM auth tag is appended to the ciphertext (the
// `ciphertext` field is `enc || tag`); decrypt splits it back off and
// a tampered ciphertext / wrong AAD / wrong key throws on final().
//
// The key env prefix is the only per-app difference (events-api uses
// EVENTS_SESSION_KEY_V, lists-api LISTS_SESSION_KEY_V, …), so each app
// binds its prefix once via createBearerCipher().

const NONCE_BYTES = 12
const TAG_BYTES = 16
const ALGO = 'aes-256-gcm'

export type EncryptionEnv = Record<string, string | undefined>

export interface SealedBearer {
  ciphertext: Buffer
  nonce: Buffer
  keyVersion: number
}

export interface BearerCipher {
  encryptBearer(params: {
    plaintext: string
    aad: string
    env: EncryptionEnv
    keyVersion: number
  }): SealedBearer
  decryptBearer(params: {
    ciphertext: Buffer
    nonce: Buffer
    keyVersion: number
    aad: string
    env: EncryptionEnv
  }): string
}

export function createBearerCipher(keyEnvPrefix: string): BearerCipher {
  function deriveKey(env: EncryptionEnv, keyVersion: number): Buffer {
    const secret = env[`${keyEnvPrefix}${keyVersion}`]
    if (!secret) {
      throw new Error(`Missing encryption key ${keyEnvPrefix}${keyVersion}`)
    }
    return createHash('sha256').update(secret, 'utf8').digest()
  }

  return {
    encryptBearer({ plaintext, aad, env, keyVersion }) {
      const key = deriveKey(env, keyVersion)
      const nonce = randomBytes(NONCE_BYTES)
      const cipher = createCipheriv(ALGO, key, nonce)
      cipher.setAAD(Buffer.from(aad, 'utf8'))
      const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return { ciphertext: Buffer.concat([enc, tag]), nonce, keyVersion }
    },

    decryptBearer({ ciphertext, nonce, keyVersion, aad, env }) {
      if (ciphertext.length < TAG_BYTES) {
        throw new Error('Ciphertext too short to contain an auth tag')
      }
      const key = deriveKey(env, keyVersion)
      const enc = ciphertext.subarray(0, ciphertext.length - TAG_BYTES)
      const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES)
      const decipher = createDecipheriv(ALGO, key, nonce)
      decipher.setAAD(Buffer.from(aad, 'utf8'))
      decipher.setAuthTag(tag)
      // final() throws if the tag doesn't authenticate (tamper, wrong
      // AAD, or wrong key) — let it propagate; callers treat a throw as
      // "this row is unusable".
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
    },
  }
}
