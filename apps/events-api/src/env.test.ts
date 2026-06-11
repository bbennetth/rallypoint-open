import { describe, it, expect } from 'vitest'
import { parseEnv } from './env.js'

describe('parseEnv', () => {
  it('returns sensible defaults when given an empty source', () => {
    const env = parseEnv({})
    expect(env.NODE_ENV).toBe('development')
    expect(env.PORT).toBe(8081)
    expect(env.LOG_LEVEL).toBe('info')
    expect(env.EVENTS_UI_ORIGIN).toBe('http://localhost:5174')
    expect(env.BUILD_VERSION).toBe('dev')
  })

  it('coerces PORT from a string', () => {
    const env = parseEnv({ PORT: '8090' })
    expect(env.PORT).toBe(8090)
  })

  it('rejects an invalid NODE_ENV value with a helpful message', () => {
    expect(() => parseEnv({ NODE_ENV: 'staging' })).toThrowError(
      /NODE_ENV/,
    )
  })

  it('rejects a PORT outside the valid range', () => {
    expect(() => parseEnv({ PORT: '99999' })).toThrowError(/PORT/)
  })

  it('rejects a non-URL EVENTS_UI_ORIGIN', () => {
    expect(() => parseEnv({ EVENTS_UI_ORIGIN: 'not-a-url' })).toThrowError(
      /EVENTS_UI_ORIGIN/,
    )
  })

  it('rejects a non-URL RPID_API_URL', () => {
    expect(() => parseEnv({ RPID_API_URL: 'not a url at all' })).toThrowError(
      /RPID_API_URL/,
    )
  })

  // --- secrets: dev defaults vs. production-required -----------------

  it('supplies dev defaults for the required secrets outside production', () => {
    const env = parseEnv({})
    expect(env.EVENTS_API_KEY.length).toBeGreaterThanOrEqual(32)
    expect(env.EVENTS_SESSION_KEY_V1.length).toBeGreaterThanOrEqual(32)
    expect(env.EVENTS_SESSION_KEY_VERSION).toBe(1)
    expect(env.REALTIME_TOKEN_HMAC_KEY.length).toBeGreaterThanOrEqual(32)
  })

  it('requires EVENTS_API_KEY, EVENTS_SESSION_KEY_V1, and REALTIME_TOKEN_HMAC_KEY in production', () => {
    expect(() => parseEnv({ NODE_ENV: 'production' })).toThrowError(
      /required in production/,
    )
  })

  it('accepts explicit secrets in production', () => {
    const env = parseEnv({
      NODE_ENV: 'production',
      EVENTS_API_KEY: 'k'.repeat(32),
      EVENTS_SESSION_KEY_V1: 's'.repeat(32),
      REALTIME_TOKEN_HMAC_KEY: 'r'.repeat(32),
    })
    expect(env.EVENTS_API_KEY).toBe('k'.repeat(32))
    expect(env.EVENTS_SESSION_KEY_V1).toBe('s'.repeat(32))
    expect(env.REALTIME_TOKEN_HMAC_KEY).toBe('r'.repeat(32))
  })

  it('rejects a too-short EVENTS_API_KEY with a clear message (#268)', () => {
    expect(() => parseEnv({ EVENTS_API_KEY: 'short' })).toThrowError(
      /EVENTS_API_KEY must be at least 32 characters/,
    )
  })

  it('rejects a too-short PLANNER_API_KEY with a clear message (#268)', () => {
    expect(() => parseEnv({ PLANNER_API_KEY: 'short' })).toThrowError(
      /PLANNER_API_KEY must be at least 32 characters/,
    )
  })

  // --- cookie-name derivation (footgun #20) --------------------------

  it('derives bare cookie names in development (no __Host- prefix)', () => {
    const env = parseEnv({ NODE_ENV: 'development' })
    expect(env.EVENTS_SESSION_COOKIE_NAME).toBe('rpe_session')
    expect(env.EVENTS_CSRF_COOKIE_NAME).toBe('rpe_csrf')
    expect(env.EVENTS_SSO_STATE_COOKIE_NAME).toBe('rpe_sso_state')
  })

  it('derives __Host- cookie names in production', () => {
    const env = parseEnv({
      NODE_ENV: 'production',
      EVENTS_API_KEY: 'k'.repeat(32),
      EVENTS_SESSION_KEY_V1: 's'.repeat(32),
      REALTIME_TOKEN_HMAC_KEY: 'r'.repeat(32),
    })
    expect(env.EVENTS_SESSION_COOKIE_NAME).toBe('__Host-rpe_session')
    expect(env.EVENTS_CSRF_COOKIE_NAME).toBe('__Host-rpe_csrf')
    expect(env.EVENTS_SSO_STATE_COOKIE_NAME).toBe('__Host-rpe_sso_state')
  })

  it('honours explicit cookie-name overrides', () => {
    const env = parseEnv({ EVENTS_SESSION_COOKIE_NAME: 'custom_sess' })
    expect(env.EVENTS_SESSION_COOKIE_NAME).toBe('custom_sess')
  })
})
