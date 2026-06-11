import { describe, expect, it } from 'vitest'
import { buildSetCookie, buildClearCookie } from './cookies.js'

describe('cookies / buildSetCookie', () => {
  it('omits Secure when secure:false', () => {
    const out = buildSetCookie('s', 'v', { maxAge: 600, httpOnly: true, secure: false })
    expect(out).not.toContain('Secure')
    expect(out).toContain('Path=/')
    expect(out).toContain('Max-Age=600')
    expect(out).toContain('SameSite=Lax')
    expect(out).toContain('HttpOnly')
  })

  it('emits Secure when secure:true', () => {
    const out = buildSetCookie('s', 'v', { maxAge: 600, httpOnly: true, secure: true })
    expect(out).toContain('Secure')
  })

  it('CSRF cookie: httpOnly:false, secure:false omits both flags', () => {
    const out = buildSetCookie('csrf', 'tok', { maxAge: 3600, httpOnly: false, secure: false })
    expect(out).not.toContain('HttpOnly')
    expect(out).not.toContain('Secure')
  })

  it('respects custom SameSite', () => {
    const out = buildSetCookie('s', 'v', { maxAge: 0, httpOnly: true, secure: true, sameSite: 'Strict' })
    expect(out).toContain('SameSite=Strict')
  })
})

describe('cookies / buildClearCookie', () => {
  it('emits Max-Age=0 with empty value', () => {
    const out = buildClearCookie('s', true, false)
    expect(out).toContain('Max-Age=0')
    expect(out).toContain('s=')
    expect(out).toContain('HttpOnly')
    expect(out).not.toContain('Secure')
  })

  it('passes secure:true through', () => {
    const out = buildClearCookie('s', true, true)
    expect(out).toContain('Secure')
  })
})
