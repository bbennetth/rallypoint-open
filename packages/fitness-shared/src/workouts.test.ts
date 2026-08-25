import { describe, expect, it } from 'vitest'
import {
  createWorkoutSchema,
  patchWorkoutSchema,
  summarizeWorkoutSets,
  weatherFromPayload,
} from './workouts.js'

describe('summarizeWorkoutSets', () => {
  it('sums reps, tonnage, distance and time across sets', () => {
    const s = summarizeWorkoutSets([
      { reps: 5, loadKg: 100, calories: null, distanceM: null, timeS: null },
      { reps: 5, loadKg: 100, calories: null, distanceM: null, timeS: null },
      { reps: 8, loadKg: 60, calories: null, distanceM: null, timeS: null },
    ])
    expect(s.setCount).toBe(3)
    expect(s.totalReps).toBe(18)
    expect(s.tonnageKg).toBe(5 * 100 + 5 * 100 + 8 * 60) // 1480
  })

  it('only counts tonnage when a set has both reps and load', () => {
    const s = summarizeWorkoutSets([
      { reps: 10, loadKg: null, calories: null, distanceM: null, timeS: null }, // bodyweight — no load
      { reps: null, loadKg: 50, calories: null, distanceM: null, timeS: null }, // no reps
    ])
    expect(s.tonnageKg).toBe(0)
    expect(s.totalReps).toBe(10)
  })

  it('aggregates endurance distance and time', () => {
    const s = summarizeWorkoutSets([
      { reps: null, loadKg: null, calories: null, distanceM: 5000, timeS: 1500 },
      { reps: null, loadKg: null, calories: null, distanceM: 2000, timeS: 600 },
    ])
    expect(s.totalDistanceM).toBe(7000)
    expect(s.totalTimeS).toBe(2100)
  })

  it('aggregates machine calories', () => {
    const s = summarizeWorkoutSets([
      { reps: null, loadKg: null, calories: 15, distanceM: null, timeS: null },
      { reps: null, loadKg: null, calories: 20, distanceM: null, timeS: null },
    ])
    expect(s.totalCalories).toBe(35)
    expect(s.tonnageKg).toBe(0)
  })

  it('handles an empty workout', () => {
    expect(summarizeWorkoutSets([])).toEqual({
      setCount: 0,
      totalReps: 0,
      tonnageKg: 0,
      totalCalories: 0,
      totalDistanceM: 0,
      totalTimeS: 0,
    })
  })
})

describe('createWorkoutSchema', () => {
  it('accepts a minimal valid workout', () => {
    const r = createWorkoutSchema.safeParse({
      performedAt: '2026-06-26T10:00:00.000Z',
      modality: 'strength',
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.sets).toEqual([])
  })

  it('accepts a calorie set and rejects negative/fractional calories', () => {
    const base = { performedAt: '2026-06-26T10:00:00.000Z', modality: 'strength' }
    expect(
      createWorkoutSchema.safeParse({
        ...base,
        sets: [{ exerciseId: 'fx_seed_assault_bike', calories: 15 }],
      }).success,
    ).toBe(true)
    for (const calories of [-1, 12.5]) {
      expect(
        createWorkoutSchema.safeParse({
          ...base,
          sets: [{ exerciseId: 'fx_seed_assault_bike', calories }],
        }).success,
      ).toBe(false)
    }
  })

  it('rejects a bad modality and a non-ISO performedAt', () => {
    expect(
      createWorkoutSchema.safeParse({ performedAt: '2026-06-26T10:00:00.000Z', modality: 'yoga' })
        .success,
    ).toBe(false)
    expect(
      createWorkoutSchema.safeParse({ performedAt: 'last tuesday', modality: 'strength' }).success,
    ).toBe(false)
  })

  it('rejects an out-of-range rpe', () => {
    expect(
      createWorkoutSchema.safeParse({
        performedAt: '2026-06-26T10:00:00.000Z',
        modality: 'strength',
        rpe: 11,
      }).success,
    ).toBe(false)
  })

  it('rejects Infinity and NaN on every numeric set field (incl. real-valued ones)', () => {
    // The integer fields (`reps`, `rounds`) are already safe via `.int()`
    // (Math.trunc(Infinity) !== Infinity), but `.min(0)` alone lets Infinity
    // through on the real-valued fields. Pin the behavior across all of them.
    const base = {
      performedAt: '2026-06-26T10:00:00.000Z',
      modality: 'strength' as const,
    }
    for (const field of ['loadKg', 'distanceM', 'timeS', 'inclinePct'] as const) {
      const inf = createWorkoutSchema.safeParse({
        ...base,
        sets: [{ exerciseId: 'fx_x', [field]: Infinity }],
      })
      expect(inf.success, `${field}=Infinity should be rejected`).toBe(false)

      const nan = createWorkoutSchema.safeParse({
        ...base,
        sets: [{ exerciseId: 'fx_x', [field]: NaN }],
      })
      expect(nan.success, `${field}=NaN should be rejected`).toBe(false)
    }
  })
})

describe('patchWorkoutSchema', () => {
  it('allows clearing nullable fields and replacing sets', () => {
    const r = patchWorkoutSchema.safeParse({ title: null, sets: [{ exerciseId: 'fx_x' }] })
    expect(r.success).toBe(true)
  })
})

describe('running set capture (distance + time + incline)', () => {
  const base = { performedAt: '2026-06-26T10:00:00.000Z', modality: 'endurance' as const }

  it('accepts distance, time, incline and rpe together on one set', () => {
    const r = createWorkoutSchema.safeParse({
      ...base,
      sets: [
        { exerciseId: 'fx_seed_run', distanceM: 8046.7, timeS: 3120, inclinePct: 1.5, rpe: 7 },
      ],
    })
    expect(r.success).toBe(true)
  })

  it('rejects out-of-range incline', () => {
    for (const inclinePct of [-1, 101]) {
      expect(
        createWorkoutSchema.safeParse({
          ...base,
          sets: [{ exerciseId: 'fx_seed_run', distanceM: 5000, inclinePct }],
        }).success,
      ).toBe(false)
    }
  })
})

describe('weatherFromPayload', () => {
  const weather = {
    temperatureC: 21.4,
    apparentTemperatureC: 23.1,
    windSpeedKmh: 12,
    weatherCode: 2,
    isDay: true,
    fetchedAt: '2026-07-14T10:00:00.000Z',
  }

  it('parses a valid snapshot out of a workout payload', () => {
    expect(weatherFromPayload({ weather, other: 'stuff' })).toEqual(weather)
  })

  it('accepts a minimal snapshot (nullish optionals)', () => {
    const minimal = { temperatureC: -3, fetchedAt: '2026-01-02T08:00:00.000Z' }
    expect(weatherFromPayload({ weather: minimal })).toEqual(minimal)
  })

  it('returns null for absent or malformed slots', () => {
    expect(weatherFromPayload(null)).toBeNull()
    expect(weatherFromPayload({})).toBeNull()
    expect(weatherFromPayload({ weather: 'sunny' })).toBeNull()
    expect(weatherFromPayload({ weather: { temperatureC: Infinity, fetchedAt: 'x' } })).toBeNull()
  })
})
