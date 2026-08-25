import { describe, expect, it } from 'vitest'
import {
  API_CACHE_PREFIX,
  cacheNameFor,
  deriveCacheKey,
  extractSessionCookie,
  isApiCacheName,
} from './sw-cookie-key.js'

// E4 O5 — unit tests for the per-user SW cache-key derivation. These run
// in jsdom (not a real SW), so they exercise the pure helpers directly.

describe('extractSessionCookie', () => {
  it('returns null when the cookie header is missing or empty', () => {
    expect(extractSessionCookie(null)).toBeNull()
    expect(extractSessionCookie('')).toBeNull()
  })

  it('returns null when no candidate cookie is present', () => {
    expect(extractSessionCookie('other_cookie=foo; csrf=bar')).toBeNull()
  })

  it('picks up the production cookie name (__Host- prefix)', () => {
    expect(extractSessionCookie('__Host-rpp_session=abc123')).toBe('abc123')
  })

  it('picks up the dev cookie name (no prefix)', () => {
    expect(extractSessionCookie('rpp_session=devvalue')).toBe('devvalue')
  })

  it('finds the cookie among siblings', () => {
    expect(
      extractSessionCookie('other=x; __Host-rpp_session=session_v; csrf=y'),
    ).toBe('session_v')
  })

  it('preserves the cookie value verbatim (no decoding)', () => {
    // Cookie values can contain url-encoded chars — we hash the raw bytes,
    // so we must NOT decode them here.
    expect(extractSessionCookie('rpp_session=rpp_sess_AbC.123%2F')).toBe(
      'rpp_sess_AbC.123%2F',
    )
  })

  it('prefers the __Host- variant when both happen to be present', () => {
    // Cookie-header-order independent: candidate priority comes from the
    // SESSION_COOKIE_CANDIDATES array (__Host- first), not the header.
    expect(
      extractSessionCookie('rpp_session=dev_value; __Host-rpp_session=prod_value'),
    ).toBe('prod_value')
    // Verified again with __Host- first in the header.
    expect(
      extractSessionCookie('__Host-rpp_session=prod_value; rpp_session=dev_value'),
    ).toBe('prod_value')
  })
})

describe('deriveCacheKey', () => {
  it('produces a stable 16-char hex digest for the same input', async () => {
    const a = await deriveCacheKey('rpp_sess_test_token_value')
    const b = await deriveCacheKey('rpp_sess_test_token_value')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  it('produces different digests for different inputs', async () => {
    const a = await deriveCacheKey('rpp_sess_token_alice')
    const b = await deriveCacheKey('rpp_sess_token_bob')
    expect(a).not.toBe(b)
  })

  it('uses SHA-256 — known vector for empty-string input', async () => {
    // SHA-256("") first-16-hex: e3b0c44298fc1c14
    const empty = await deriveCacheKey('')
    expect(empty).toBe('e3b0c44298fc1c14')
  })
})

describe('cacheNameFor + isApiCacheName', () => {
  it('builds a cache name from the prefix and the user key', () => {
    expect(cacheNameFor('abc123def4567890')).toBe(
      `${API_CACHE_PREFIX}abc123def4567890`,
    )
  })

  it('isApiCacheName recognises only its own caches', () => {
    expect(isApiCacheName(cacheNameFor('xx'))).toBe(true)
    expect(isApiCacheName('image-cache')).toBe(false)
    expect(isApiCacheName('workbox-precache-v2')).toBe(false)
    expect(isApiCacheName('')).toBe(false)
  })
})
