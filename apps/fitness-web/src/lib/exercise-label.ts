// Resolve an exerciseId to a DISPLAY label — the id→name direction, the
// mirror of exercise-resolve.ts's name→id. Every WOD/workout surface
// renders movements from a stored `exerciseId` alone (WodMovement has no
// name field, and the wod-templates API echoes the stored body without
// joining `exercises`), so the label has to come from the cached catalog.
//
// Historically each surface string-munged the id instead — six copies of
// `id.replace(/^fx_seed_/,'').replace(/_/g,' ')`. That only reads well
// for the curated seed ids; a real catalog or custom exercise is
// `fx_<ULID>`, so the munge leaked the raw id into the UI
// ("fx 01KYA7RAF4GS4RE8AG9ZJSP6X4"). This module is the single
// implementation, and its fallback can no longer emit an id.

import type { ExerciseDto } from '@rallypoint/fitness-shared'

// Only synthesized `fx_seed_<slug>` ids are safe to munge back into a
// label. slugify() (composer-state.ts) — the sole producer of them —
// lowercases and collapses non-alnum runs to `_`, so every legitimate
// one matches this shape. Real ids are `fx_<ULID>` (uppercase Crockford
// base32, no underscores) and can never match. The trailing `+` also
// rejects the degenerate `fx_seed_` that slugify('!!!') would yield.
const SEED_SLUG_RE = /^fx_seed_[a-z0-9_]+$/

// Shown when an id resolves to nothing and carries no recoverable slug.
// Neutral on purpose: a generic noun reads as a movement we can't name,
// whereas the raw id reads as a bug (because it was one).
const FALLBACK_LABEL = 'Exercise'

/** Best-effort label for an id with no catalog entry. Decodes the legacy
 *  synthesized `fx_seed_<slug>` ids; anything else — notably a real
 *  `fx_<ULID>` — yields the neutral fallback, never the id itself. */
export function slugLabelFromId(exerciseId: string): string {
  if (!SEED_SLUG_RE.test(exerciseId)) return FALLBACK_LABEL
  return exerciseId
    .slice('fx_seed_'.length)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Display label for a movement's exerciseId. The catalog name always
 *  wins, so a renamed seed exercise shows its current name rather than
 *  the slug frozen into its id. */
export function exerciseLabel(exerciseId: string, names: ReadonlyMap<string, string>): string {
  return names.get(exerciseId) ?? slugLabelFromId(exerciseId)
}

/** Build the id→name lookup every display surface needs from a catalog
 *  read (`exercisesQuery()`). One implementation so the memo in each
 *  page stays a one-liner. */
export function buildExerciseNameMap(
  exercises: readonly Pick<ExerciseDto, 'id' | 'name'>[],
): Map<string, string> {
  const names = new Map<string, string>()
  for (const ex of exercises) names.set(ex.id, ex.name)
  return names
}
