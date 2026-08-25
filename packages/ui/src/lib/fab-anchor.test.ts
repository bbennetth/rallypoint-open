import { describe, it, expect } from 'vitest'
import { pickFabAnchor, type FabAnchor } from './fab-anchor.js'

describe('pickFabAnchor(routeKey)', () => {
  it.each<[string, FabAnchor]>([
    // Planner — section-switching pages
    ['myday', 'subbar'],
    ['tasks', 'subbar'],
    ['shopping', 'subbar'],
    ['notes', 'subbar'],
    // Planner — single-section pages
    ['diary', 'float'],
    ['settings', 'float'],
    // Events Attendee — section-switching pages
    ['social', 'subbar'],
    ['group', 'subbar'],
    // Events Attendee — single-section pages
    ['now', 'float'],
    ['lineup', 'float'],
    ['rallies', 'float'],
    ['rsvp', 'float'],
  ])('%s → %s', (routeKey, expected) => {
    expect(pickFabAnchor(routeKey)).toBe(expected)
  })

  it('defaults to "float" for unknown routes', () => {
    expect(pickFabAnchor('completely-unknown')).toBe('float')
  })

  it('defaults to "float" for null/undefined', () => {
    expect(pickFabAnchor(null)).toBe('float')
    expect(pickFabAnchor(undefined)).toBe('float')
    expect(pickFabAnchor('')).toBe('float')
  })
})
