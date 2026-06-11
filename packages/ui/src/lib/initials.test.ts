import { describe, it, expect } from 'vitest'
import { initials, avatarBackground, AVATAR_BG_PALETTE } from './initials.js'

describe('initials', () => {
  it('prefers first + last initial', () => {
    expect(initials({ firstName: 'Jane', lastName: 'Doe' })).toBe('JD')
    expect(initials({ firstName: 'jane', lastName: 'doe' })).toBe('JD')
  })

  it('uses first two letters when only one name part is present', () => {
    expect(initials({ firstName: 'Jane' })).toBe('JA')
    expect(initials({ lastName: 'Doe' })).toBe('DO')
  })

  it('falls back to the display name', () => {
    expect(initials({ name: 'Jane Doe' })).toBe('JD')
    expect(initials({ name: 'Cher' })).toBe('CH')
    expect(initials({ name: '  Madonna  ' })).toBe('MA')
  })

  it('takes word initials from a multi-word display name', () => {
    expect(initials({ name: 'Mary Jane Watson' })).toBe('MJ')
  })

  it('falls back to the email local-part', () => {
    expect(initials({ email: 'jane@example.com' })).toBe('JA')
    expect(initials({ email: 'x@example.com' })).toBe('X')
  })

  it('honours the priority order', () => {
    expect(
      initials({ firstName: 'Jane', lastName: 'Doe', name: 'Zed Zed', email: 'q@q.com' }),
    ).toBe('JD')
    expect(initials({ name: 'Zed Zed', email: 'q@q.com' })).toBe('ZZ')
  })

  it('ignores blank / whitespace-only fields', () => {
    expect(initials({ firstName: '   ', lastName: '   ', name: 'Jane Doe' })).toBe('JD')
  })

  it('strips punctuation when taking letters from a token', () => {
    expect(initials({ name: '@jane' })).toBe('JA')
    expect(initials({ name: '@jane #doe' })).toBe('JD')
    expect(initials({ email: '.hidden@example.com' })).toBe('HI')
  })

  it('returns "?" for an all-punctuation multi-word name', () => {
    expect(initials({ name: '@@@ ###' })).toBe('?')
  })

  it('handles unicode letters', () => {
    expect(initials({ firstName: 'Élodie', lastName: 'Ñoño' })).toBe('ÉÑ')
  })

  it('returns "?" when nothing is usable', () => {
    expect(initials({})).toBe('?')
    expect(initials({ name: '   ' })).toBe('?')
    expect(initials({ email: '@@@' })).toBe('?')
  })
})

describe('avatarBackground', () => {
  it('is deterministic for the same seed', () => {
    expect(avatarBackground('Jane Doe')).toBe(avatarBackground('Jane Doe'))
  })

  it('always returns a palette colour', () => {
    const palette = new Set<string>(AVATAR_BG_PALETTE)
    for (const seed of ['', 'a', 'Jane Doe', 'q@q.com', 'a much longer seed string']) {
      expect(palette.has(avatarBackground(seed))).toBe(true)
    }
  })
})
