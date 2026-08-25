import { describe, it, expect } from 'vitest'
import { createPasswordHasher } from './password.js'

const PEPPER_A = 'pepper-a-12345678901234567890123456789012'
const PEPPER_B = 'pepper-b-12345678901234567890123456789012'

describe('createPasswordHasher', () => {
  it('hashes and verifies a password (round trip)', async () => {
    const h = createPasswordHasher({ pepper: PEPPER_A })
    const { secretHash, keyVersion } = await h.hash('correct horse battery staple')
    expect(typeof secretHash).toBe('string')
    expect(keyVersion).toBe(1)
    const ok = await h.verify(secretHash, keyVersion, 'correct horse battery staple')
    expect(ok).toBe(true)
  })

  it('rejects a wrong password', async () => {
    const h = createPasswordHasher({ pepper: PEPPER_A })
    const { secretHash, keyVersion } = await h.hash('a-real-password')
    const ok = await h.verify(secretHash, keyVersion, 'a-different-password')
    expect(ok).toBe(false)
  })

  it('a hash made with pepper A does NOT verify under pepper B (pepper actually does something)', async () => {
    const ha = createPasswordHasher({ pepper: PEPPER_A })
    const hb = createPasswordHasher({ pepper: PEPPER_B })
    const { secretHash, keyVersion } = await ha.hash('shared-password')
    const ok = await hb.verify(secretHash, keyVersion, 'shared-password')
    expect(ok).toBe(false)
  })

  it('supports legacy peppers for rotation', async () => {
    const oldH = createPasswordHasher({ pepper: PEPPER_A, pepperVersion: 1 })
    const { secretHash, keyVersion } = await oldH.hash('original-password')
    // Rotate: new active pepper is B (v=2), but A is kept as legacy v=1.
    const newH = createPasswordHasher({
      pepper: PEPPER_B,
      pepperVersion: 2,
      legacyPeppers: { 1: PEPPER_A },
    })
    expect(keyVersion).toBe(1)
    expect(newH.currentKeyVersion).toBe(2)
    const ok = await newH.verify(secretHash, keyVersion, 'original-password')
    expect(ok).toBe(true)
  })

  it('rejects verify against an unknown pepper version', async () => {
    const h = createPasswordHasher({ pepper: PEPPER_A })
    const { secretHash } = await h.hash('whatever')
    const ok = await h.verify(secretHash, 999, 'whatever')
    expect(ok).toBe(false)
  })

  it('dummyVerify completes without throwing (timing equalization)', async () => {
    const h = createPasswordHasher({ pepper: PEPPER_A })
    await expect(h.dummyVerify()).resolves.toBeUndefined()
  })

  it('shares the dummy hash derivation across hasher instances with the same pepper/version', async () => {
    // Two independently-constructed hashers over the same pepper +
    // version should hit the same module-level dummyHashCache entry
    // instead of each running its own ~32 MiB scrypt derivation. We
    // can't observe the cache directly (it's module-private), but a
    // concurrent-call race is the behavior the cache exists to avoid —
    // both should resolve cleanly whether or not they overlap.
    const h1 = createPasswordHasher({ pepper: PEPPER_A })
    const h2 = createPasswordHasher({ pepper: PEPPER_A })
    await expect(Promise.all([h1.dummyVerify(), h2.dummyVerify()])).resolves.toEqual([
      undefined,
      undefined,
    ])
  })

  it('dummyVerify still works independently per pepper (different peppers do not collide in the cache)', async () => {
    const ha = createPasswordHasher({ pepper: PEPPER_A })
    const hb = createPasswordHasher({ pepper: PEPPER_B })
    await expect(ha.dummyVerify()).resolves.toBeUndefined()
    await expect(hb.dummyVerify()).resolves.toBeUndefined()
  })
})
