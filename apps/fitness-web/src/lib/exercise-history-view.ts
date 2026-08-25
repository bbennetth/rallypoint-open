// Pure display helpers for the in-workout exercise-history surface (the
// inline "LAST · …" hint under each block header + the history drawer).
// Formatting only — no fetching, no state — so it's trivially unit-tested.

import { kgToDisplay, formatLoad, type WeightUnit } from './units.js'
import type { ExerciseHistorySession, ExerciseHistorySet } from '@rallypoint/fitness-shared'

// One set for the drawer's per-session list: "8 × 155 lb", "5 × BW",
// "12" (reps, no load), or "155 lb" (load, no reps). A recorded RPE is
// appended as " @8".
export function formatHistorySet(set: ExerciseHistorySet, unit: WeightUnit): string {
  const load =
    set.loadKg == null ? null : set.loadKg > 0 ? formatLoad(set.loadKg, unit) : 'BW'
  let out: string
  if (set.reps != null && load != null) out = `${set.reps} × ${load}`
  else if (set.reps != null) out = String(set.reps)
  else if (load != null) out = load
  else out = '—'
  if (set.rpe != null) out += ` @${set.rpe}`
  return out
}

// Compact single-line summary of a session's top sets for the inline hint,
// e.g. "8×155 @8, 7×150 @9 lb". Shows the unit once at the end (loaded
// sets), or bare rep counts for bodyweight-only work; a recorded RPE rides
// along per set as "@8". Returns '' when there's nothing meaningful to
// show, so callers can skip rendering the line entirely.
export function inlineHistorySummary(
  session: ExerciseHistorySession,
  unit: WeightUnit,
  maxSets = 3,
): string {
  const chunks: string[] = []
  let sawLoad = false
  for (const s of session.sets.slice(0, maxSets)) {
    let chunk: string | null = null
    if (s.loadKg != null && s.loadKg > 0) {
      const load = kgToDisplay(s.loadKg, unit)
      chunk = s.reps != null ? `${s.reps}×${load}` : `${load}`
      sawLoad = true
    } else if (s.reps != null) {
      chunk = String(s.reps)
    }
    if (chunk == null) continue
    if (s.rpe != null) chunk += ` @${s.rpe}`
    chunks.push(chunk)
  }
  if (chunks.length === 0) return ''
  return sawLoad ? `${chunks.join(', ')} ${unit}` : chunks.join(', ')
}

// "Fri 17 Jul" — short, weekday-anchored date for the history drawer.
// Falls back to the raw ISO if it can't be parsed.
export function formatSessionDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}
