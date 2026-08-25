import { describe, it, expect } from 'vitest'
import { normalizeEmail } from './normalize-email.js'

describe('normalizeEmail', () => {
  it('lowercases the whole address', () => {
    expect(normalizeEmail('Alice@Example.COM')).toBe('alice@example.com')
  })

  it('trims leading/trailing whitespace', () => {
    expect(normalizeEmail('  alice@example.com  ')).toBe('alice@example.com')
  })

  it('trims and lowercases together', () => {
    expect(normalizeEmail('  Alice@Example.com')).toBe('alice@example.com')
  })

  it('is idempotent', () => {
    const once = normalizeEmail('Alice@Example.com')
    expect(normalizeEmail(once)).toBe(once)
  })

  it('leaves an already-normalized address unchanged', () => {
    expect(normalizeEmail('alice@example.com')).toBe('alice@example.com')
  })
})
