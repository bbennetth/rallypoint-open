import { describe, it, expect } from 'vitest'
import { normalizeForDedup, planExercisePromotion, type PromotableExercise } from './submission-promote.js'

const exercise: PromotableExercise = {
  name: 'Cable Face Pull',
  discipline: 'cable',
  movementPattern: 'horizontal_pull',
  metricShape: 'load_reps',
  unilateral: false,
  muscles: [{ muscleId: 'delts', role: 'primary' }],
}

describe('normalizeForDedup', () => {
  it('lowercases and collapses internal whitespace', () => {
    expect(normalizeForDedup('  Back   Squat ')).toBe('back squat')
  })

  it('treats differently-cased/spaced names as equal', () => {
    expect(normalizeForDedup('Back Squat')).toBe(normalizeForDedup('back   squat'))
  })
})

describe('planExercisePromotion', () => {
  it('produces a create payload when no existing global exercise matches', () => {
    const result = planExercisePromotion(exercise, null)
    expect(result.kind).toBe('create')
    if (result.kind === 'create') {
      expect(result.payload).toEqual({
        name: exercise.name,
        discipline: exercise.discipline,
        movementPattern: exercise.movementPattern,
        metricShape: exercise.metricShape,
        unilateral: exercise.unilateral,
        muscles: exercise.muscles,
      })
    }
  })

  it('signals a duplicate and links to the existing id instead of creating', () => {
    const result = planExercisePromotion(exercise, 'fx_existing123')
    expect(result).toEqual({ kind: 'duplicate', existingGlobalExerciseId: 'fx_existing123' })
  })
})
