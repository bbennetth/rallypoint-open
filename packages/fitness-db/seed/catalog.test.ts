/**
 * Seed-catalog integrity tests.
 * Run: npx vitest run packages/fitness-db/seed/catalog.test.ts
 */

import { describe, it, expect } from 'vitest'
import { seedExerciseSchema } from '@rallypoint/fitness-shared'
import { MUSCLE_IDS } from '@rallypoint/fitness-shared'
import { SEED_EXERCISES } from './catalog.js'

// Stable-id helper (mirrors generate.ts)
function stableId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `fx_seed_${slug}`
}

describe('SEED_EXERCISES catalog integrity', () => {
  it('has at least 150 rows', () => {
    expect(SEED_EXERCISES.length).toBeGreaterThanOrEqual(150)
  })

  it('every row passes seedExerciseSchema', () => {
    for (const ex of SEED_EXERCISES) {
      const result = seedExerciseSchema.safeParse(ex)
      expect(result.success, `"${ex.name}" failed: ${result.success ? '' : result.error.message}`).toBe(true)
    }
  })

  it('no duplicate names (case-insensitive)', () => {
    const names = SEED_EXERCISES.map((e) => e.name.trim().toLowerCase())
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })

  it('no duplicate stable ids', () => {
    const ids = SEED_EXERCISES.map((e) => stableId(e.name))
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })

  it('every muscleId references a known taxonomy slug', () => {
    for (const ex of SEED_EXERCISES) {
      for (const m of ex.muscles ?? []) {
        expect(MUSCLE_IDS.has(m.muscleId), `"${ex.name}" references unknown muscle "${m.muscleId}"`).toBe(true)
      }
    }
  })

  it('every non-cardio / non-class strength row has at least 1 primary muscle', () => {
    // "class" exercises are discipline=cardio + movementPattern=other (or gait+duration).
    // We allow empty muscle maps for: cardio discipline + (other|gait movementPattern).
    const cardioOther = (ex: typeof SEED_EXERCISES[number]) =>
      ex.discipline === 'cardio' && (ex.movementPattern === 'other' || ex.movementPattern === 'gait')
    // Also allow bodyweight other (Yoga, Mobility, etc.)
    const bwOther = (ex: typeof SEED_EXERCISES[number]) =>
      ex.discipline === 'bodyweight' && ex.movementPattern === 'other' && ex.metricShape === 'duration'

    for (const ex of SEED_EXERCISES) {
      if (cardioOther(ex) || bwOther(ex)) continue
      if (ex.muscles.length === 0) continue // pure cardio with no muscles listed
      const hasPrimary = ex.muscles.some((m) => m.role === 'primary')
      expect(hasPrimary, `"${ex.name}" has muscles but no primary role`).toBe(true)
    }
  })

  it('"Back Squat" exists with quads as primary', () => {
    const squat = SEED_EXERCISES.find((e) => e.name === 'Back Squat')
    expect(squat).toBeDefined()
    const quads = squat?.muscles.find((m) => m.muscleId === 'quads')
    expect(quads?.role).toBe('primary')
  })

  it('"Barbell Bench Press" has chest primary, delts secondary (collapsed taxonomy)', () => {
    const bench = SEED_EXERCISES.find((e) => e.name === 'Barbell Bench Press')
    expect(bench).toBeDefined()
    const chest = bench?.muscles.find((m) => m.muscleId === 'chest')
    const delts = bench?.muscles.find((m) => m.muscleId === 'delts')
    expect(chest?.role).toBe('primary')
    expect(delts?.role).toBe('secondary')
  })

  it('"Barbell Overhead Press" has delts primary, triceps secondary', () => {
    const ohp = SEED_EXERCISES.find((e) => e.name === 'Barbell Overhead Press')
    expect(ohp).toBeDefined()
    const delts = ohp?.muscles.find((m) => m.muscleId === 'delts')
    const tri = ohp?.muscles.find((m) => m.muscleId === 'triceps')
    expect(delts?.role).toBe('primary')
    expect(tri?.role).toBe('secondary')
  })

  it('"Dumbbell Lateral Raise" has delts primary', () => {
    const ex = SEED_EXERCISES.find((e) => e.name === 'Dumbbell Lateral Raise')
    expect(ex).toBeDefined()
    const delts = ex?.muscles.find((m) => m.muscleId === 'delts')
    expect(delts?.role).toBe('primary')
  })

  it('"Face Pull" has delts primary', () => {
    const ex = SEED_EXERCISES.find((e) => e.name === 'Face Pull')
    expect(ex).toBeDefined()
    const delts = ex?.muscles.find((m) => m.muscleId === 'delts')
    expect(delts?.role).toBe('primary')
  })

  it('no exercise lists the same muscleId twice (collapse dedupe held)', () => {
    for (const ex of SEED_EXERCISES) {
      const ids = ex.muscles.map((m) => m.muscleId)
      expect(new Set(ids).size, `"${ex.name}" has duplicate muscle ids`).toBe(ids.length)
    }
  })

  it('"Conventional Deadlift" has erectors as primary', () => {
    const ex = SEED_EXERCISES.find((e) => e.name === 'Conventional Deadlift')
    expect(ex).toBeDefined()
    const erectors = ex?.muscles.find((m) => m.muscleId === 'erectors')
    expect(erectors?.role).toBe('primary')
  })

  it('"Run" exists with discipline=cardio, metricShape=distance_time, empty muscles', () => {
    const run = SEED_EXERCISES.find((e) => e.name === 'Run')
    expect(run).toBeDefined()
    expect(run?.discipline).toBe('cardio')
    expect(run?.metricShape).toBe('distance_time')
    expect(run?.muscles).toHaveLength(0)
  })

  it('"Power Clean" has metricShape=load_reps and discipline=barbell', () => {
    const ex = SEED_EXERCISES.find((e) => e.name === 'Power Clean')
    expect(ex).toBeDefined()
    expect(ex?.metricShape).toBe('load_reps')
    expect(ex?.discipline).toBe('barbell')
  })

  it('"Double-Under" has metricShape=rounds_reps', () => {
    const ex = SEED_EXERCISES.find((e) => e.name === 'Double-Under')
    expect(ex).toBeDefined()
    expect(ex?.metricShape).toBe('rounds_reps')
  })

  it('the batch-1 boundary is frozen at 172 rows (shipped 0002 is immutable)', () => {
    // New exercises must carry seedBatch: 2 (→ 0014_seed_catalog_2.sql).
    // If this fails, a row was added without a batch marker — the
    // generator would rewrite the already-shipped 0002 migration.
    const batch1 = SEED_EXERCISES.filter((e) => (e.seedBatch ?? 1) === 1)
    expect(batch1.length).toBe(172)
  })

  it('batch 2 carries the 2026-07 top-up (incl. T-Bar Row)', () => {
    const batch2 = SEED_EXERCISES.filter((e) => e.seedBatch === 2)
    expect(batch2.length).toBeGreaterThanOrEqual(34)
    expect(batch2.map((e) => e.name)).toContain('T-Bar Row')
  })
})
