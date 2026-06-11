import { describe, it, expect } from 'vitest'
import { composeInstant, setRange } from './schedule-logic.js'

describe('composeInstant', () => {
  it('composes a date + HH:MM into a UTC instant', () => {
    expect(composeInstant('2026-06-01', '18:30')).toBe(Date.UTC(2026, 5, 1, 18, 30, 0))
  })
  it('accepts HH:MM:SS', () => {
    expect(composeInstant('2026-06-01', '18:30:45')).toBe(Date.UTC(2026, 5, 1, 18, 30, 45))
  })
  it('returns null for an absent time', () => {
    expect(composeInstant('2026-06-01', null)).toBeNull()
    expect(composeInstant('2026-06-01', undefined)).toBeNull()
    expect(composeInstant('2026-06-01', '')).toBeNull()
  })
  it('returns null for a malformed date', () => {
    expect(composeInstant('2026/06/01', '18:30')).toBeNull()
    expect(composeInstant('not-a-date', '18:30')).toBeNull()
  })
  it('returns null for a malformed time', () => {
    expect(composeInstant('2026-06-01', '6:30')).toBeNull()
    expect(composeInstant('2026-06-01', '18h30')).toBeNull()
  })
  it('returns null for out-of-range components', () => {
    expect(composeInstant('2026-13-01', '18:30')).toBeNull()
    expect(composeInstant('2026-06-01', '24:00')).toBeNull()
    expect(composeInstant('2026-06-01', '18:60')).toBeNull()
    expect(composeInstant('2026-06-01', '18:30:60')).toBeNull()
  })
  it('returns null for impossible calendar dates that Date.UTC would roll over', () => {
    expect(composeInstant('2026-02-31', '18:30')).toBeNull()
    expect(composeInstant('2026-04-31', '18:30')).toBeNull()
    expect(composeInstant('2025-02-29', '18:30')).toBeNull()
    expect(composeInstant('2024-02-29', '18:30')).toBe(Date.UTC(2024, 1, 29, 18, 30, 0))
  })
})

describe('setRange', () => {
  it('builds a same-day range', () => {
    expect(setRange('2026-06-01', '20:00', '22:00')).toEqual({
      start: Date.UTC(2026, 5, 1, 20, 0, 0),
      end: Date.UTC(2026, 5, 1, 22, 0, 0),
    })
  })
  it('rolls a midnight-crossing end to the next day', () => {
    const r = setRange('2026-06-01', '23:00', '01:00')
    expect(r).not.toBeNull()
    expect(r!.start).toBe(Date.UTC(2026, 5, 1, 23, 0, 0))
    expect(r!.end).toBe(Date.UTC(2026, 5, 2, 1, 0, 0))
    expect(r!.end).toBeGreaterThan(r!.start)
  })
  it('treats an end equal to the start as a full-day wrap', () => {
    const r = setRange('2026-06-01', '20:00', '20:00')
    expect(r!.end - r!.start).toBe(24 * 60 * 60 * 1000)
  })
  it('returns null when either bound is missing', () => {
    expect(setRange('2026-06-01', '20:00', null)).toBeNull()
    expect(setRange('2026-06-01', null, '22:00')).toBeNull()
    expect(setRange('2026-06-01', null, null)).toBeNull()
  })
})
