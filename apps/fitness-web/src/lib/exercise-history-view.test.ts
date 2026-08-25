import { describe, it, expect } from 'vitest'
import { formatHistorySet, inlineHistorySummary } from './exercise-history-view.js'
import type { ExerciseHistorySession } from '@rallypoint/fitness-shared'

// kgToDisplay rounds kg→lb (×2.2046) to a whole number; 70.31 kg ≈ 155 lb,
// 68.04 kg ≈ 150 lb (the fixtures below are chosen to land on round lb).

describe('formatHistorySet', () => {
  it('renders reps × load with unit and appends RPE', () => {
    expect(formatHistorySet({ reps: 8, loadKg: 70.31, rpe: 8 }, 'lb')).toBe('8 × 155 lb @8')
  })
  it('shows BW when load is 0 (bodyweight)', () => {
    expect(formatHistorySet({ reps: 5, loadKg: 0, rpe: null }, 'lb')).toBe('5 × BW')
  })
  it('reps-only when there is no load', () => {
    expect(formatHistorySet({ reps: 12, loadKg: null, rpe: null }, 'kg')).toBe('12')
  })
})

describe('inlineHistorySummary', () => {
  const session = (sets: ExerciseHistorySession['sets']): ExerciseHistorySession => ({
    workoutId: 'w',
    workoutTitle: null,
    performedAt: '2026-07-10T00:00:00.000Z',
    sets,
  })

  it('joins top sets and shows the unit once', () => {
    const s = session([
      { reps: 8, loadKg: 70.31, rpe: null },
      { reps: 7, loadKg: 68.04, rpe: null },
    ])
    expect(inlineHistorySummary(s, 'lb')).toBe('8×155, 7×150 lb')
  })

  it('appends a recorded RPE per set, unit still once at the end', () => {
    const s = session([
      { reps: 7, loadKg: 70.31, rpe: 8 },
      { reps: 9, loadKg: 70.31, rpe: 8.5 },
    ])
    expect(inlineHistorySummary(s, 'lb')).toBe('7×155 @8, 9×155 @8.5 lb')
  })

  it('mixes RPE and no-RPE sets without leaking a stray @', () => {
    const s = session([
      { reps: 8, loadKg: 70.31, rpe: 8 },
      { reps: 7, loadKg: 68.04, rpe: null },
    ])
    expect(inlineHistorySummary(s, 'lb')).toBe('8×155 @8, 7×150 lb')
  })

  it('appends RPE to bodyweight rep-only chunks too', () => {
    const s = session([
      { reps: 10, loadKg: 0, rpe: 9 },
      { reps: 8, loadKg: null, rpe: null },
    ])
    expect(inlineHistorySummary(s, 'lb')).toBe('10 @9, 8')
  })

  it('caps to maxSets', () => {
    const s = session([
      { reps: 5, loadKg: 45.36, rpe: null },
      { reps: 5, loadKg: 45.36, rpe: null },
      { reps: 5, loadKg: 45.36, rpe: null },
      { reps: 5, loadKg: 45.36, rpe: null },
    ])
    expect(inlineHistorySummary(s, 'lb', 2)).toBe('5×100, 5×100 lb')
  })

  it('bare rep counts for bodyweight-only work (no unit)', () => {
    const s = session([
      { reps: 10, loadKg: null, rpe: null },
      { reps: 8, loadKg: 0, rpe: null },
    ])
    expect(inlineHistorySummary(s, 'lb')).toBe('10, 8')
  })

  it('returns "" when nothing meaningful', () => {
    expect(inlineHistorySummary(session([{ reps: null, loadKg: null, rpe: null }]), 'lb')).toBe('')
  })
})
