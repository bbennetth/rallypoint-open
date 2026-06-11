// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildLoginRequiredUrl,
  parentDomainForHost,
  isTrustedReturnTo,
  clearStaleSsoHint,
} from './sso-authorize.js'

describe('parentDomainForHost', () => {
  it('returns .rallypt.dev for id.rallypt.dev', () => {
    expect(parentDomainForHost('id.rallypt.dev')).toBe('.rallypt.dev')
  })

  it('returns .rallypt.app for events.rallypt.app', () => {
    expect(parentDomainForHost('events.rallypt.app')).toBe('.rallypt.app')
  })

  it('returns null for localhost (single label)', () => {
    expect(parentDomainForHost('localhost')).toBeNull()
  })

  it('returns the last two labels for a deeply-nested host', () => {
    expect(parentDomainForHost('a.b.c.rallypt.dev')).toBe('.rallypt.dev')
  })

  it('returns the eTLD+1 for a bare two-label host like rallypt.dev', () => {
    expect(parentDomainForHost('rallypt.dev')).toBe('.rallypt.dev')
  })
})

describe('buildLoginRequiredUrl', () => {
  it('adds error and state to a plain return_to', () => {
    const result = buildLoginRequiredUrl('https://events.rallypt.dev/callback', 'abc123')
    const url = new URL(result)
    expect(url.searchParams.get('error')).toBe('login_required')
    expect(url.searchParams.get('state')).toBe('abc123')
    // No extra junk
    expect([...url.searchParams.keys()]).toEqual(['error', 'state'])
  })

  it('preserves existing query params and overwrites error/state if already present', () => {
    const result = buildLoginRequiredUrl(
      'https://events.rallypt.dev/callback?foo=bar&error=old&state=old',
      'newstate',
    )
    const url = new URL(result)
    expect(url.searchParams.get('foo')).toBe('bar')
    expect(url.searchParams.get('error')).toBe('login_required')
    expect(url.searchParams.get('state')).toBe('newstate')
  })

  it('returns a valid URL string', () => {
    const result = buildLoginRequiredUrl('https://app.example.com/', 'xyz')
    expect(() => new URL(result)).not.toThrow()
  })
})

describe('isTrustedReturnTo', () => {
  it('accepts a sibling subdomain of RPID parent domain', () => {
    expect(isTrustedReturnTo('https://events.rallypt.dev/sso/callback', 'id.rallypt.dev')).toBe(true)
    expect(isTrustedReturnTo('https://money.rallypt.app/x', 'id.rallypt.app')).toBe(true)
  })

  it('accepts the exact same host', () => {
    expect(isTrustedReturnTo('https://id.rallypt.dev/x', 'id.rallypt.dev')).toBe(true)
  })

  it('accepts localhost in dev (same single-label host)', () => {
    expect(isTrustedReturnTo('http://localhost:5174/sso/callback', 'localhost')).toBe(true)
  })

  it('rejects a cross-site attacker origin (open-redirect guard)', () => {
    expect(isTrustedReturnTo('https://attacker.com/callback', 'id.rallypt.dev')).toBe(false)
    // suffix trick: not actually under .rallypt.dev
    expect(isTrustedReturnTo('https://evil-rallypt.dev/x', 'id.rallypt.dev')).toBe(false)
  })

  it('rejects a different registrable domain on localhost dev', () => {
    expect(isTrustedReturnTo('https://attacker.com/x', 'localhost')).toBe(false)
  })

  it('rejects a malformed return_to', () => {
    expect(isTrustedReturnTo('not a url', 'id.rallypt.dev')).toBe(false)
  })
})

describe('clearStaleSsoHint', () => {
  beforeEach(() => {
    // Reset any rp_sso cookie between cases.
    document.cookie = 'rp_sso=; Path=/; Max-Age=0; SameSite=Lax'
  })

  it('writes an expiring rp_sso cookie without throwing', () => {
    expect(() => clearStaleSsoHint('localhost', false)).not.toThrow()
  })

  it('never throws even when document.cookie access fails', () => {
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      set() {
        throw new Error('cookie write blocked')
      },
    })
    expect(() => clearStaleSsoHint('id.rallypt.dev', true)).not.toThrow()
    if (original) Object.defineProperty(document, 'cookie', original)
  })
})
