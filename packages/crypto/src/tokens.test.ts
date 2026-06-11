import { describe, it, expect } from 'vitest'
import {
  generateRawToken,
  hashToken,
  constantTimeEqual,
  tokenHasPrefix,
} from './tokens.js'

describe('generateRawToken', () => {
  it('prepends the prefix verbatim', () => {
    const t = generateRawToken('rpv_')
    expect(t.startsWith('rpv_')).toBe(true)
  })

  it('produces 256 bits of base64url entropy after the prefix', () => {
    const t = generateRawToken('rps_live_')
    const body = t.slice('rps_live_'.length)
    // base64url of 32 bytes = 43 chars (no padding)
    expect(body.length).toBe(43)
    expect(/^[A-Za-z0-9_-]+$/.test(body)).toBe(true)
  })

  it('generates unique tokens (no two collisions in 1000 samples)', () => {
    const set = new Set<string>()
    for (let i = 0; i < 1000; i++) set.add(generateRawToken('rpv_'))
    expect(set.size).toBe(1000)
  })
})

describe('hashToken', () => {
  it('produces a 64-char lowercase hex digest', () => {
    const h = hashToken('rpv_xyz')
    expect(h.length).toBe(64)
    expect(/^[0-9a-f]+$/.test(h)).toBe(true)
  })

  it('is deterministic', () => {
    const a = hashToken('rpv_xyz')
    const b = hashToken('rpv_xyz')
    expect(a).toBe(b)
  })

  it('returns different digests for different inputs (sanity)', () => {
    expect(hashToken('rpv_a')).not.toBe(hashToken('rpv_b'))
  })
})

describe('constantTimeEqual', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
  })

  it('returns false for different equal-length strings', () => {
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
  })

  it('returns false for different-length strings without throwing', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
  })

  it('returns false for non-string inputs (defensive)', () => {
    // @ts-expect-error — testing runtime resilience
    expect(constantTimeEqual(null, 'abc')).toBe(false)
  })
})

describe('tokenHasPrefix', () => {
  it('accepts a valid prefix', () => {
    expect(tokenHasPrefix('rpv_xyz', 'rpv_')).toBe(true)
  })

  it('rejects a wrong prefix of the same length', () => {
    expect(tokenHasPrefix('rpr_xyz', 'rpv_')).toBe(false)
  })

  it('rejects an input shorter than the prefix', () => {
    expect(tokenHasPrefix('rp', 'rpv_')).toBe(false)
  })
})
