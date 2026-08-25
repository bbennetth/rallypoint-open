import { describe, it, expect } from 'vitest'
import { generateCsrfToken } from './csrf.js'

// generateCsrfToken switched from node:crypto randomBytes to WebCrypto
// crypto.getRandomValues (#675) — no nodejs_compat dependency. Assert the
// output shape/entropy is unchanged and tokens are not repeated.
describe('generateCsrfToken', () => {
  it('produces a 43-char base64url token (256 bits, no padding)', () => {
    const token = generateCsrfToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('produces distinct tokens on successive calls', () => {
    const a = generateCsrfToken()
    const b = generateCsrfToken()
    expect(a).not.toBe(b)
  })
})
