import { describe, it, expect } from 'vitest'
import { canManageComment, relativeTime } from './comments.js'

describe('canManageComment', () => {
  it('is true only for the author', () => {
    expect(canManageComment('usr_1', 'usr_1')).toBe(true)
    expect(canManageComment('usr_1', 'usr_2')).toBe(false)
  })

  it('is false when the viewer is unknown', () => {
    expect(canManageComment('usr_1', null)).toBe(false)
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-06-11T12:00:00.000Z')

  it('reads "just now" under a minute', () => {
    expect(relativeTime('2026-06-11T11:59:30.000Z', now)).toBe('just now')
  })

  it('reads minutes, hours, then days', () => {
    expect(relativeTime('2026-06-11T11:45:00.000Z', now)).toBe('15m ago')
    expect(relativeTime('2026-06-11T09:00:00.000Z', now)).toBe('3h ago')
    expect(relativeTime('2026-06-09T12:00:00.000Z', now)).toBe('2d ago')
  })

  it('clamps a future timestamp to "just now" and ignores garbage', () => {
    expect(relativeTime('2026-06-11T12:05:00.000Z', now)).toBe('just now')
    expect(relativeTime('not-a-date', now)).toBe('')
  })
})
