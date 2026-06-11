import { describe, it, expect } from 'vitest'
import { parseEnv } from './env.js'

describe('parseEnv', () => {
  it('accepts an empty env and returns defaults', () => {
    const env = parseEnv({})
    expect(env.NODE_ENV).toBe('development')
    expect(env.PORT).toBe(8080)
    expect(env.MAILER).toBe('log')
    expect(env.CAPTCHA).toBe('turnstile')
    expect(env.BREACHED_PASSWORD_CHECK).toBe('hibp')
  })

  it('coerces PORT from string', () => {
    const env = parseEnv({ PORT: '3000' })
    expect(env.PORT).toBe(3000)
  })

  it('rejects an out-of-range port', () => {
    expect(() => parseEnv({ PORT: '99999' })).toThrow(/PORT/)
  })

  it('rejects a too-short ARGON2_PEPPER (when explicitly set)', () => {
    expect(() => parseEnv({ ARGON2_PEPPER: 'short' })).toThrow(/ARGON2_PEPPER/)
  })

  it('rejects a too-short ADMIN_TOKEN but allows absent or 32+ (#46)', () => {
    expect(() => parseEnv({ ADMIN_TOKEN: 'short' })).toThrow(/ADMIN_TOKEN/)
    expect(parseEnv({}).ADMIN_TOKEN).toBeUndefined()
    const strong = 'a'.repeat(32)
    expect(parseEnv({ ADMIN_TOKEN: strong }).ADMIN_TOKEN).toBe(strong)
  })

  it('rejects unknown MAILER values', () => {
    expect(() => parseEnv({ MAILER: 'sendgrid' })).toThrow(/MAILER/)
  })

  it('honors LOG_LEVEL', () => {
    const env = parseEnv({ LOG_LEVEL: 'debug' })
    expect(env.LOG_LEVEL).toBe('debug')
  })

  it('parses URL fields and rejects non-URLs', () => {
    expect(parseEnv({ UI_ORIGIN: 'https://id.example.com' }).UI_ORIGIN).toBe(
      'https://id.example.com',
    )
    expect(() => parseEnv({ UI_ORIGIN: 'not-a-url' })).toThrow(/UI_ORIGIN/)
  })

  it('parses NODE_ENV and rejects unknown values', () => {
    expect(parseEnv({ NODE_ENV: 'production' }).NODE_ENV).toBe('production')
    expect(() => parseEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/)
  })

  describe('SESSION_COOKIE_NAME defaults (#20)', () => {
    it('defaults to __Host-rp_session in production', () => {
      expect(parseEnv({ NODE_ENV: 'production' }).SESSION_COOKIE_NAME).toBe(
        '__Host-rp_session',
      )
    })

    it('defaults to rp_session in development (Firefox/Safari drop __Host- on http://localhost)', () => {
      expect(parseEnv({ NODE_ENV: 'development' }).SESSION_COOKIE_NAME).toBe(
        'rp_session',
      )
    })

    it('defaults to rp_session in test', () => {
      expect(parseEnv({ NODE_ENV: 'test' }).SESSION_COOKIE_NAME).toBe('rp_session')
    })

    it('honors an explicit SESSION_COOKIE_NAME override regardless of NODE_ENV', () => {
      expect(
        parseEnv({ NODE_ENV: 'development', SESSION_COOKIE_NAME: '__Host-custom' })
          .SESSION_COOKIE_NAME,
      ).toBe('__Host-custom')
      expect(
        parseEnv({ NODE_ENV: 'production', SESSION_COOKIE_NAME: 'plain_name' })
          .SESSION_COOKIE_NAME,
      ).toBe('plain_name')
    })
  })
})
