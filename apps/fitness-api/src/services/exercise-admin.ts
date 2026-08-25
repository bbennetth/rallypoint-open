import { adminUpdateExerciseSchema, normalizeExerciseName } from '@rallypoint/fitness-shared'
import type { ExerciseFilter, ExerciseRecord, PatchCustomExerciseFields, Repos } from '../repos/types.js'
import { UniqueConstraintError } from '@rallypoint/api-kit'

// Admin exercise-catalog service — direct edits of curated GLOBAL rows.
// Reached only over the FITNESS service binding (admin-api gates access
// with session + ADMIN_USER_IDS); the user-facing HTTP routes never touch
// these. Same plain-marker convention as submission-review: custom Error
// instances don't survive the RPC boundary, strings do.

export async function listGlobalExercises(
  repos: Repos,
  filter: ExerciseFilter,
): Promise<ExerciseRecord[]> {
  return repos.exercises.listGlobal(filter)
}

export async function getGlobalExercise(
  repos: Repos,
  id: string,
): Promise<ExerciseRecord | null> {
  return repos.exercises.getGlobal(id)
}

export async function updateGlobalExercise(
  repos: Repos,
  id: string,
  input: unknown,
): Promise<ExerciseRecord | 'invalid' | 'name_taken' | null> {
  const parsed = adminUpdateExerciseSchema.safeParse(input)
  if (!parsed.success) return 'invalid'
  const body = parsed.data
  const fields: PatchCustomExerciseFields = {}
  if (body.name !== undefined) fields.name = normalizeExerciseName(body.name)
  if (body.discipline !== undefined) fields.discipline = body.discipline
  if (body.movementPattern !== undefined) fields.movementPattern = body.movementPattern
  if (body.metricShape !== undefined) fields.metricShape = body.metricShape
  if (body.unilateral !== undefined) fields.unilateral = body.unilateral
  if (body.muscles !== undefined) fields.muscles = body.muscles
  try {
    return await repos.exercises.patchGlobal(id, fields)
  } catch (err) {
    if (err instanceof UniqueConstraintError) return 'name_taken'
    throw err
  }
}
