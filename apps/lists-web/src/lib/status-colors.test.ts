import { describe, it, expect } from 'vitest'
import { STATUS_COLOR_KEYS, statusColorStyle, statusHue } from './status-colors.js'

describe('statusHue', () => {
  it('resolves a known palette key to its hex', () => {
    expect(statusHue('green')).toBe('#22c55e')
    expect(statusHue('amber')).toBe('#f59e0b')
    expect(statusHue('slate')).toBe('#64748b')
  })

  it('returns null for an unknown, empty, or null key', () => {
    expect(statusHue('chartreuse')).toBeNull()
    expect(statusHue('')).toBeNull()
    expect(statusHue(null)).toBeNull()
    expect(statusHue(undefined)).toBeNull()
  })
})

describe('statusColorStyle', () => {
  it('uses the hue as border + text and a faint tint as background for a known key', () => {
    const style = statusColorStyle('sky')
    expect(style.borderColor).toBe('#0ea5e9')
    expect(style.color).toBe('#0ea5e9')
    expect(style.background).toContain('#0ea5e9')
  })

  it('falls back to neutral theme tokens for an unknown or null key', () => {
    const neutral = { borderColor: 'var(--line)', color: 'var(--ink-dim)', background: 'var(--surface-2)' }
    expect(statusColorStyle('nope')).toEqual(neutral)
    expect(statusColorStyle(null)).toEqual(neutral)
  })
})

describe('STATUS_COLOR_KEYS', () => {
  it('includes the three seeded default colors', () => {
    for (const seed of ['slate', 'amber', 'green']) {
      expect(STATUS_COLOR_KEYS).toContain(seed)
    }
  })
})
