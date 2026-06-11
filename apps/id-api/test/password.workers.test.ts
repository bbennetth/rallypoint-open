import { describe, expect, it } from 'vitest'
import { createPasswordHasher } from '../src/crypto/password.js'

// Proves the scrypt password hasher runs inside a workerd isolate — the
// security-critical path that must work once id-api deploys as a Worker.
// Exercises the real node:crypto (HMAC/randomBytes/timingSafeEqual, via
// nodejs_compat) + @noble/hashes scrypt (pure JS) combo, not a mock.

describe('createPasswordHasher under workerd (scrypt)', () => {
  const hasher = createPasswordHasher({ pepper: 'workerd-test-pepper-0123456789abcdef0123' })

  it('hash → verify round-trips in-isolate', async () => {
    const { secretHash, keyVersion } = await hasher.hash('correct horse battery staple')
    expect(secretHash.startsWith('scrypt$')).toBe(true)
    expect(keyVersion).toBe(1)
    expect(await hasher.verify(secretHash, keyVersion, 'correct horse battery staple')).toBe(true)
    expect(await hasher.verify(secretHash, keyVersion, 'wrong-password')).toBe(false)
  })

  it('dummyVerify runs without throwing (timing-equalizer)', async () => {
    await expect(hasher.dummyVerify()).resolves.toBeUndefined()
  })
})
