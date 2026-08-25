import { describe, it, expect } from 'vitest'
import {
  buildChoreSeriesInput,
  choresInFeedsEnabled,
  commitCheckinInput,
  formatChoreTrailingLabel,
  splitChoresFromTasks,
  type ChoreRecurrenceForm,
} from './chores-helpers.js'
import type { MyDayTask } from './api.js'

function form(over: Partial<ChoreRecurrenceForm> = {}): ChoreRecurrenceForm {
  return {
    title: 'Take out trash',
    freq: 'weekly',
    interval: 1,
    byDay: [],
    dtstart: '2026-06-08',
    bound: 'count',
    count: 10,
    until: '',
    timeOfDay: '',
    ...over,
  }
}

describe('buildChoreSeriesInput', () => {
  it('rejects an empty title', () => {
    const r = buildChoreSeriesInput(form({ title: '   ' }))
    expect(r.ok).toBe(false)
  })

  it('builds a weekly series with byDay + count bound', () => {
    const r = buildChoreSeriesInput(form({ byDay: ['MO', 'WE'], count: 5 }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.input).toMatchObject({
        title: 'Take out trash',
        freq: 'weekly',
        interval: 1,
        dtstart: '2026-06-08',
        byDay: ['MO', 'WE'],
        count: 5,
      })
      expect(r.input.until).toBeUndefined()
    }
  })

  it('drops byDay on a daily series', () => {
    const r = buildChoreSeriesInput(form({ freq: 'daily', byDay: ['MO'] }))
    expect(r.ok && r.input.byDay).toBeUndefined()
  })

  it('includes timeOfDay only when set', () => {
    expect(buildChoreSeriesInput(form()).ok && buildChoreSeriesInput(form()).ok).toBe(true)
    const withTime = buildChoreSeriesInput(form({ timeOfDay: '08:00' }))
    expect(withTime.ok && withTime.input.timeOfDay).toBe('08:00')
  })

  it('requires an end date when the bound is "until"', () => {
    const r = buildChoreSeriesInput(form({ bound: 'until', until: '' }))
    expect(r.ok).toBe(false)
  })

  it('builds an until-bounded series with a date', () => {
    const r = buildChoreSeriesInput(form({ bound: 'until', until: '2026-12-31' }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.input.until).toBe('2026-12-31')
      expect(r.input.count).toBeUndefined()
    }
  })

  it('omits both bounds when "forever"', () => {
    const r = buildChoreSeriesInput(form({ bound: 'forever' }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.input.count).toBeUndefined()
      expect(r.input.until).toBeUndefined()
    }
  })
})

describe('choresInFeedsEnabled', () => {
  it('defaults ON when absent', () => {
    expect(choresInFeedsEnabled({})).toBe(true)
  })
  it('is OFF only when explicitly false', () => {
    expect(choresInFeedsEnabled({ showChoresInFeeds: false })).toBe(false)
    expect(choresInFeedsEnabled({ showChoresInFeeds: true })).toBe(true)
  })
})

function task(id: string, listId: string): MyDayTask {
  return {
    id,
    listId,
    title: id,
    completed: false,
    priority: null,
    dueDate: null,
    seriesId: null,
    customFields: {},
  }
}

describe('splitChoresFromTasks', () => {
  it('returns the input untouched when choresListId is null', () => {
    const ts = [task('a', 'lst_x'), task('b', 'lst_y')]
    expect(splitChoresFromTasks(ts, null)).toEqual({ tasks: ts, chores: [] })
  })
  it('splits chores out and preserves order in each bucket', () => {
    const a = task('a', 'lst_x')
    const b = task('b', 'lst_c')
    const c = task('c', 'lst_x')
    const d = task('d', 'lst_c')
    const result = splitChoresFromTasks([a, b, c, d], 'lst_c')
    expect(result.tasks).toEqual([a, c])
    expect(result.chores).toEqual([b, d])
  })
  it('returns empty chores when no item matches the chores list', () => {
    const ts = [task('a', 'lst_x'), task('b', 'lst_y')]
    expect(splitChoresFromTasks(ts, 'lst_c').chores).toEqual([])
  })
})

describe('commitCheckinInput', () => {
  it('returns the input unchanged for whitespace-only input', () => {
    const existing = [{ id: 'mc-0', title: 'Old' }]
    expect(commitCheckinInput('   \n\t', existing)).toEqual(existing)
  })
  it('adds a single trimmed line', () => {
    expect(commitCheckinInput('  Write plan  ', [])).toEqual([
      { id: 'mc-0', title: 'Write plan' },
    ])
  })
  it('splits a multiline paste into one entry per non-empty line', () => {
    const result = commitCheckinInput('Email Avery\n\nReview PR\n  \nShip the build', [])
    expect(result.map((t) => t.title)).toEqual(['Email Avery', 'Review PR', 'Ship the build'])
    expect(result.map((t) => t.id)).toEqual(['mc-0', 'mc-1', 'mc-2'])
  })
  it('dedupes case-insensitively against existing entries', () => {
    const existing = [{ id: 'mc-0', title: 'Write plan' }]
    const result = commitCheckinInput('  WRITE PLAN  \nReview PR', existing)
    expect(result.map((t) => t.title)).toEqual(['Write plan', 'Review PR'])
  })
  it('dedupes within the same paste', () => {
    const result = commitCheckinInput('Email Avery\nemail   avery', [])
    expect(result.map((t) => t.title)).toEqual(['Email Avery'])
  })
  it('honors a custom idPrefix', () => {
    expect(commitCheckinInput('A', [], 'foo')).toEqual([{ id: 'foo-0', title: 'A' }])
  })

  it('never reuses an existing numeric suffix after a remove+add cycle', () => {
    // Simulates: add A (mc-0), add B (mc-1), remove A, add C. The naive
    // length-based counter would assign C the id mc-1 (existing.length=1 +
    // 0), colliding with the surviving B. New behavior scans existing IDs
    // and starts from max(suffix)+1 — C must get mc-2.
    const afterAddA = commitCheckinInput('A', [])
    const afterAddB = commitCheckinInput('B', afterAddA)
    expect(afterAddB.map((t) => t.id)).toEqual(['mc-0', 'mc-1'])
    const afterRemove = afterAddB.filter((t) => t.id !== 'mc-0')
    const afterAddC = commitCheckinInput('C', afterRemove)
    expect(afterAddC.map((t) => t.id)).toEqual(['mc-1', 'mc-2'])
    expect(new Set(afterAddC.map((t) => t.id)).size).toBe(afterAddC.length)
  })

  it('restarts numbering from 0 when existing is empty (no surviving ids to collide with)', () => {
    // When pending has been fully cleared there is nothing to collide with,
    // so the counter legitimately restarts at 0 — collisions are only
    // possible against surviving rows.
    expect(commitCheckinInput('X', []).map((t) => t.id)).toEqual(['mc-0'])
  })

  it('falls back to existing.length when no existing id matches the prefix pattern', () => {
    // Legacy / externally-generated ids that don't end in `-<digits>` should
    // not crash; new ids use existing.length as the floor.
    const existing = [{ id: 'legacy-abc', title: 'Old' }]
    const result = commitCheckinInput('New', existing)
    expect(result.map((t) => t.id)).toEqual(['legacy-abc', 'mc-1'])
  })
})

describe('formatChoreTrailingLabel', () => {
  const today = '2026-06-29'
  const fmt = (ymd: string) => `LBL(${ymd})`
  it('renders "Daily" for a freq=daily interval=1 series', () => {
    expect(
      formatChoreTrailingLabel({
        dueYmd: null,
        todayYmd: today,
        seriesFreq: 'daily',
        seriesInterval: 1,
        dateLabel: fmt,
      }),
    ).toBe('Daily')
  })
  it('renders "Every 2 days" for a freq=daily interval=2 series', () => {
    expect(
      formatChoreTrailingLabel({
        dueYmd: null,
        todayYmd: today,
        seriesFreq: 'daily',
        seriesInterval: 2,
        dateLabel: fmt,
      }),
    ).toBe('Every 2 days')
  })
  it('renders "Weekly" for a freq=weekly interval=1 series', () => {
    expect(
      formatChoreTrailingLabel({
        dueYmd: null,
        todayYmd: today,
        seriesFreq: 'weekly',
        seriesInterval: 1,
        dateLabel: fmt,
      }),
    ).toBe('Weekly')
  })
  it('renders "Every 3 weeks" for a freq=weekly interval=3 series', () => {
    expect(
      formatChoreTrailingLabel({
        dueYmd: null,
        todayYmd: today,
        seriesFreq: 'weekly',
        seriesInterval: 3,
        dateLabel: fmt,
      }),
    ).toBe('Every 3 weeks')
  })
  it('returns "Today" for a one-off chore due today', () => {
    expect(
      formatChoreTrailingLabel({
        dueYmd: today,
        todayYmd: today,
        seriesFreq: null,
        seriesInterval: null,
        dateLabel: () => '— never used —',
      }),
    ).toBe('Today')
  })
  it('falls back to dateLabel for a one-off chore on another day', () => {
    expect(
      formatChoreTrailingLabel({
        dueYmd: '2026-07-02',
        todayYmd: today,
        seriesFreq: null,
        seriesInterval: null,
        dateLabel: () => 'Jul 2',
      }),
    ).toBe('Jul 2')
  })
  it('returns "" when no due date and no series', () => {
    expect(
      formatChoreTrailingLabel({
        dueYmd: null,
        todayYmd: today,
        seriesFreq: null,
        seriesInterval: null,
        dateLabel: fmt,
      }),
    ).toBe('')
  })
})
