import { describe, expect, it } from 'vitest'
import type { EventFeatures } from '../lib/api.js'
import { buildNav } from './AttendeeChrome.js'
import { tabsFor } from './SoloAttendeeChrome.js'

// The two attendee shells must offer the same tabs — a group member and a
// solo attendee are looking at the same festival, just with different
// company. These guard that shape, and that the merged-away "My Day" tab
// doesn't creep back in.

const ALL_FEATURES: EventFeatures = {
  lineup: true,
  sessions: true,
  groups: true,
  attendees: true,
}

describe('group attendee nav', () => {
  it('offers Now / Lineup / Map / Group / Rallies', () => {
    expect(buildNav('g-1').map((t) => t.label)).toEqual([
      'Now',
      'Lineup',
      'Map',
      'Group',
      'Rallies',
    ])
  })

  it('has no My Day tab and no /day destination', () => {
    const nav = buildNav('g-1')
    expect(nav.some((t) => t.label === 'My Day')).toBe(false)
    expect(nav.some((t) => t.to.endsWith('/day'))).toBe(false)
  })

  it('scopes every destination to the group', () => {
    const nav = buildNav('g 1/2')
    expect(nav.every((t) => t.to.startsWith('/groups/g%201%2F2'))).toBe(true)
  })
})

describe('solo attendee nav', () => {
  it('matches the group shell tab-for-tab when every feature is on', () => {
    expect(tabsFor('fest', ALL_FEATURES).map((t) => t.label)).toEqual(
      buildNav('g-1').map((t) => t.label),
    )
  })

  it('has no My Day tab and no /day destination', () => {
    const tabs = tabsFor('fest', ALL_FEATURES)
    expect(tabs.some((t) => t.label === 'My Day')).toBe(false)
    expect(tabs.some((t) => t.to.endsWith('/day'))).toBe(false)
  })

  it('still drops feature-gated tabs the owner turned off', () => {
    const tabs = tabsFor('fest', { ...ALL_FEATURES, lineup: false, groups: false })
    expect(tabs.map((t) => t.label)).toEqual(['Now', 'Map', 'Rallies'])
  })

  it('shows the gated tabs while features are still loading', () => {
    expect(tabsFor('fest', undefined).map((t) => t.label)).toEqual([
      'Now',
      'Lineup',
      'Map',
      'Group',
      'Rallies',
    ])
  })

  it('scopes every destination to the event slug', () => {
    expect(
      tabsFor('my fest', ALL_FEATURES).every((t) => t.to.startsWith('/events/my%20fest/attending')),
    ).toBe(true)
  })
})
