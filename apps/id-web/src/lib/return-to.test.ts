import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { safeReturnTo } from './return-to.js'

const ORIGIN = 'https://id.rallypt.app'

describe('safeReturnTo', () => {
  beforeEach(() => {
    // Stub window.location for the SSR-ish unit test environment.
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { location: { origin: ORIGIN } },
    })
  })
  afterEach(() => {
    // @ts-expect-error reset between tests
    delete globalThis.window
  })

  it('returns the fallback for null / empty input', () => {
    expect(safeReturnTo(null)).toBe('/')
    expect(safeReturnTo('')).toBe('/')
    expect(safeReturnTo(undefined)).toBe('/')
    expect(safeReturnTo('   ')).toBe('/')
  })

  it('accepts root-relative paths', () => {
    expect(safeReturnTo('/dashboard')).toBe('/dashboard')
    expect(safeReturnTo('/some/nested?with=query')).toBe('/some/nested?with=query')
  })

  it('rejects protocol-relative URLs (//evil.example)', () => {
    expect(safeReturnTo('//evil.example/path', '/safe')).toBe('/safe')
  })

  it('rejects javascript: URLs', () => {
    expect(safeReturnTo('javascript:alert(1)', '/safe')).toBe('/safe')
  })

  it('rejects data: URLs', () => {
    expect(safeReturnTo('data:text/html,<script>alert(1)</script>', '/safe')).toBe('/safe')
  })

  it('accepts an absolute URL that matches window.origin', () => {
    expect(safeReturnTo(`${ORIGIN}/dashboard`)).toBe(`${ORIGIN}/dashboard`)
  })

  it('rejects an absolute URL to a different origin', () => {
    expect(safeReturnTo('https://evil.example/dashboard', '/safe')).toBe('/safe')
  })

  it('rejects malformed URLs', () => {
    expect(safeReturnTo('http://[malformed', '/safe')).toBe('/safe')
  })
})
