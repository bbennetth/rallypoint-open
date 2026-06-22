import { describe, expect, it } from 'vitest'
import { calendarWindow, mergeCalendarGroups } from './calendar-merge-helpers.js'
import type { UpcomingGroup } from './planner-helpers.js'
import type { UpcomingItem } from './api.js'

// Minimal task UpcomingItem keyed by id (the id doubles as the title).
function task(id: string): UpcomingItem {
  return {
    kind: 'task',
    task: {
      id,
      listId: 'l1',
      title: id,
      completed: false,
      priority: null,
      dueDate: null,
      seriesId: null,
      customFields: {},
    },
  }
}

function group(ymd: string, items: UpcomingItem[]): UpcomingGroup {
  return { ymd, dateLabel: ymd, rel: '', items }
}

function ids(g: UpcomingGroup): string[] {
  return g.items.map((it) => (it.kind === 'task' ? it.task.id : 'x'))
}

describe('mergeCalendarGroups', () => {
  it('returns [] for no sources / all-empty sources', () => {
    expect(mergeCalendarGroups()).toEqual([])
    expect(mergeCalendarGroups([], [])).toEqual([])
  })

  it('appends later-source items after earlier-source items on the same day', () => {
    const out = mergeCalendarGroups(
      [group('2026-06-10', [task('a')])],
      [group('2026-06-10', [task('b')])],
    )
    expect(out).toHaveLength(1)
    expect(ids(out[0]!)).toEqual(['a', 'b'])
  })

  it('sorts day-groups ascending by ymd across sources', () => {
    const out = mergeCalendarGroups(
      [group('2026-06-12', [task('c')]), group('2026-06-10', [task('a')])],
      [group('2026-06-11', [task('b')])],
    )
    expect(out.map((g) => g.ymd)).toEqual(['2026-06-10', '2026-06-11', '2026-06-12'])
  })

  it('merges three sources on one day in source order', () => {
    const out = mergeCalendarGroups(
      [group('2026-06-10', [task('a')])],
      [group('2026-06-10', [task('b')])],
      [group('2026-06-10', [task('c')])],
    )
    expect(out).toHaveLength(1)
    expect(ids(out[0]!)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate the input groups or their items arrays', () => {
    const src = group('2026-06-10', [task('a')])
    const srcItems = src.items
    mergeCalendarGroups([src], [group('2026-06-10', [task('b')])])
    expect(src.items).toBe(srcItems)
    expect(src.items).toHaveLength(1)
  })
})

describe('calendarWindow', () => {
  it('spans the full month for month view (non-leap February)', () => {
    expect(calendarWindow('month', 2026, 2, '2026-02-15')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    })
  })

  it('spans the full month for month view (December)', () => {
    expect(calendarWindow('month', 2026, 12, '2026-12-01')).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    })
  })

  it('spans Sunday→Saturday for week view containing the anchor', () => {
    // 2026-06-10 is a Wednesday; its week runs Sun 06-07 → Sat 06-13.
    expect(calendarWindow('week', 2026, 6, '2026-06-10')).toEqual({
      from: '2026-06-07',
      to: '2026-06-13',
    })
  })

  it('returns a single-day-aligned week when the anchor is the Sunday start', () => {
    expect(calendarWindow('week', 2026, 6, '2026-06-07')).toEqual({
      from: '2026-06-07',
      to: '2026-06-13',
    })
  })

  it('spans Sunday→Saturday when the anchor is the Saturday end of the week', () => {
    // 2026-06-13 is a Saturday (dow=6); its week still runs Sun 06-07 → Sat 06-13.
    expect(calendarWindow('week', 2026, 6, '2026-06-13')).toEqual({
      from: '2026-06-07',
      to: '2026-06-13',
    })
  })

  it('handles a week that straddles a year boundary', () => {
    // 2026-01-01 is a Thursday (dow=4); its week runs Sun 2025-12-28 → Sat 2026-01-03.
    expect(calendarWindow('week', 2026, 1, '2026-01-01')).toEqual({
      from: '2025-12-28',
      to: '2026-01-03',
    })
  })

  it('spans the full month for a leap-year February', () => {
    expect(calendarWindow('month', 2024, 2, '2024-02-15')).toEqual({
      from: '2024-02-01',
      to: '2024-02-29',
    })
  })
})
