import { describe, expect, it } from 'vitest'
import { buildSeriesLookup, pickChoresListId, resolveSeries } from './series-lookup.js'
import type { TaskSeriesDto } from './api.js'

function series(overrides: Partial<TaskSeriesDto> = {}): TaskSeriesDto {
  return {
    id: 's1',
    listId: 'l1',
    title: 'Take out trash',
    notes: null,
    priority: null,
    freq: 'weekly',
    interval: 1,
    byDay: ['MO'],
    dtstart: '2026-01-01',
    until: null,
    count: null,
    timeOfDay: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('buildSeriesLookup', () => {
  it('tags task series tasks and chore series chores', () => {
    const lookup = buildSeriesLookup(
      [series({ id: 't1', listId: 'tasks-list' })],
      [series({ id: 'c1', listId: 'chores-list' })],
    )
    expect(lookup.get('t1')?.surface).toBe('tasks')
    expect(lookup.get('c1')?.surface).toBe('chores')
    expect(lookup.get('t1')?.series.id).toBe('t1')
  })

  it('lets the task surface win on an id collision', () => {
    const lookup = buildSeriesLookup(
      [series({ id: 'dup', listId: 'tasks-list' })],
      [series({ id: 'dup', listId: 'chores-list' })],
    )
    expect(lookup.get('dup')?.surface).toBe('tasks')
    expect(lookup.get('dup')?.series.listId).toBe('tasks-list')
  })

  it('is empty when there are no series', () => {
    expect(buildSeriesLookup([], []).size).toBe(0)
  })
})

describe('resolveSeries', () => {
  const lookup = buildSeriesLookup([series({ id: 't1' })], [series({ id: 'c1' })])

  it('returns null for a null seriesId', () => {
    expect(resolveSeries(lookup, null)).toBeNull()
  })

  it('returns null for an unknown seriesId', () => {
    expect(resolveSeries(lookup, 'nope')).toBeNull()
  })

  it('resolves a known seriesId with its surface', () => {
    expect(resolveSeries(lookup, 'c1')?.surface).toBe('chores')
  })
})

describe('pickChoresListId', () => {
  const taskIds = new Set(['t1', 't2'])

  it('returns null when no rows carry a series', () => {
    const rows = [
      { seriesId: null, listId: 'a' },
      { seriesId: null, listId: 'b' },
    ]
    expect(pickChoresListId(rows, taskIds)).toBeNull()
  })

  it('ignores rows whose seriesId is a known task series', () => {
    const rows = [
      { seriesId: 't1', listId: 'tasks-list' },
      { seriesId: 't2', listId: 'tasks-list' },
    ]
    expect(pickChoresListId(rows, taskIds)).toBeNull()
  })

  it('returns the listId of the first chore occurrence (unknown seriesId)', () => {
    const rows = [
      { seriesId: 't1', listId: 'tasks-list' },
      { seriesId: 'c9', listId: 'chores-list' },
      { seriesId: 'c8', listId: 'chores-list-2' },
    ]
    expect(pickChoresListId(rows, taskIds)).toBe('chores-list')
  })
})
