import { describe, expect, it } from 'vitest'
import {
  createMetricSchema,
  metricKindDef,
  metricValueOutOfScale,
  summarizeMetricSeries,
} from './metrics.js'

describe('createMetricSchema', () => {
  it('accepts a known kind with a finite value', () => {
    const r = createMetricSchema.safeParse({
      recordedAt: '2026-06-26T07:00:00.000Z',
      kind: 'bodyweight',
      value: 82.5,
      unit: 'kg',
    })
    expect(r.success).toBe(true)
  })

  it('accepts an arbitrary custom slug kind', () => {
    expect(
      createMetricSchema.safeParse({
        recordedAt: '2026-06-26T07:00:00.000Z',
        kind: 'grip_strength',
        value: 55,
      }).success,
    ).toBe(true)
  })

  it('rejects a non-slug kind, a non-finite value, and a bad date', () => {
    expect(
      createMetricSchema.safeParse({ recordedAt: '2026-06-26T07:00:00.000Z', kind: 'Body Weight', value: 80 })
        .success,
    ).toBe(false)
    expect(
      createMetricSchema.safeParse({ recordedAt: '2026-06-26T07:00:00.000Z', kind: 'hrv', value: Infinity })
        .success,
    ).toBe(false)
    expect(createMetricSchema.safeParse({ recordedAt: 'today', kind: 'hrv', value: 40 }).success).toBe(
      false,
    )
  })
})

describe('metricKindDef', () => {
  it('resolves known kinds and their scale bounds', () => {
    expect(metricKindDef('resting_hr')?.unit).toBe('bpm')
    expect(metricKindDef('soreness')?.scale).toEqual({ min: 1, max: 10 })
    expect(metricKindDef('grip_strength')).toBeUndefined()
  })
})

describe('metricValueOutOfScale + createMetricSchema scale enforcement', () => {
  it('flags values outside a known kind scale and accepts in-range', () => {
    // soreness 1-10
    expect(metricValueOutOfScale('soreness', 0)).toBe(true)
    expect(metricValueOutOfScale('soreness', 1)).toBe(false)
    expect(metricValueOutOfScale('soreness', 10)).toBe(false)
    expect(metricValueOutOfScale('soreness', 11)).toBe(true)
    expect(metricValueOutOfScale('soreness', 999)).toBe(true)
    // energy + mood 1-5
    expect(metricValueOutOfScale('energy', 6)).toBe(true)
    expect(metricValueOutOfScale('mood', 5)).toBe(false)
  })

  it('returns false for kinds with no scale (custom or unbounded known)', () => {
    expect(metricValueOutOfScale('bodyweight', 999)).toBe(false)
    expect(metricValueOutOfScale('grip_strength', 9999)).toBe(false)
  })

  it('createMetricSchema rejects out-of-scale values on a bounded kind', () => {
    const tooHigh = createMetricSchema.safeParse({
      recordedAt: '2026-06-26T07:00:00.000Z',
      kind: 'soreness',
      value: 11,
    })
    expect(tooHigh.success).toBe(false)

    const tooLow = createMetricSchema.safeParse({
      recordedAt: '2026-06-26T07:00:00.000Z',
      kind: 'soreness',
      value: 0,
    })
    expect(tooLow.success).toBe(false)

    const ok = createMetricSchema.safeParse({
      recordedAt: '2026-06-26T07:00:00.000Z',
      kind: 'soreness',
      value: 7,
    })
    expect(ok.success).toBe(true)
  })
})

describe('summarizeMetricSeries', () => {
  it('summarizes a series time-ordered regardless of input order', () => {
    const s = summarizeMetricSeries([
      { recordedAt: '2026-06-03T07:00:00.000Z', value: 81 },
      { recordedAt: '2026-06-01T07:00:00.000Z', value: 83 },
      { recordedAt: '2026-06-02T07:00:00.000Z', value: 82 },
    ])
    expect(s.count).toBe(3)
    expect(s.first).toBe(83) // earliest by date
    expect(s.latest).toBe(81) // latest by date
    expect(s.min).toBe(81)
    expect(s.max).toBe(83)
    expect(s.avg).toBe(82)
    expect(s.delta).toBe(-2) // latest − first
  })

  it('handles an empty series', () => {
    expect(summarizeMetricSeries([])).toEqual({
      count: 0,
      latest: null,
      first: null,
      min: null,
      max: null,
      avg: null,
      delta: null,
    })
  })
})
