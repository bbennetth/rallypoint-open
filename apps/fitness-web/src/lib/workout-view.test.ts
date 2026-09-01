// Unit tests for workout-view pure helpers. No DOM, no React, no network.
import { describe, it, expect } from 'vitest'
import {
  groupWorkoutsByDate,
  isoToLocalDate,
  offsetDate,
  formatDateLabel,
  groupSetsByExercise,
  setFieldsForShape,
  modalityLabel,
  buildWorkoutPayload,
  formatWorkoutSummaryLine,
} from './workout-view.js'
import { formatTonnage } from './units.js'
import type { WorkoutDto, WorkoutSetDto } from '@rallypoint/fitness-shared'

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeWorkout(overrides: Partial<WorkoutDto>): WorkoutDto {
  return {
    id: 'w1',
    performedAt: '2026-06-23T09:00:00.000Z',
    modality: 'strength',
    title: null,
    durationS: null,
    location: null,
    rpe: null,
    notes: null,
    payload: null,
    sets: [],
    createdAt: '2026-06-23T09:00:00.000Z',
    updatedAt: '2026-06-23T09:00:00.000Z',
    ...overrides,
  }
}

function makeSet(overrides: Partial<WorkoutSetDto>): WorkoutSetDto {
  return {
    id: 's1',
    exerciseId: 'ex1',
    setIndex: 0,
    reps: null,
    loadKg: null,
    calories: null,
    distanceM: null,
    timeS: null,
    inclinePct: null,
    rounds: null,
    rpe: null,
    notes: null,
    setType: 'working',
    ...overrides,
  }
}

// ── isoToLocalDate ────────────────────────────────────────────────────────────

describe('isoToLocalDate', () => {
  it('extracts YYYY-MM-DD from an ISO instant', () => {
    const result = isoToLocalDate('2026-06-23T09:00:00.000Z')
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

// ── offsetDate ────────────────────────────────────────────────────────────────

describe('offsetDate', () => {
  it('returns the date minus one day', () => {
    expect(offsetDate('2026-06-23', -1)).toBe('2026-06-22')
  })

  it('returns the date plus one day', () => {
    expect(offsetDate('2026-06-23', 1)).toBe('2026-06-24')
  })

  it('handles month boundaries', () => {
    expect(offsetDate('2026-06-01', -1)).toBe('2026-05-31')
  })
})

// ── formatDateLabel ───────────────────────────────────────────────────────────

describe('formatDateLabel', () => {
  const today = '2026-06-23'
  const yesterday = '2026-06-22'

  it('returns "Today" for today', () => {
    expect(formatDateLabel(today, today, yesterday)).toBe('Today')
  })

  it('returns "Yesterday" for yesterday', () => {
    expect(formatDateLabel(yesterday, today, yesterday)).toBe('Yesterday')
  })

  it('returns a formatted string for other dates', () => {
    const label = formatDateLabel('2026-06-20', today, yesterday)
    expect(label).toContain('20')
    expect(label.length).toBeGreaterThan(5)
  })
})

// ── groupWorkoutsByDate ───────────────────────────────────────────────────────

describe('groupWorkoutsByDate', () => {
  it('returns empty array for empty list', () => {
    expect(groupWorkoutsByDate([], '2026-06-23')).toHaveLength(0)
  })

  it('groups workouts on the same local date into one bucket', () => {
    const w1 = makeWorkout({ id: 'w1', performedAt: '2026-06-23T08:00:00.000Z' })
    const w2 = makeWorkout({ id: 'w2', performedAt: '2026-06-23T18:00:00.000Z' })
    const groups = groupWorkoutsByDate([w1, w2], '2026-06-23')
    // Both on same UTC day — may be same or different local dates depending on TZ,
    // but the group count should be ≥ 1.
    expect(groups.length).toBeGreaterThanOrEqual(1)
    const total = groups.reduce((sum, g) => sum + g.workouts.length, 0)
    expect(total).toBe(2)
  })

  it('produces multiple buckets for workouts on different days', () => {
    const w1 = makeWorkout({ id: 'w1', performedAt: '2026-06-22T09:00:00.000Z' })
    const w2 = makeWorkout({ id: 'w2', performedAt: '2026-06-23T09:00:00.000Z' })
    const groups = groupWorkoutsByDate([w1, w2], '2026-06-23')
    expect(groups.length).toBe(2)
  })

  it('sorts buckets newest-first', () => {
    const w1 = makeWorkout({ id: 'w1', performedAt: '2026-06-20T09:00:00.000Z' })
    const w2 = makeWorkout({ id: 'w2', performedAt: '2026-06-23T09:00:00.000Z' })
    const groups = groupWorkoutsByDate([w1, w2], '2026-06-23')
    expect(groups[0]!.date >= groups[groups.length - 1]!.date).toBe(true)
  })
})

// ── groupSetsByExercise ───────────────────────────────────────────────────────

describe('groupSetsByExercise', () => {
  it('returns empty array for no sets', () => {
    expect(groupSetsByExercise([], new Map())).toHaveLength(0)
  })

  it('groups sets from the same exercise together', () => {
    const sets = [
      makeSet({ exerciseId: 'ex1', setIndex: 0 }),
      makeSet({ exerciseId: 'ex1', setIndex: 1 }),
    ]
    const result = groupSetsByExercise(sets, new Map([['ex1', 'Squat']]))
    expect(result).toHaveLength(1)
    expect(result[0]!.exerciseName).toBe('Squat')
    expect(result[0]!.sets).toHaveLength(2)
  })

  it('preserves insertion order of first encounter', () => {
    const sets = [
      makeSet({ exerciseId: 'ex2' }),
      makeSet({ exerciseId: 'ex1' }),
    ]
    const result = groupSetsByExercise(sets, new Map())
    expect(result[0]!.exerciseId).toBe('ex2')
    expect(result[1]!.exerciseId).toBe('ex1')
  })

  it('falls back to a neutral label — never the raw id — for unknown exercises', () => {
    const sets = [makeSet({ exerciseId: 'fx_01KYA7RAF4GS4RE8AG9ZJSP6X4' })]
    const result = groupSetsByExercise(sets, new Map())
    expect(result[0]!.exerciseName).toBe('Exercise')
    expect(result[0]!.exerciseName).not.toContain('01KYA')
    // The id itself is still carried, so callers can key/debug off it.
    expect(result[0]!.exerciseId).toBe('fx_01KYA7RAF4GS4RE8AG9ZJSP6X4')
  })

  it('recovers a readable label from a legacy fx_seed_ id', () => {
    const sets = [makeSet({ exerciseId: 'fx_seed_wall_ball' })]
    const result = groupSetsByExercise(sets, new Map())
    expect(result[0]!.exerciseName).toBe('Wall Ball')
  })
})

// ── setFieldsForShape ─────────────────────────────────────────────────────────

describe('setFieldsForShape', () => {
  it('load_reps shows reps and loadKg only', () => {
    const f = setFieldsForShape('load_reps')
    expect(f.reps).toBe(true)
    expect(f.loadKg).toBe(true)
    expect(f.distanceM).toBe(false)
    expect(f.timeS).toBe(false)
    expect(f.rounds).toBe(false)
  })

  it('distance_time shows distanceM and timeS only', () => {
    const f = setFieldsForShape('distance_time')
    expect(f.distanceM).toBe(true)
    expect(f.timeS).toBe(true)
    expect(f.reps).toBe(false)
    expect(f.loadKg).toBe(false)
    expect(f.rounds).toBe(false)
  })

  it('rounds_reps shows reps and rounds only', () => {
    const f = setFieldsForShape('rounds_reps')
    expect(f.reps).toBe(true)
    expect(f.rounds).toBe(true)
    expect(f.loadKg).toBe(false)
    expect(f.distanceM).toBe(false)
    expect(f.timeS).toBe(false)
  })

  it('duration shows only timeS', () => {
    const f = setFieldsForShape('duration')
    expect(f.timeS).toBe(true)
    expect(f.reps).toBe(false)
    expect(f.loadKg).toBe(false)
    expect(f.distanceM).toBe(false)
    expect(f.rounds).toBe(false)
  })

  it('unknown shape shows all fields', () => {
    const f = setFieldsForShape('unknown_shape')
    expect(f.reps).toBe(true)
    expect(f.loadKg).toBe(true)
    expect(f.distanceM).toBe(true)
    expect(f.timeS).toBe(true)
    expect(f.rounds).toBe(true)
  })
})

// ── modalityLabel ─────────────────────────────────────────────────────────────

describe('modalityLabel', () => {
  it('maps known modalities', () => {
    expect(modalityLabel('strength')).toBe('Strength')
    expect(modalityLabel('conditioning')).toBe('Conditioning')
    expect(modalityLabel('endurance')).toBe('Endurance')
    expect(modalityLabel('class')).toBe('Class')
    expect(modalityLabel('mobility')).toBe('Mobility')
    expect(modalityLabel('mixed')).toBe('Mixed')
  })

  it('falls back to raw slug', () => {
    expect(modalityLabel('unknown_modality')).toBe('unknown_modality')
  })
})

// ── buildWorkoutPayload ───────────────────────────────────────────────────────

describe('buildWorkoutPayload', () => {
  const baseForm = {
    performedAt: '2026-06-23T09:00:00.000Z',
    modality: 'strength',
    title: '',
    durationS: '',
    location: '',
    rpe: '',
    notes: '',
    exercises: [],
  }

  it('returns null when performedAt is missing', () => {
    expect(buildWorkoutPayload({ ...baseForm, performedAt: '' })).toBeNull()
  })

  it('returns null when modality is missing', () => {
    expect(buildWorkoutPayload({ ...baseForm, modality: '' })).toBeNull()
  })

  it('builds a minimal valid payload', () => {
    const p = buildWorkoutPayload(baseForm)
    expect(p).not.toBeNull()
    expect(p?.modality).toBe('strength')
    expect(p?.sets).toHaveLength(0)
  })

  it('trims and omits empty optional string fields', () => {
    const p = buildWorkoutPayload({ ...baseForm, title: '  ', location: '  ' })
    expect(p?.title).toBeUndefined()
    expect(p?.location).toBeUndefined()
  })

  it('includes optional string fields when non-empty', () => {
    const p = buildWorkoutPayload({ ...baseForm, title: 'Morning session', location: 'Garage' })
    expect(p?.title).toBe('Morning session')
    expect(p?.location).toBe('Garage')
  })

  it('parses rpe as integer', () => {
    const p = buildWorkoutPayload({ ...baseForm, rpe: '8' })
    expect(p?.rpe).toBe(8)
  })

  it('omits rpe when blank', () => {
    const p = buildWorkoutPayload({ ...baseForm, rpe: '' })
    expect(p?.rpe).toBeUndefined()
  })

  it('builds sets from exercises', () => {
    const form = {
      ...baseForm,
      exercises: [
        {
          exerciseId: 'ex1',
          exerciseName: 'Squat',
          metricShape: 'load_reps',
          sets: [
            { exerciseId: 'ex1', reps: '5', loadKg: '100', calories: '', distanceM: '', timeS: '', rounds: '', rpe: '9', notes: '' },
          ],
        },
      ],
    }
    const p = buildWorkoutPayload(form)
    expect(p?.sets).toHaveLength(1)
    expect(p?.sets[0]?.reps).toBe(5)
    expect(p?.sets[0]?.loadKg).toBe(100)
    expect(p?.sets[0]?.rpe).toBe(9)
  })

  it('threads setType through to the payload', () => {
    const form = {
      ...baseForm,
      exercises: [
        {
          exerciseId: 'ex1',
          exerciseName: 'Squat',
          metricShape: 'load_reps',
          sets: [
            { exerciseId: 'ex1', reps: '5', loadKg: '40', calories: '', distanceM: '', timeS: '', rounds: '', rpe: '', notes: '', setType: 'warmup' as const },
            { exerciseId: 'ex1', reps: '5', loadKg: '100', calories: '', distanceM: '', timeS: '', rounds: '', rpe: '', notes: '' },
          ],
        },
      ],
    }
    const p = buildWorkoutPayload(form)
    expect(p?.sets[0]?.setType).toBe('warmup')
    expect(p?.sets[1]?.setType).toBeUndefined()
  })
})

// ── formatWorkoutSummaryLine ──────────────────────────────────────────────────

describe('formatWorkoutSummaryLine', () => {
  it('shows set count alone when no tonnage or distance', () => {
    expect(
      formatWorkoutSummaryLine({ setCount: 3, tonnageKg: 0, totalDistanceM: 0 }, { unit: 'kg' }),
    ).toBe('3 sets')
  })

  it('uses singular for one set', () => {
    expect(
      formatWorkoutSummaryLine({ setCount: 1, tonnageKg: 0, totalDistanceM: 0 }, { unit: 'kg' }),
    ).toBe('1 set')
  })

  it('renders tonnage in kg when the display unit is kg', () => {
    expect(
      formatWorkoutSummaryLine({ setCount: 4, tonnageKg: 800, totalDistanceM: 0 }, { unit: 'kg' }),
    ).toBe('4 sets · 800 kg')
  })

  it('renders tonnage in pounds when the display unit is lb', () => {
    expect(
      formatWorkoutSummaryLine({ setCount: 4, tonnageKg: 800, totalDistanceM: 0 }, { unit: 'lb' }),
    ).toBe('4 sets · 1,764 lb')
  })

  it('matches the score chip formatting on a big kg total (tonnes)', () => {
    const summary = { setCount: 12, tonnageKg: 3310, totalDistanceM: 0 }
    expect(formatWorkoutSummaryLine(summary, { unit: 'kg' })).toBe('12 sets · 3.3 t')
    expect(formatWorkoutSummaryLine(summary, { unit: 'kg' })).toContain(
      formatTonnage(summary.tonnageKg, 'kg'),
    )
  })

  it('matches the score chip formatting on a big lb total (compacted)', () => {
    // Regression: the line used to hardcode kg, so a row read
    // "12 sets · 7,295 kg" beside a "16.1k lb" score.
    const summary = { setCount: 12, tonnageKg: 7295, totalDistanceM: 0 }
    expect(formatWorkoutSummaryLine(summary, { unit: 'lb' })).toBe('12 sets · 16.1k lb')
    expect(formatWorkoutSummaryLine(summary, { unit: 'lb' })).toContain(
      formatTonnage(summary.tonnageKg, 'lb'),
    )
    expect(formatWorkoutSummaryLine(summary, { unit: 'lb' })).not.toContain('kg')
  })

  it('includes distance when non-zero', () => {
    const line = formatWorkoutSummaryLine(
      { setCount: 2, tonnageKg: 0, totalDistanceM: 5200 },
      { unit: 'kg' },
    )
    expect(line).toContain('5.2 km')
  })

  it('includes both tonnage and distance', () => {
    expect(
      formatWorkoutSummaryLine(
        { setCount: 5, tonnageKg: 800, totalDistanceM: 1000 },
        { unit: 'kg' },
      ),
    ).toBe('5 sets · 800 kg · 1.0 km')
    expect(
      formatWorkoutSummaryLine(
        { setCount: 5, tonnageKg: 800, totalDistanceM: 1000 },
        { unit: 'lb' },
      ),
    ).toBe('5 sets · 1,764 lb · 1.0 km')
  })

  it('leaves distance metric regardless of the weight unit', () => {
    for (const unit of ['kg', 'lb'] as const) {
      expect(
        formatWorkoutSummaryLine({ setCount: 1, tonnageKg: 0, totalDistanceM: 12_000 }, { unit }),
      ).toBe('1 set · 12 km')
    }
  })

  // ── omitTonnage: the caller already renders the tonnage itself ──────────

  it('omitTonnage drops the tonnage segment entirely', () => {
    // HistoryRow / WorkoutDetailSheet both show the same formatTonnage
    // value in their own slot, so the line must not repeat it.
    const summary = { setCount: 12, tonnageKg: 7295, totalDistanceM: 0 }
    expect(formatWorkoutSummaryLine(summary, { unit: 'lb', omitTonnage: true })).toBe('12 sets')
    expect(formatWorkoutSummaryLine(summary, { unit: 'kg', omitTonnage: true })).toBe('12 sets')
  })

  it('omitTonnage keeps distance — only the weight segment goes', () => {
    const summary = { setCount: 5, tonnageKg: 800, totalDistanceM: 5200 }
    expect(formatWorkoutSummaryLine(summary, { unit: 'lb', omitTonnage: true })).toBe(
      '5 sets · 5.2 km',
    )
  })

  it('omitTonnage: false is the same as omitting the flag', () => {
    const summary = { setCount: 4, tonnageKg: 800, totalDistanceM: 0 }
    expect(formatWorkoutSummaryLine(summary, { unit: 'lb', omitTonnage: false })).toBe(
      formatWorkoutSummaryLine(summary, { unit: 'lb' }),
    )
  })

  it('omitTonnage is a no-op on a workout with no tonnage', () => {
    const summary = { setCount: 3, tonnageKg: 0, totalDistanceM: 5200 }
    expect(formatWorkoutSummaryLine(summary, { unit: 'kg', omitTonnage: true })).toBe(
      formatWorkoutSummaryLine(summary, { unit: 'kg' }),
    )
  })
})
