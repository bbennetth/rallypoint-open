import type { Discipline, MetricShape, MovementPattern } from '@rallypoint/fitness-shared'
import type { ExerciseMuscleMap, NewGlobalExercise } from '../repos/types.js'

// Pure logic for turning an approved submission's custom exercise into a
// curated-global create payload. No DB access here — the caller
// (services/submission-review.ts) resolves the "does a global exercise
// with this name already exist?" question via the repo and passes the
// answer in, so this stays a plain, easily-unit-tested function.

export interface PromotableExercise {
  name: string
  discipline: Discipline
  movementPattern: MovementPattern
  metricShape: MetricShape
  unilateral: boolean
  muscles: ExerciseMuscleMap[]
}

export type PromoteExerciseResult =
  | { kind: 'create'; payload: Omit<NewGlobalExercise, 'id'> }
  | { kind: 'duplicate'; existingGlobalExerciseId: string }

// Case/whitespace-normalized name match — same normalization
// (@rallypoint/fitness-shared normalizeExerciseName) the create-custom
// route already applies, so "Back Squat" and "back   squat" collide here
// exactly the way they'd collide in the DB's `lower(name)` unique index.
export function normalizeForDedup(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

// `existingGlobalExerciseId` is the id of a global exercise whose
// normalized name already matches `exercise.name`, or null when none
// exists. Returns a 'duplicate' signal (never throws) so the caller can
// link the submission to the existing row instead of creating a second
// one with the same name.
export function planExercisePromotion(
  exercise: PromotableExercise,
  existingGlobalExerciseId: string | null,
): PromoteExerciseResult {
  if (existingGlobalExerciseId) {
    return { kind: 'duplicate', existingGlobalExerciseId }
  }
  return {
    kind: 'create',
    payload: {
      name: exercise.name,
      discipline: exercise.discipline,
      movementPattern: exercise.movementPattern,
      metricShape: exercise.metricShape,
      unilateral: exercise.unilateral,
      muscles: exercise.muscles,
    },
  }
}
