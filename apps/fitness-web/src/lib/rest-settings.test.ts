// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { DEFAULT_REST_S, sanitizeDefaultRestS } from './rest-settings.js'

describe('sanitizeDefaultRestS', () => {
  it('passes whole in-range values through', () => {
    expect(sanitizeDefaultRestS(120)).toBe(120)
    expect(sanitizeDefaultRestS('45')).toBe(45)
  })
  it('keeps 0 (no auto rest) instead of falling back', () => {
    expect(sanitizeDefaultRestS(0)).toBe(0)
  })
  it('clamps to the 600 s schema ceiling and rounds fractions', () => {
    expect(sanitizeDefaultRestS(9999)).toBe(600)
    expect(sanitizeDefaultRestS(90.6)).toBe(91)
  })
  it('falls back to the 90 s default on garbage/negatives', () => {
    expect(sanitizeDefaultRestS(undefined)).toBe(DEFAULT_REST_S)
    expect(sanitizeDefaultRestS('abc')).toBe(DEFAULT_REST_S)
    expect(sanitizeDefaultRestS(-5)).toBe(DEFAULT_REST_S)
    expect(sanitizeDefaultRestS(Number.NaN)).toBe(DEFAULT_REST_S)
  })
})
