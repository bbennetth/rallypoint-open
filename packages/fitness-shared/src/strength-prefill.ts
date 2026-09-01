// Pre-fill a live strength session from the athlete's exercise history
// (feature 2026-08: "Health should pre-fill the last weight/reps
// completed for an exercise"). Pure state → state helpers: the live
// page applies them once per exercise when its lazily-fetched history
// (`getExerciseHistory`) lands, so within a mount a field the athlete
// clears stays cleared (a mid-session reload re-runs the pass, which
// only ever fills still-blank fields).
//
// Precedence contract (the load-bearing part):
//   - a set the athlete already logged (`done`) or a warmup set is
//     never touched — and because history rows are WORKING sets only
//     (recentSetsForExercise excludes warmups), sets match up by
//     working-set ordinal, not raw array index, so a leading warmup
//     doesn't shift every fill by one;
//   - loadKg fills only when null (a template 0 is a deliberate
//     bodyweight prescription), from the same working ordinal of the
//     last loaded session, falling back to that session's last loaded
//     set. When NO loaded session exists (a pure-bodyweight movement),
//     the newest session with rep work anchors instead — reps still
//     prefill, loads have nothing to fill from;
//   - reps fill only when null and the set isn't MAX (`amrapTarget`) —
//     pre-filling a MAX set would arm the check button with a count
//     the athlete never entered (see sessionFromStrengthBody);
//   - a block stamped `historyPrefill: 'override'` (template starts —
//     its prescribed numbers are a stale snapshot of an older session)
//     additionally REPLACES prescribed reps and positive loads with the
//     last session's values — but only at ordinals the history actually
//     holds: a 5-set template over a 3-set history keeps its own
//     prescriptions for sets 4-5 (the last-set fallback applies to
//     BLANK fields only, in either mode). The deliberate-bodyweight 0
//     and the MAX rep blank still hold. The directive is one-shot: any
//     pass that sees fetched history (even empty) consumes it, and any
//     athlete interaction with the block disarms it reducer-side, so a
//     late fetch or mid-session reload can't rewrite athlete edits;
//   - only rep-unit sets fill (no cardio in this slice);
//   - the block-level SUGGESTED strip (`suggestedKg`) is computed via
//     recommendLoad anchored on the session's top set, only when no
//     suggestion is already attached.

import type { ExerciseHistorySession } from './insights.js'
import type { StrengthBlock, StrengthSessionState, StrengthSet } from './strength-session.js'
import { strengthSetUnit } from './strength-session.js'
import { recommendLoad, type RecentTopSet } from './weight-rec.js'

/** First history session (callers pass groupExerciseHistory output,
 *  which is already newest-first — this does not re-sort) with at
 *  least one loaded set (loadKg > 0). Skips bodyweight-only sessions
 *  so one BW day doesn't blank a lift's prefill. Null when no session
 *  qualifies. */
export function lastLoadedSession(
  sessions: readonly ExerciseHistorySession[] | undefined,
): ExerciseHistorySession | null {
  if (!sessions) return null
  for (const s of sessions) {
    if (s.sets.some((set) => set.loadKg != null && set.loadKg > 0)) return s
  }
  return null
}

/** Newest session with any rep work — the anchor for pure-bodyweight
 *  movements (pull-ups, dips), which lastLoadedSession never matches.
 *  Rep prefill still works off it; load fill and the SUGGESTED strip
 *  naturally no-op (no loaded set to read). */
function lastRepSession(
  sessions: readonly ExerciseHistorySession[] | undefined,
): ExerciseHistorySession | null {
  if (!sessions) return null
  for (const s of sessions) {
    if (s.sets.some((set) => set.reps != null && set.reps > 0)) return s
  }
  return null
}

/** Heaviest set of a session (ties break toward more reps). Null when
 *  the session carries no loaded rep set. */
export function topSetOf(session: ExerciseHistorySession | null): RecentTopSet | null {
  if (!session) return null
  let top: RecentTopSet | null = null
  for (const s of session.sets) {
    if (s.loadKg == null || s.loadKg <= 0 || s.reps == null || s.reps <= 0) continue
    if (!top || s.loadKg > top.loadKg || (s.loadKg === top.loadKg && s.reps > top.reps)) {
      top = { reps: s.reps, loadKg: s.loadKg }
    }
  }
  return top
}

/** The positive load at exactly working ordinal `idx`, or null. */
function loadAtOrdinal(session: ExerciseHistorySession, idx: number): number | null {
  const at = session.sets[idx]?.loadKg
  return at != null && at > 0 ? at : null
}

/** History load for prefilling working ordinal `idx`: the same ordinal
 *  when it holds a positive load, else the session's last loaded set.
 *  The fallback is for BLANK fields only — override mode replaces a
 *  prescription strictly per-ordinal (loadAtOrdinal). */
function loadForIndex(session: ExerciseHistorySession, idx: number): number | null {
  const at = loadAtOrdinal(session, idx)
  if (at != null) return at
  for (let i = session.sets.length - 1; i >= 0; i -= 1) {
    const kg = session.sets[i]!.loadKg
    if (kg != null && kg > 0) return kg
  }
  return null
}

/** The positive rep count at exactly working ordinal `idx`, or null. */
function repsAtOrdinal(session: ExerciseHistorySession, idx: number): number | null {
  const at = session.sets[idx]?.reps
  return at != null && at > 0 ? at : null
}

/** Same ordinal-then-last matching for reps (any positive rep count). */
function repsForIndex(session: ExerciseHistorySession, idx: number): number | null {
  const at = repsAtOrdinal(session, idx)
  if (at != null) return at
  for (let i = session.sets.length - 1; i >= 0; i -= 1) {
    const r = session.sets[i]!.reps
    if (r != null && r > 0) return r
  }
  return null
}

/** Strip the one-shot override directive; same reference when absent. */
function consumeDirective<T extends { historyPrefill?: 'override' }>(block: T): T {
  if (block.historyPrefill == null) return block
  const next = { ...block }
  delete next.historyPrefill
  return next
}

/** Returns the block with history prefilled per the contract above, or
 *  the SAME reference when nothing changed (React identity guard).
 *  Accepts not-yet-inserted blocks too (ADD_BLOCKS payloads lack
 *  currentSetIdx), hence the generic. */
export function prefillBlockFromHistory<T extends Omit<StrengthBlock, 'currentSetIdx'>>(
  block: T,
  sessions: readonly ExerciseHistorySession[] | undefined,
): T {
  const override = block.historyPrefill === 'override'
  const last = lastLoadedSession(sessions) ?? lastRepSession(sessions)
  if (!last) {
    // Fetched history with nothing to anchor on still consumes the
    // override directive — a later refetch or reload must not suddenly
    // rewrite prescriptions mid-session. An undefined `sessions` (not
    // fetched yet — the ADD_BLOCKS cache-miss path) leaves it armed.
    return sessions !== undefined ? consumeDirective(block) : block
  }

  let setsChanged = false
  // Warmup sets don't consume a working ordinal — history rows are
  // working sets only, so ordinal i lines up with the i-th non-warmup
  // set of the block (done and cardio sets still occupy theirs).
  let ordinal = -1
  const sets: StrengthSet[] = block.sets.map((s) => {
    if (s.setType === 'warmup') return s
    ordinal += 1
    if (s.done || strengthSetUnit(s) !== 'reps') return s
    let next = s
    // Override mode also replaces a prescribed positive load, but only
    // when the history actually holds this ordinal — the last-set
    // fallback fills blanks, never rewrites a prescription. The
    // deliberate-bodyweight 0 stays either way.
    if (s.loadKg == null || (override && s.loadKg !== 0)) {
      const kg = s.loadKg == null ? loadForIndex(last, ordinal) : loadAtOrdinal(last, ordinal)
      if (kg != null && kg !== s.loadKg) next = { ...next, loadKg: kg }
    }
    if ((s.reps == null || override) && s.amrapTarget !== true) {
      const reps = s.reps == null ? repsForIndex(last, ordinal) : repsAtOrdinal(last, ordinal)
      if (reps != null && reps !== next.reps) next = { ...next, reps }
    }
    if (next !== s) setsChanged = true
    return next
  })

  let suggestedKg = block.suggestedKg
  let suggestedBasis = block.suggestedBasis
  let suggestedLastKg = block.suggestedLastKg ?? null
  let suggestedBumpKg = block.suggestedBumpKg ?? null
  let suggestionChanged = false
  if (suggestedKg == null) {
    // Anchor the strip's target on the first working rep set, not
    // sets[0] — a leading warmup's (typically higher) reps would skew
    // the recommendation low. An all-MAX block has no rep target at all
    // (amrap sets keep reps blank) — fall back to the history top set's
    // own reps so max-effort work still gets a strip, suggesting the
    // load to repeat it.
    const top = topSetOf(last)
    const hasRepWork = sets.some(
      (s) => s.setType !== 'warmup' && strengthSetUnit(s) === 'reps',
    )
    const targetReps =
      sets.find((s) => s.setType !== 'warmup' && strengthSetUnit(s) === 'reps' && s.reps != null)
        ?.reps ?? (hasRepWork ? top?.reps : undefined)
    const rec = targetReps != null ? recommendLoad(targetReps, top) : null
    if (rec) {
      suggestedKg = rec.kg
      suggestedBasis = rec.basis
      suggestedLastKg = rec.lastKg
      suggestedBumpKg = rec.bumpKg
      suggestionChanged = true
    }
  }

  if (!setsChanged && !suggestionChanged) return consumeDirective(block)
  const out = {
    ...block,
    sets: setsChanged ? sets : block.sets,
    suggestedKg,
    suggestedBasis,
    suggestedLastKg,
    suggestedBumpKg,
  }
  delete out.historyPrefill
  return out
}

/** Arm the one-shot override directive on every block of a
 *  template-hydrated session. Callers must NOT arm sessions whose
 *  numbers the athlete just typed (composer Start-now / Save & start,
 *  add-sheet blocks) — for those, the prescribed values win and the
 *  prefill fills blanks only. */
export function armHistoryPrefillOverride(state: StrengthSessionState): StrengthSessionState {
  return {
    ...state,
    blocks: state.blocks.map((b) => ({ ...b, historyPrefill: 'override' as const })),
  }
}

/** Apply history to every block whose exerciseId appears in
 *  `historyByExercise`. Returns the same state reference when no block
 *  changed, so callers can setState without triggering render loops. */
export function prefillSessionFromHistory(
  state: StrengthSessionState,
  historyByExercise: Readonly<Record<string, readonly ExerciseHistorySession[]>>,
): StrengthSessionState {
  let changed = false
  const blocks = state.blocks.map((b) => {
    const sessions = historyByExercise[b.exerciseId]
    if (!sessions) return b
    const next = prefillBlockFromHistory(b, sessions)
    if (next !== b) changed = true
    return next
  })
  return changed ? { ...state, blocks } : state
}
