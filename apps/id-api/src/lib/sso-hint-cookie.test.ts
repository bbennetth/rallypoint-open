import { describe, it, expect } from 'vitest'
import {
  SSO_HINT_COOKIE_NAME,
  buildSsoHintCookie,
  buildSsoHintClearCookie,
} from './sso-hint-cookie.js'

describe('buildSsoHintCookie', () => {
  it('sets name=1 with Path, Max-Age, and SameSite=Lax', () => {
    const cookie = buildSsoHintCookie({ maxAgeSeconds: 2592000, domain: undefined, secure: false })
    expect(cookie).toBe('rp_sso=1; Path=/; Max-Age=2592000; SameSite=Lax')
  })

  it('includes Domain attribute when domain is provided', () => {
    const cookie = buildSsoHintCookie({ maxAgeSeconds: 2592000, domain: '.rallypt.app', secure: false })
    expect(cookie).toContain('; Domain=.rallypt.app')
  })

  it('omits Domain attribute when domain is undefined', () => {
    const cookie = buildSsoHintCookie({ maxAgeSeconds: 2592000, domain: undefined, secure: false })
    expect(cookie).not.toContain('Domain')
  })

  it('omits Domain attribute when domain is empty string', () => {
    const cookie = buildSsoHintCookie({ maxAgeSeconds: 2592000, domain: '', secure: false })
    expect(cookie).not.toContain('Domain')
  })

  it('includes Secure attribute when secure is true', () => {
    const cookie = buildSsoHintCookie({ maxAgeSeconds: 2592000, domain: undefined, secure: true })
    expect(cookie).toContain('; Secure')
  })

  it('omits Secure attribute when secure is false', () => {
    const cookie = buildSsoHintCookie({ maxAgeSeconds: 2592000, domain: undefined, secure: false })
    expect(cookie).not.toContain('Secure')
  })

  it('includes both Domain and Secure in prod-like config', () => {
    const cookie = buildSsoHintCookie({ maxAgeSeconds: 2592000, domain: '.rallypt.app', secure: true })
    expect(cookie).toBe('rp_sso=1; Path=/; Max-Age=2592000; SameSite=Lax; Domain=.rallypt.app; Secure')
  })

  it('always includes Max-Age with the given number', () => {
    const cookie = buildSsoHintCookie({ maxAgeSeconds: 86400, domain: undefined, secure: false })
    expect(cookie).toContain('Max-Age=86400')
  })

  it('never includes HttpOnly', () => {
    const withDomainSecure = buildSsoHintCookie({ maxAgeSeconds: 2592000, domain: '.rallypt.app', secure: true })
    expect(withDomainSecure).not.toContain('HttpOnly')
    const bare = buildSsoHintCookie({ maxAgeSeconds: 2592000, domain: undefined, secure: false })
    expect(bare).not.toContain('HttpOnly')
  })

  it('uses the canonical cookie name constant', () => {
    const cookie = buildSsoHintCookie({ maxAgeSeconds: 100, domain: undefined, secure: false })
    expect(cookie.startsWith(`${SSO_HINT_COOKIE_NAME}=1`)).toBe(true)
  })
})

describe('buildSsoHintClearCookie', () => {
  it('sets value to empty string with Max-Age=0', () => {
    const cookie = buildSsoHintClearCookie({ domain: undefined, secure: false })
    expect(cookie).toBe('rp_sso=; Path=/; Max-Age=0; SameSite=Lax')
  })

  it('includes Domain attribute when domain is provided', () => {
    const cookie = buildSsoHintClearCookie({ domain: '.rallypt.app', secure: false })
    expect(cookie).toContain('; Domain=.rallypt.app')
  })

  it('omits Domain attribute when domain is undefined', () => {
    const cookie = buildSsoHintClearCookie({ domain: undefined, secure: false })
    expect(cookie).not.toContain('Domain')
  })

  it('includes Secure when secure is true', () => {
    const cookie = buildSsoHintClearCookie({ domain: undefined, secure: true })
    expect(cookie).toContain('; Secure')
  })

  it('omits Secure when secure is false', () => {
    const cookie = buildSsoHintClearCookie({ domain: undefined, secure: false })
    expect(cookie).not.toContain('Secure')
  })

  it('includes both Domain and Secure in prod-like config', () => {
    const cookie = buildSsoHintClearCookie({ domain: '.rallypt.app', secure: true })
    expect(cookie).toBe('rp_sso=; Path=/; Max-Age=0; SameSite=Lax; Domain=.rallypt.app; Secure')
  })

  it('never includes HttpOnly', () => {
    const cookie = buildSsoHintClearCookie({ domain: '.rallypt.app', secure: true })
    expect(cookie).not.toContain('HttpOnly')
  })
})
