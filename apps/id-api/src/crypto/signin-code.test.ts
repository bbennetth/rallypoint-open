import { describe, it, expect } from 'vitest'
import { generateSigninCode, hmacSigninCode, generateChallengeId } from './signin-code.js'

describe('generateSigninCode', () => {
  it('returns a 6-digit decimal string', () => {
    for (let i = 0; i < 100; i++) {
      const c = generateSigninCode()
      expect(c.length).toBe(6)
      expect(/^[0-9]{6}$/.test(c)).toBe(true)
    }
  })

  it('produces a varied distribution (not stuck on a single value)', () => {
    const set = new Set<string>()
    for (let i = 0; i < 100; i++) set.add(generateSigninCode())
    // 100 samples out of 1M — expect overwhelmingly unique.
    expect(set.size).toBeGreaterThan(90)
  })
})

describe('hmacSigninCode', () => {
  it('is deterministic for the same key', () => {
    expect(hmacSigninCode('123456', 'key')).toBe(hmacSigninCode('123456', 'key'))
  })

  it('differs across different keys', () => {
    expect(hmacSigninCode('123456', 'key-a')).not.toBe(hmacSigninCode('123456', 'key-b'))
  })

  it('differs across different codes', () => {
    expect(hmacSigninCode('111111', 'key')).not.toBe(hmacSigninCode('222222', 'key'))
  })

  it('returns 64 hex chars', () => {
    const h = hmacSigninCode('123456', 'key')
    expect(h.length).toBe(64)
    expect(/^[0-9a-f]+$/.test(h)).toBe(true)
  })
})

describe('generateChallengeId', () => {
  it('returns a 64-char hex string (256 bits)', () => {
    const id = generateChallengeId()
    expect(id.length).toBe(64)
    expect(/^[0-9a-f]+$/.test(id)).toBe(true)
  })

  it('is unique across many samples', () => {
    const set = new Set<string>()
    for (let i = 0; i < 1000; i++) set.add(generateChallengeId())
    expect(set.size).toBe(1000)
  })
})
