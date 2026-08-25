// Resolve free-typed exercise names to REAL catalog ids at the save/add
// boundary. Historically an unmatched name fell back to a synthesized
// `fx_seed_<slug>` id that never existed server-side, so any later
// per-exercise call (machine settings, favorites, workout-set
// validation) 404'd with "Exercise not found". Instead: match the name
// against the cached catalog, and when nothing matches, create a real
// custom exercise through the local-first API (offline it enqueues an
// `exercise:create` with a tmp id that the outbox remaps everywhere on
// drain).

import type { CreateCustomExerciseInput, ExerciseDto } from '@rallypoint/fitness-shared'
import { createExercise } from './api.js'

/** Name normalization for catalog matching: case-, whitespace- and
 *  punctuation-insensitive, so "Back  Squat" matches "back squat". */
export function normalizeExerciseName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Find a catalog exercise whose name matches `name` (normalized).
 *  Returns its id, or null when nothing matches. */
export function matchExerciseId(
  name: string,
  catalog: readonly Pick<ExerciseDto, 'id' | 'name'>[],
): string | null {
  const want = normalizeExerciseName(name)
  if (!want) return null
  for (const e of catalog) {
    if (normalizeExerciseName(e.name) === want) return e.id
  }
  return null
}

/** Neutral defaults for an auto-created free-typed movement — the user
 *  only gave us a name, so the rest is the most generic shape. They can
 *  edit the exercise in the Library later. */
export function autoCreateInput(name: string): CreateCustomExerciseInput {
  return {
    name: name.trim(),
    discipline: 'bodyweight',
    movementPattern: 'other',
    metricShape: 'load_reps',
    unilateral: false,
    muscles: [],
  }
}

/** Resolve a set of rows that may carry free-typed names without ids.
 *  Returns a name→id map covering every distinct unresolved name:
 *  catalog match first, else a real create (local-first; offline this
 *  yields a tmp id the outbox remaps on drain). Duplicate names across
 *  rows create ONE exercise. */
export async function resolveExerciseIds(
  rows: readonly { name: string; exerciseId: string | null }[],
  catalog: readonly Pick<ExerciseDto, 'id' | 'name'>[],
  create: (input: CreateCustomExerciseInput) => Promise<{ id: string }> = createExercise,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const row of rows) {
    const name = row.name.trim()
    if (!name || row.exerciseId != null) continue
    const key = normalizeExerciseName(name)
    if (!key || out.has(key)) continue
    const matched = matchExerciseId(name, catalog)
    if (matched != null) {
      out.set(key, matched)
      continue
    }
    const created = await create(autoCreateInput(name))
    out.set(key, created.id)
  }
  return out
}

/** Apply a resolved name→id map to a row: fills exerciseId for rows
 *  that lacked one. Rows whose name somehow missed resolution pass
 *  through unchanged (the save-time slug fallback still guards). */
export function withResolvedId<T extends { name: string; exerciseId: string | null }>(
  row: T,
  resolved: ReadonlyMap<string, string>,
): T {
  if (row.exerciseId != null) return row
  const id = resolved.get(normalizeExerciseName(row.name))
  return id != null ? { ...row, exerciseId: id } : row
}
