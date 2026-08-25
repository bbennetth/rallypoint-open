// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { safeDest, describeExchangeError } from './SsoCallbackPage.js'
import { ApiError } from './csrf.js'

// Pure-logic tests for the shared SSO callback page (R2). The component render +
// the exchange flow are verified in-browser (converged show-error behavior on
// lists/events/fitness-web); these lock the two security-relevant helpers.

const FALLBACK = '/me/home'
const ORIGIN = window.location.origin

describe('safeDest (open-redirect guard)', () => {
  it('returns the fallback when dest is absent', () => {
    expect(safeDest(null, FALLBACK)).toBe(FALLBACK)
  })

  it('keeps a same-origin relative path (with query + hash)', () => {
    expect(safeDest('/me/lists?tab=1#top', FALLBACK)).toBe('/me/lists?tab=1#top')
  })

  it('keeps a same-origin absolute URL but strips the origin', () => {
    expect(safeDest(`${ORIGIN}/me/x?q=1#h`, FALLBACK)).toBe('/me/x?q=1#h')
  })

  it('rejects a cross-origin destination (open redirect)', () => {
    expect(safeDest('https://evil.example/phish', FALLBACK)).toBe(FALLBACK)
  })

  it('rejects a javascript: URL (origin is not same-origin)', () => {
    expect(safeDest('javascript:alert(1)', FALLBACK)).toBe(FALLBACK)
  })

  it('falls back on an unparseable URL', () => {
    expect(safeDest('http://[', FALLBACK)).toBe(FALLBACK)
  })
})

describe('describeExchangeError', () => {
  it('surfaces the ApiError code + message', () => {
    const err = new ApiError('sso_state_mismatch', 'SSO state did not match.', 400)
    expect(describeExchangeError(err)).toEqual({
      code: 'sso_state_mismatch',
      message: 'SSO state did not match.',
    })
  })

  it('maps a plain Error to unexpected_error, keeping its message', () => {
    expect(describeExchangeError(new Error('boom'))).toEqual({
      code: 'unexpected_error',
      message: 'boom',
    })
  })

  it('maps a non-Error rejection to a generic message', () => {
    expect(describeExchangeError('weird')).toEqual({
      code: 'unexpected_error',
      message: 'Unknown error.',
    })
  })
})
