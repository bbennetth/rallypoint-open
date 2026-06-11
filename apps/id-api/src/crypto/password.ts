import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { scryptAsync } from '@noble/hashes/scrypt.js'

// Password hashing — peppered scrypt. `key_version` lets us rotate the
// pepper without a flag day: each hash row records which pepper version
// was applied; we keep prior pepper values in env
// (`ARGON2_PEPPER_V<n>`) until every row has migrated.
//
// scrypt (not argon2id) because id-api runs on Cloudflare Workers, where
// argon2 WASM can't be instantiated at runtime (Workers forbid
// WebAssembly.compile of raw bytes; see docs/design/cf-spikes/argon2-worker.md).
// scrypt is memory-hard and ships in the audited, pure-JS @noble/hashes —
// no WASM, runs natively in workerd. node:crypto (HMAC/randomBytes/
// timingSafeEqual) is covered by nodejs_compat (cf-spikes/crypto-workers.md).
//
// V1 params: N=2^15 (32768), r=8, p=1, dkLen=32 — ~32 MiB, well within
// the 128 MB Worker isolate and comfortably under the per-/signin budget.
// Params are stored per hash so they can be raised later (re-hash on the
// next successful verify, like the pepper key_version).
const SCRYPT_N = 32768
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_DKLEN = 32
const SALT_BYTES = 16

// Security floor for params read back from a stored hash (OWASP scrypt
// minimums). Rejecting anything below this stops a tampered/forged
// secretHash from downgrading the cost (e.g. `scrypt$1$1$1$…` verifying
// near-instantly). Deliberately a FLOOR, not the current default, so
// raising SCRYPT_N later doesn't lock out hashes made at an older but
// still-acceptable cost — those re-hash on the next successful verify.
const MIN_N = 16384
const MIN_R = 8
const MIN_P = 1

export interface PasswordHasher {
  readonly currentKeyVersion: number
  hash(password: string): Promise<{ secretHash: string; keyVersion: number }>
  verify(secretHash: string, keyVersion: number, password: string): Promise<boolean>
  // Constant-time dummy hash invoked when the user-lookup misses, to
  // equalize signin timing.
  dummyVerify(): Promise<void>
}

export interface PasswordHasherConfig {
  // The active pepper, applied to every new hash.
  pepper: string
  pepperVersion?: number
  // Old peppers, keyed by version. Looked up on verify() if the row's
  // key_version doesn't match `pepperVersion`.
  legacyPeppers?: Record<number, string>
}

// Stored as `scrypt$<N>$<r>$<p>$<base64 salt>$<base64 dk>`.
function encodeHash(salt: Uint8Array, dk: Uint8Array): string {
  const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64')
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${b64(salt)}$${b64(dk)}`
}

interface ParsedHash {
  N: number
  r: number
  p: number
  salt: Buffer
  dk: Buffer
}

function parseHash(secretHash: string): ParsedHash | null {
  const parts = secretHash.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null
  // Reject downgraded/forged params below the security floor.
  if (N < MIN_N || r < MIN_R || p < MIN_P) return null
  const salt = Buffer.from(parts[4]!, 'base64')
  const dk = Buffer.from(parts[5]!, 'base64')
  if (salt.length === 0 || dk.length === 0) return null
  return { N, r, p, salt, dk }
}

async function derive(
  peppered: string,
  salt: Uint8Array,
  opts: { N: number; r: number; p: number; dkLen: number },
): Promise<Buffer> {
  return Buffer.from(await scryptAsync(peppered, salt, opts))
}

export function createPasswordHasher(config: PasswordHasherConfig): PasswordHasher {
  const currentKeyVersion = config.pepperVersion ?? 1
  const peppers: Record<number, string> = {
    [currentKeyVersion]: config.pepper,
    ...config.legacyPeppers,
  }

  function pepper(password: string, version: number): string {
    const key = peppers[version]
    if (!key) throw new Error(`Unknown ARGON2_PEPPER key_version ${version}`)
    // hex-encode the HMAC output so it's a clean UTF-8 KDF input.
    return createHmac('sha256', key).update(password, 'utf8').digest('hex')
  }

  // Precompute a dummy hash so dummyVerify() is constant-time on an
  // attacker-controllable miss. Generated lazily on first call.
  let dummyHash: string | null = null
  async function ensureDummyHash(): Promise<string> {
    if (dummyHash) return dummyHash
    const peppered = pepper('rallypoint-dummy-password-not-a-real-secret', currentKeyVersion)
    const salt = randomBytes(SALT_BYTES)
    const dk = await derive(peppered, salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, dkLen: SCRYPT_DKLEN })
    dummyHash = encodeHash(salt, dk)
    return dummyHash
  }

  return {
    currentKeyVersion,
    async hash(password) {
      const peppered = pepper(password, currentKeyVersion)
      const salt = randomBytes(SALT_BYTES)
      const dk = await derive(peppered, salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, dkLen: SCRYPT_DKLEN })
      return { secretHash: encodeHash(salt, dk), keyVersion: currentKeyVersion }
    },
    async verify(secretHash, keyVersion, password) {
      const parsed = parseHash(secretHash)
      if (!parsed) return false
      try {
        const peppered = pepper(password, keyVersion)
        const dk2 = await derive(peppered, parsed.salt, {
          N: parsed.N,
          r: parsed.r,
          p: parsed.p,
          dkLen: parsed.dk.length,
        })
        return parsed.dk.length === dk2.length && timingSafeEqual(parsed.dk, dk2)
      } catch {
        return false
      }
    },
    async dummyVerify() {
      const h = await ensureDummyHash()
      const parsed = parseHash(h)
      if (!parsed) return
      try {
        const peppered = pepper('definitely-not-the-password', currentKeyVersion)
        const dk2 = await derive(peppered, parsed.salt, {
          N: parsed.N,
          r: parsed.r,
          p: parsed.p,
          dkLen: parsed.dk.length,
        })
        // The point is the timing, not the outcome.
        if (parsed.dk.length === dk2.length) timingSafeEqual(parsed.dk, dk2)
      } catch {
        // swallow
      }
    },
  }
}
