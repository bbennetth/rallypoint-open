import { describe, it, expect } from 'vitest'
import { emailDomain } from './email-domain.js'

describe('emailDomain', () => {
  it('extracts the domain from a normal address', () => {
    expect(emailDomain('alice@example.com')).toBe('example.com')
  })

  it('lowercases the domain', () => {
    expect(emailDomain('alice@Example.COM')).toBe('example.com')
  })

  it('uses the LAST @ (multi-@ addresses are rare but valid in RFC 5322 local parts)', () => {
    expect(emailDomain('"a@b"@example.org')).toBe('example.org')
  })

  it('handles subdomains', () => {
    expect(emailDomain('a@mail.example.co.uk')).toBe('mail.example.co.uk')
  })

  it('returns "unknown" for a missing @ (defensive — should never happen post-validator)', () => {
    expect(emailDomain('not-an-email')).toBe('unknown')
  })

  it('returns "unknown" for a trailing @ (defensive)', () => {
    expect(emailDomain('alice@')).toBe('unknown')
  })

  it('returns "unknown" for the empty string', () => {
    expect(emailDomain('')).toBe('unknown')
  })
})
