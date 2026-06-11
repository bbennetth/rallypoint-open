import { describe, expect, it } from 'vitest'
import type { ListItemDto } from '@rallypoint/lists-client'
import type { UserEventDto } from '@rallypoint/events-client'
import { mergeSharedTaskItems, sharedListIdSet, mergeSharedGroupEvents, sharedEventIdSet } from './shared-merge.js'

function item(id: string, listId: string): ListItemDto {
  return {
    id,
    listId,
    title: id,
    notes: null,
    assignedTo: null,
    completed: false,
    completedAt: null,
    status: 'todo',
    priority: null,
    dueDate: null,
    position: 0,
    customFields: {},
    seriesId: null,
    createdBy: 'user_test',
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
  }
}

describe('mergeSharedTaskItems', () => {
  it('concatenates personal then shared', () => {
    const merged = mergeSharedTaskItems([item('a', 'l1')], [item('b', 'l2')])
    expect(merged.map((i) => i.id)).toEqual(['a', 'b'])
  })
  it('de-dups by item id (personal wins)', () => {
    const personal = [item('a', 'l1')]
    const shared = [item('a', 'lX'), item('b', 'l2')]
    const merged = mergeSharedTaskItems(personal, shared)
    expect(merged.map((i) => i.id)).toEqual(['a', 'b'])
    // the surviving 'a' is the personal one (listId l1, not lX)
    expect(merged.find((i) => i.id === 'a')?.listId).toBe('l1')
  })
  it('handles empty inputs', () => {
    expect(mergeSharedTaskItems([], [])).toEqual([])
    expect(mergeSharedTaskItems([item('a', 'l1')], [])).toHaveLength(1)
    expect(mergeSharedTaskItems([], [item('b', 'l2')])).toHaveLength(1)
  })
})

describe('sharedListIdSet', () => {
  it('marks flagged shared lists as shared', () => {
    const set = sharedListIdSet(['s1', 's2'], ['p1'])
    expect([...set].sort()).toEqual(['s1', 's2'])
  })
  it('excludes any flagged list that is also personal (personal wins)', () => {
    const set = sharedListIdSet(['s1', 'p1'], ['p1', 'p2'])
    expect([...set]).toEqual(['s1'])
  })
  it('empty when nothing flagged', () => {
    expect(sharedListIdSet([], ['p1']).size).toBe(0)
  })
})

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
