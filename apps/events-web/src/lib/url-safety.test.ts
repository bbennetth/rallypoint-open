import { describe, it, expect } from 'vitest'
import { isSafeHttpUrl } from './url-safety.js'

describe('isSafeHttpUrl', () => {
  it('accepts https URLs', () => {
    expect(isSafeHttpUrl('https://example.com/rsvp')).toBe(true)
  })

  it('accepts http URLs', () => {
    expect(isSafeHttpUrl('http://example.com/rsvp')).toBe(true)
  })

  it('rejects javascript: scheme', () => {
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false)
  })

  it('rejects data: scheme', () => {
    expect(isSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
  })

  it('rejects vbscript: scheme', () => {
    expect(isSafeHttpUrl('vbscript:msgbox(1)')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isSafeHttpUrl('')).toBe(false)
  })

  it('rejects relative paths', () => {
    expect(isSafeHttpUrl('/relative/path')).toBe(false)
  })

  it('rejects bare text that is not a URL', () => {
    expect(isSafeHttpUrl('not-a-url')).toBe(false)
  })
})
