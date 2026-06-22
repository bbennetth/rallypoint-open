import { describe, it, expect } from 'vitest'
import { buildChoreSeriesInput, choresInFeedsEnabled, type ChoreRecurrenceForm } from './chores-helpers.js'

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
