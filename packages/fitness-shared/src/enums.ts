// Shared enum vocabularies for the Rallypoint Fitness exercise catalog.
// These are the SINGLE source of truth — the DB stores them as plain text
// (no CHECK constraints), validation happens here via zod, and both the
// seed generator and the API import from this module so a typo can't drift
// the catalog. Keep the `as const` arrays and the zod enums in lockstep.

import { z } from 'zod'

// Equipment/family of a movement.
export const DISCIPLINES = [
  'barbell',
  'dumbbell',
  'kettlebell',
  'bodyweight',
  'machine',
  'cable',
  'cardio',
  'gymnastics',
] as const
export type Discipline = (typeof DISCIPLINES)[number]
export const disciplineSchema = z.enum(DISCIPLINES)

// Primary movement pattern. Push/pull are split by plane so balance
// insights (slice 4) can tell a bench press from an overhead press.
export const MOVEMENT_PATTERNS = [
  'squat',
  'hinge',
  'horizontal_push',
  'vertical_push',
  'horizontal_pull',
  'vertical_pull',
  'lunge',
  'carry',
  'gait',
  'rotation',
  'core',
  'olympic',
  'isolation',
  'other',
] as const
export type MovementPattern = (typeof MOVEMENT_PATTERNS)[number]
export const movementPatternSchema = z.enum(MOVEMENT_PATTERNS)

// How a result is captured for this movement — drives the slice-2 logging
// UI so a run is never forced into a sets-and-reps form.
//   load_reps     — weight × reps (most lifting)
//   distance_time — distance + elapsed time (run/row/bike/swim)
//   rounds_reps   — rounds/reps and/or a for-time result (CrossFit metcons)
//   duration      — just elapsed time (a class, a plank, mobility)
export const METRIC_SHAPES = ['load_reps', 'distance_time', 'rounds_reps', 'duration'] as const
export type MetricShape = (typeof METRIC_SHAPES)[number]
export const metricShapeSchema = z.enum(METRIC_SHAPES)

// Role of a muscle in an exercise. The weighting drives slice-4 volume math
// (primary = full credit, secondary = half, stabilizer = none).
export const MUSCLE_ROLES = ['primary', 'secondary', 'stabilizer'] as const
export type MuscleRole = (typeof MUSCLE_ROLES)[number]
export const muscleRoleSchema = z.enum(MUSCLE_ROLES)

// Volume credit per role — referenced by slice-4 aggregation. Kept here so
// the weighting is defined once alongside the roles it weights.
export const ROLE_VOLUME_WEIGHT: Record<MuscleRole, number> = {
  primary: 1,
  secondary: 0.5,
  stabilizer: 0,
}
