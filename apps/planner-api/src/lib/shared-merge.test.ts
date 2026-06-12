import { describe, expect, it } from 'vitest'
import type { UserEventDto } from '@rallypoint/events-client'
import { mergeSharedGroupEvents, sharedEventIdSet } from './shared-merge.js'

// --- group event helpers ---------------------------------------------------

function groupEvent(eventId: string): UserEventDto {
  return {
    eventId,
    slug: eventId,
    name: eventId,
    scopeType: 'group',
    owned: false,
    startDate: '2026-06-10',
    endDate: '2026-06-10',
    days: [{ date: '2026-06-10', dayLabel: 'Day 1', startTime: null, endTime: null }],
  }
}

describe('mergeSharedGroupEvents', () => {
  it('concatenates reachable then flagged', () => {
    const merged = mergeSharedGroupEvents([groupEvent('e1')], [groupEvent('e2')])
    expect(merged.map((e) => e.eventId)).toEqual(['e1', 'e2'])
  })
  it('de-dups by eventId (reachable wins)', () => {
    const reachable = [{ ...groupEvent('e1'), owned: true }]
    const flagged = [groupEvent('e1'), groupEvent('e2')]
    const merged = mergeSharedGroupEvents(reachable, flagged)
    expect(merged.map((e) => e.eventId)).toEqual(['e1', 'e2'])
    // surviving e1 keeps owned:true from the reachable set
    expect(merged.find((e) => e.eventId === 'e1')?.owned).toBe(true)
  })
  it('handles empty inputs', () => {
    expect(mergeSharedGroupEvents([], [])).toEqual([])
    expect(mergeSharedGroupEvents([groupEvent('e1')], [])).toHaveLength(1)
    expect(mergeSharedGroupEvents([], [groupEvent('e2')])).toHaveLength(1)
  })
})

describe('sharedEventIdSet', () => {
  it('marks flagged events not already reachable as shared', () => {
    const set = sharedEventIdSet(['e1', 'e2'], ['e3'])
    expect([...set].sort()).toEqual(['e1', 'e2'])
  })
  it('excludes flagged events already in the reachable set', () => {
    const set = sharedEventIdSet(['e1', 'e2'], ['e1', 'e3'])
    expect([...set]).toEqual(['e2'])
  })
  it('empty when nothing flagged', () => {
    expect(sharedEventIdSet([], ['e1']).size).toBe(0)
  })
})
