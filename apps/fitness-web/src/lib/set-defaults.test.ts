// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETS, defaultSetsForExercise } from './composer-state.js'
import {
  DEFAULT_REPS,
  repsPrescriptionFromDefault,
  sanitizeDefaultReps,
  sanitizeDefaultSets,
} from './set-defaults.js'

describe('sanitizeDefaultSets', () => {
  it('passes whole in-range values through', () => {
    expect(sanitizeDefaultSets(5)).toBe(5)
    expect(sanitizeDefaultSets('4')).toBe(4)
  })
  it('clamps to the 20-set field ceiling and rounds fractions', () => {
    expect(sanitizeDefaultSets(99)).toBe(20)
    expect(sanitizeDefaultSets(3.6)).toBe(4)
  })
  it('falls back to the classic 3 on garbage/zero/negatives', () => {
    expect(sanitizeDefaultSets(undefined)).toBe(DEFAULT_SETS)
    expect(sanitizeDefaultSets('abc')).toBe(DEFAULT_SETS)
    expect(sanitizeDefaultSets(0)).toBe(DEFAULT_SETS)
    expect(sanitizeDefaultSets(-2)).toBe(DEFAULT_SETS)
    expect(sanitizeDefaultSets(Number.NaN)).toBe(DEFAULT_SETS)
  })
})

describe('sanitizeDefaultReps', () => {
  it('passes whole in-range values through', () => {
    expect(sanitizeDefaultReps(8)).toBe(8)
    expect(sanitizeDefaultReps('12')).toBe(12)
  })
  it('clamps to the 999-rep field ceiling and rounds fractions', () => {
    expect(sanitizeDefaultReps(5000)).toBe(999)
    expect(sanitizeDefaultReps(9.4)).toBe(9)
  })
  it('falls back to the 5-rep default on garbage/zero/negatives', () => {
    expect(sanitizeDefaultReps(undefined)).toBe(DEFAULT_REPS)
    expect(sanitizeDefaultReps('abc')).toBe(DEFAULT_REPS)
    expect(sanitizeDefaultReps(0)).toBe(DEFAULT_REPS)
    expect(sanitizeDefaultReps(-1)).toBe(DEFAULT_REPS)
  })
  it("passes the 'max' literal through and rejects lookalikes", () => {
    expect(sanitizeDefaultReps('max')).toBe('max')
    expect(sanitizeDefaultReps('MAX')).toBe(DEFAULT_REPS)
    expect(sanitizeDefaultReps('maximum')).toBe(DEFAULT_REPS)
  })
})

describe('repsPrescriptionFromDefault', () => {
  it('maps a number to a plain rep target', () => {
    expect(repsPrescriptionFromDefault(8)).toEqual({ reps: 8, max: false })
  })
  it("maps 'max' to a max-effort row with the product default behind the toggle", () => {
    expect(repsPrescriptionFromDefault('max')).toEqual({ reps: DEFAULT_REPS, max: true })
  })
})

describe('defaultSetsForExercise with a user preference', () => {
  it('applies the preferred count to set-based work', () => {
    expect(
      defaultSetsForExercise(
        { discipline: 'barbell', movementPattern: 'squat', metricShape: 'load_reps' },
        5,
      ),
    ).toBe(5)
    // Timed CORE holds are set-based too (plank 5 × 0:45).
    expect(
      defaultSetsForExercise(
        { discipline: 'bodyweight', movementPattern: 'core', metricShape: 'duration' },
        5,
      ),
    ).toBe(5)
  })
  it('keeps cardio and timed work at a single entry regardless of preference', () => {
    expect(
      defaultSetsForExercise(
        { discipline: 'cardio', movementPattern: 'gait', metricShape: 'distance_time' },
        5,
      ),
    ).toBe(1)
    expect(
      defaultSetsForExercise(
        { discipline: 'bodyweight', movementPattern: 'other', metricShape: 'duration' },
        5,
      ),
    ).toBe(1)
  })
})
