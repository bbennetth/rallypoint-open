import { describe, expect, it } from 'vitest'
import { buildSeriesPatch, type SeriesFormState } from './series-patch.js'
import type { RecurringSeriesDto } from './api.js'

function series(overrides: Partial<RecurringSeriesDto> = {}): RecurringSeriesDto {
  return {
    id: 's1',
    listId: 'l1',
    listName: 'Chores',
    title: 'Take out trash',
    notes: null,
    priority: null,
    freq: 'weekly',
    interval: 1,
    byDay: ['MO', 'TH'],
    dtstart: '2026-01-01',
    until: null,
    count: null,
    timeOfDay: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    next: [],
    ...overrides,
  }
}

// A form pre-filled to match the series (so a no-op build yields {}).
function formFor(s: RecurringSeriesDto, overrides: Partial<SeriesFormState> = {}): SeriesFormState {
  return {
    title: s.title,
    notes: s.notes ?? '',
    priority: s.priority,
    freq: s.freq,
    interval: String(s.interval),
    byDay: s.byDay ?? [],
    dtstart: s.dtstart.slice(0, 10),
    timeOfDay: s.timeOfDay ?? '',
    mode: s.until ? 'until' : s.count != null ? 'count' : 'none',
    untilDate: s.until ?? '',
    countStr: s.count != null ? String(s.count) : '',
    ...overrides,
  }
}

function build(s: RecurringSeriesDto, f: SeriesFormState) {
  const r = buildSeriesPatch(s, f)
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`)
  return r.patch
}

describe('buildSeriesPatch — no-op & basic fields', () => {
  it('produces an empty patch when nothing changed', () => {
    const s = series()
    expect(build(s, formFor(s))).toEqual({})
  })
  it('patches only changed first-class fields', () => {
    const s = series()
    expect(build(s, formFor(s, { title: 'New title', interval: '2' }))).toEqual({
      title: 'New title',
      interval: 2,
    })
  })
  it('requires a non-empty title', () => {
    const s = series()
    const r = buildSeriesPatch(s, formFor(s, { title: '   ' }))
    expect(r).toEqual({ ok: false, error: 'Title is required.' })
  })
  it('coerces interval below 1 to 1', () => {
    const s = series({ interval: 3 })
    expect(build(s, formFor(s, { interval: '0' }))).toEqual({ interval: 1 })
  })
})

describe('buildSeriesPatch — priority (set-only)', () => {
  it('sets a priority newly chosen on a series that had none', () => {
    const s = series({ priority: null })
    expect(build(s, formFor(s, { priority: 'high' }))).toEqual({ priority: 'high' })
  })
  it('sends the changed priority value', () => {
    const s = series({ priority: 'low' })
    expect(build(s, formFor(s, { priority: 'high' }))).toEqual({ priority: 'high' })
  })
  it('omits priority when unchanged', () => {
    const s = series({ priority: 'medium' })
    expect(build(s, formFor(s, { priority: 'medium' }))).toEqual({})
  })
  it('cannot clear priority (series is set-only) — null input yields empty patch', () => {
    // PriorityPicker can emit null (when allowClear is true), but the series
    // patch builder's truthiness guard is load-bearing: null input is a no-op.
    const s = series({ priority: 'high' })
    expect(build(s, formFor(s, { priority: null }))).toEqual({})
  })
})

describe('buildSeriesPatch — notes/time clearing via empty string', () => {
  it('clears notes with "" (server maps to null)', () => {
    const s = series({ notes: 'old' })
    expect(build(s, formFor(s, { notes: '' }))).toEqual({ notes: '' })
  })
  it('clears timeOfDay with ""', () => {
    const s = series({ timeOfDay: '08:00:00' })
    expect(build(s, formFor(s, { timeOfDay: '' }))).toEqual({ timeOfDay: '' })
  })
})

describe('buildSeriesPatch — byDay', () => {
  it('sends a sorted array when days change', () => {
    const s = series({ byDay: ['MO'] })
    expect(build(s, formFor(s, { byDay: ['WE', 'MO'] }))).toEqual({ byDay: ['MO', 'WE'] })
  })
  it('clears byDay with null (not []) when no day is selected on a weekly rule', () => {
    const s = series({ byDay: ['MO', 'TH'] })
    expect(build(s, formFor(s, { byDay: [] }))).toEqual({ byDay: null })
  })
  it('clears byDay with null when switching to daily', () => {
    const s = series({ freq: 'weekly', byDay: ['MO', 'TH'] })
    expect(build(s, formFor(s, { freq: 'daily' }))).toEqual({ freq: 'daily', byDay: null })
  })
  it('does not resend byDay when only the order differs', () => {
    const s = series({ byDay: ['MO', 'TH'] })
    expect(build(s, formFor(s, { byDay: ['TH', 'MO'] }))).toEqual({})
  })
})

describe('buildSeriesPatch — termination', () => {
  it('clears until with null when switching to Never', () => {
    const s = series({ until: '2026-12-31' })
    expect(build(s, formFor(s, { mode: 'none', untilDate: '2026-12-31' }))).toEqual({ until: null })
  })
  it('clears count with null when switching to Never', () => {
    const s = series({ count: 10 })
    expect(build(s, formFor(s, { mode: 'none', countStr: '10' }))).toEqual({ count: null })
  })
  it('switching until → count sets count and clears until', () => {
    const s = series({ until: '2026-12-31' })
    expect(build(s, formFor(s, { mode: 'count', countStr: '5', untilDate: '2026-12-31' }))).toEqual({
      count: 5,
      until: null,
    })
  })
  it('switching count → until sets until and clears count', () => {
    const s = series({ count: 5 })
    expect(
      build(s, formFor(s, { mode: 'until', untilDate: '2026-06-30', countStr: '5' })),
    ).toEqual({ until: '2026-06-30', count: null })
  })
  it('errors when until mode has no date', () => {
    const s = series({ until: null })
    expect(buildSeriesPatch(s, formFor(s, { mode: 'until', untilDate: '' }))).toEqual({
      ok: false,
      error: 'Pick an end date, or choose Never.',
    })
  })
  it('errors when count mode has an invalid number', () => {
    const s = series({ count: null })
    expect(buildSeriesPatch(s, formFor(s, { mode: 'count', countStr: 'x' }))).toEqual({
      ok: false,
      error: 'Enter how many times it repeats.',
    })
  })
  it('does not touch termination when already Never and unchanged', () => {
    const s = series({ until: null, count: null })
    expect(build(s, formFor(s, { mode: 'none' }))).toEqual({})
  })
})
