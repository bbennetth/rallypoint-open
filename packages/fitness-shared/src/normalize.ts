// Exercise-name normalization for the catalog's find-or-create dedup. The
// DB enforces uniqueness on lower(name); this collapses the cosmetic
// variation that lower() alone wouldn't ("Back  Squat " vs "back squat")
// BEFORE the lookup/insert so callers don't create near-duplicate rows.
//
// Deliberately conservative: trim, collapse internal whitespace runs to a
// single space, and strip nothing else (punctuation in names like
// "Farmer's Carry" or "21s" is meaningful). Casing is preserved for display
// — only the uniqueness comparison is case-insensitive (via lower() in the
// index + matchesNormalized below).

export function normalizeExerciseName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}

// True when two raw names collide under the catalog's uniqueness rule
// (normalized + case-folded). Used by the find-or-create pre-check.
export function namesMatch(a: string, b: string): boolean {
  return normalizeExerciseName(a).toLowerCase() === normalizeExerciseName(b).toLowerCase()
}
