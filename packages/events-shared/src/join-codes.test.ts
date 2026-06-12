import { describe, expect, it } from 'vitest'
import {
  SHORT_CODE_ALPHABET,
  SHORT_CODE_LENGTH,
  generateShortCode,
  normalizeShortCode,
} from './join-codes.js'

describe('generateShortCode', () => {
  it('produces 6 chars from the confusion-free alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateShortCode()
      expect(code).toHaveLength(SHORT_CODE_LENGTH)
      for (const ch of code) expect(SHORT_CODE_ALPHABET).toContain(ch)
    }
  })

  it('never emits I, O, 0, or 1', () => {
    expect(SHORT_CODE_ALPHABET).not.toMatch(/[IO01]/)
  })

  it('uses the injected byte source deterministically', () => {
    const code = generateShortCode((n) => new Uint8Array(n)) // all zeros
    expect(code).toBe('AAAAAA')
    const code2 = generateShortCode((n) => new Uint8Array(n).fill(33)) // 33 % 32 = 1
    expect(code2).toBe('BBBBBB')
  })
})

describe('normalizeShortCode', () => {
  it('uppercases and strips separators/whitespace', () => {
    expect(normalizeShortCode(' ab-c2 d3 ')).toBe('ABC2D3')
    expect(normalizeShortCode('abc2d3')).toBe('ABC2D3')
  })

  it('rejects wrong lengths', () => {
    expect(normalizeShortCode('ABC2D')).toBeNull()
    expect(normalizeShortCode('ABC2D34')).toBeNull()
    expect(normalizeShortCode('')).toBeNull()
  })

  it('rejects codes containing out-of-alphabet chars (I/O/0/1)', () => {
    expect(normalizeShortCode('ABC10D')).toBeNull()
    expect(normalizeShortCode('ABCIOD')).toBeNull()
  })

  it('rejects rpj_ tokens (too long after cleaning)', () => {
    expect(normalizeShortCode('rpj_aGVsbG8gd29ybGQgaGVsbG8')).toBeNull()
  })
})
