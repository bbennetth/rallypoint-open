// Pure live-session reducer for the WOD logger. The React layer wraps this
// in `useReducer` + a `useEffect`-driven 100ms tick; everything load-bearing
// (movement-check split stamping, round transitions, AMRAP auto-finish, DNF
// on FT cap, EMOM interval scoring) is modelled here so it can be unit-tested
// without a DOM.
//
// Model (Ink handoff, live.jsx): a WOD session is a list of rounds, each a
// checklist of movements. Tapping a movement stamps its split at the current
// elapsed time; completing every applicable movement in the active round
// stamps the round split and advances. There is no per-rep counting — undo is
// re-tapping a checked movement in the still-active round.
//
// This engine drives the CHECKLIST/TIMED types: for_time, rounds_for_time,
// amrap, and emom (plus for_time modifiers: cumulative ladder,
// rest-between-rounds via rounds_for_time, and the perMinuteBuyIn cue). The
// rep-ENTRY types (interval, max_reps_rounds) use wod-rep-session.ts instead —
// their score is entered reps, not a tap-to-check timer.
//
// Every action carries `nowMs` (or doesn't read time at all). The caller
// constructs the initial state via `initWodSession(input)`; neither the
// reducer nor the constructor calls Date.now() or Math.random() so the same
// action stream against the same template always produces the same state.
// `sessionId` is what the live UI uses to guard against two tabs racing on
// the same localStorage slot.

import type { WodBody, WodResult, WodType } from './wods.js'
import type { WorkoutSetInput } from './workouts.js'

// One movement inside one round of the live checklist.
export interface WodLiveMove {
  done: boolean
  // Cumulative elapsedS stamped when the movement was checked; null while
  // unchecked (and cleared again on uncheck).
  atS: number | null
  // False for movements that don't appear in this round — the cumulative
  // ladder (12 Days of Christmas) drops movement j from every round < j.
  // Non-applicable moves never render, never toggle, and don't gate round
  // completion.
  applicable: boolean
}

export interface WodLiveRound {
  // The scheme rep count for this round ("21" of 21-15-9) when the body
  // carries schemeRounds; null for fixed-ladder rounds (each movement has
  // its own reps) and for AMRAP rounds.
  targetReps: number | null
  // Cumulative elapsedS stamped when the whole round completed.
  atS: number | null
  // Parallel to body.movements.
  moves: WodLiveMove[]
}

export interface WodSessionState {
  // Shape version — bump when the persisted shape changes incompatibly.
  // restoreWodSession() rejects anything older than v3 so stale
  // localStorage blobs from an older build start fresh instead of
  // crashing the reducer. (v3: added `applicable`, `restEndsAtS`,
  // `emomIntervalsCompleted` for the benchmark-coverage expansion.
  // v4: added `removedMovements` for mid-session movement removal — v3
  // blobs migrate faithfully with an empty list.)
  v: 4
  phase: 'pre' | 'running' | 'done'
  sessionId: string
  templateId: string | null
  templateName: string
  wodType: WodType
  body: WodBody

  startedAtMs: number | null
  finishedAtMs: number | null
  elapsedS: number

  // The active (interactive) round. Earlier rounds are frozen; later
  // FT/RFT rounds are visible but not yet interactive. For AMRAP, rounds
  // append as they complete and `currentRoundIdx` always points at the
  // open one.
  currentRoundIdx: number
  rounds: WodLiveRound[]

  // Total reps credited per movement, across all rounds — credited in
  // movement-sized chunks when a movement is checked (its per-round
  // target), removed again on uncheck. Kept for the saved-result contract
  // (analytics + DNF partial credit).
  perMovementReps: number[]

  // AMRAP score state — completedRounds increases by 1 each time a round's
  // checklist completes; partialReps is the target-rep credit inside the
  // open round.
  amrapCompletedRounds: number
  amrapPartialReps: number

  // EMOM score state — number of intervals whose checklist was completed
  // within the minute before the clock rolled to the next interval.
  emomIntervalsCompleted: number

  // rounds_for_time with restBetweenRoundsS: the elapsedS at which the
  // mandatory inter-round rest ends. While non-null and in the future the
  // next round is visible but not yet tappable (Barbara). null = not resting.
  restEndsAtS: number | null

  // Movement indices removed mid-session (equipment gone, movement
  // aborted): inapplicable in the current + all future rounds, while
  // frozen past rounds keep their history and credited reps. A plain
  // sorted array (not a Set) so JSON serialization stays trivial.
  removedMovements: number[]

  // For_time / RFT / EMOM: stamped on `done` so the UI can render "DNF" vs a
  // finished time. Always false on AMRAPs.
  dnf: boolean
}

export type WodSessionAction =
  | { type: 'START'; nowMs: number }
  | { type: 'TICK'; nowMs: number }
  | { type: 'TOGGLE_MOVEMENT'; roundIdx: number; movementIdx: number }
  | { type: 'REMOVE_MOVEMENT'; movementIdx: number }
  | { type: 'NEXT_ROUND' }
  | { type: 'FINISH'; nowMs: number }

export interface InitWodSessionInput {
  templateId: string | null
  templateName: string
  body: WodBody
  sessionId: string
}

// The number of live rounds a body expands to.
function totalRoundsFor(body: WodBody): number {
  switch (body.wodType) {
    case 'amrap':
      return 1
    case 'emom':
      return body.totalIntervals
    case 'interval':
    case 'max_reps_rounds':
      // These run on the rep-entry engine; a defensive default keeps the
      // checklist reducer total-agnostic if it's ever handed one.
      return body.rounds
    case 'for_time':
      if (body.ladder === 'cumulative') return body.movements.length
      return body.schemeRounds?.length ?? body.rounds
    case 'rounds_for_time':
      return body.schemeRounds?.length ?? body.rounds
  }
}

// Whether movement `movementIdx` is performed in round `roundIdx`. Only the
// cumulative ladder drops movements from early rounds; every other type runs
// the full movement list every round.
function isMovementApplicable(
  body: WodBody,
  roundIdx: number,
  movementIdx: number,
): boolean {
  if (body.wodType === 'for_time' && body.ladder === 'cumulative') {
    return movementIdx <= roundIdx
  }
  return true
}

// The target rep count for one movement in one round. For
// schemeRounds-bearing WODs (Fran, Annie) the count comes from
// `schemeRounds[roundIdx]` and applies to every movement; for a fixed-ladder
// or cumulative WOD (Helen, 12 Days) it's the movement's own `reps`. A
// movement with neither is treated as "1 unit" so a distance entry like a
// 400m run still counts.
export function movementTargetReps(
  body: WodBody,
  roundIdx: number,
  movementIdx: number,
): number {
  const m = body.movements[movementIdx]
  if (m === undefined) return 1
  if (
    (body.wodType === 'for_time' || body.wodType === 'rounds_for_time') &&
    body.schemeRounds
  ) {
    return body.schemeRounds[roundIdx] ?? 1
  }
  return m.reps ?? 1
}

// Total target reps in one round — counts only applicable movements so a
// cumulative-ladder round header reflects the reps actually performed. Used
// for the round header on fixed-ladder rounds. `removed` excludes movements
// dropped mid-session so headers reflect the checklist actually remaining.
export function roundTotalReps(
  body: WodBody,
  roundIdx: number,
  removed?: ReadonlyArray<number>,
): number {
  return body.movements.reduce(
    (sum, _m, i) =>
      sum +
      (isMovementApplicable(body, roundIdx, i) && !removed?.includes(i)
        ? movementTargetReps(body, roundIdx, i)
        : 0),
    0,
  )
}

function schemeTargetForRound(body: WodBody, roundIdx: number): number | null {
  if (
    (body.wodType === 'for_time' || body.wodType === 'rounds_for_time') &&
    body.schemeRounds
  ) {
    return body.schemeRounds[roundIdx] ?? null
  }
  return null
}

function makeRound(
  body: WodBody,
  roundIdx: number,
  removed: ReadonlyArray<number> = [],
): WodLiveRound {
  return {
    targetReps: schemeTargetForRound(body, roundIdx),
    atS: null,
    moves: body.movements.map((_m, mi) => ({
      done: false,
      atS: null,
      applicable: isMovementApplicable(body, roundIdx, mi) && !removed.includes(mi),
    })),
  }
}

// A round is complete when every APPLICABLE movement is checked.
function roundIsComplete(moves: WodLiveMove[]): boolean {
  return moves.every((m) => !m.applicable || m.done)
}

export function initWodSession(input: InitWodSessionInput): WodSessionState {
  const body = input.body
  const totalRounds = totalRoundsFor(body)
  return {
    v: 4,
    phase: 'pre',
    sessionId: input.sessionId,
    templateId: input.templateId,
    templateName: input.templateName,
    wodType: body.wodType,
    body,
    startedAtMs: null,
    finishedAtMs: null,
    elapsedS: 0,
    currentRoundIdx: 0,
    rounds: Array.from({ length: totalRounds }, (_x, r) => makeRound(body, r)),
    perMovementReps: new Array(body.movements.length).fill(0),
    amrapCompletedRounds: 0,
    amrapPartialReps: 0,
    emomIntervalsCompleted: 0,
    restEndsAtS: null,
    removedMovements: [],
    dnf: false,
  }
}

function buildResult(s: WodSessionState, dnf: boolean): WodResult {
  if (s.body.wodType === 'amrap') {
    // Sum the credited reps rather than completedRounds × round-total: a
    // movement removed mid-session makes rounds heterogeneous, and the
    // per-movement credits are the ground truth either way (identical to
    // the old formula when nothing was removed).
    const total = s.perMovementReps.reduce((a, b) => a + b, 0)
    return {
      wodType: 'amrap',
      templateId: s.templateId,
      templateName: s.templateName,
      completedRounds: s.amrapCompletedRounds,
      partialReps: s.amrapPartialReps,
      totalReps: total,
      perMovementReps: [...s.perMovementReps],
      asPrescribed: true,
    }
  }
  if (s.body.wodType === 'emom') {
    return {
      wodType: 'emom',
      templateId: s.templateId,
      templateName: s.templateName,
      intervalsCompleted: s.emomIntervalsCompleted,
      totalIntervals: s.body.totalIntervals,
      dnf,
      perMovementReps: [...s.perMovementReps],
      asPrescribed: true,
    }
  }
  // For Time / RFT. Splits are derived straight from the live rounds model —
  // sparse per round (null = round never completed, i.e. still open at DNF),
  // keyed `${round}_${movement}` per checked movement.
  const roundSplits = s.rounds.map((r) => r.atS)
  const movementSplits: Record<string, number> = {}
  s.rounds.forEach((r, ri) => {
    r.moves.forEach((m, mi) => {
      if (m.done && m.atS !== null) movementSplits[`${ri}_${mi}`] = m.atS
    })
  })
  const wodType: 'for_time' | 'rounds_for_time' =
    s.body.wodType === 'rounds_for_time' ? 'rounds_for_time' : 'for_time'
  return {
    wodType,
    templateId: s.templateId,
    templateName: s.templateName,
    timeS: dnf ? null : s.elapsedS,
    dnf,
    perMovementReps: [...s.perMovementReps],
    asPrescribed: true,
    roundSplits,
    movementSplits,
  }
}

// Shared For-Time/RFT transition once the active round's checklist is full:
// finish the WOD on the last round, otherwise advance — arming the
// rounds_for_time inter-round rest gate (Barbara) when prescribed. The caller
// has already stamped the round split into `nextRounds`.
function advanceAfterRoundComplete(
  s: WodSessionState,
  nextRounds: WodLiveRound[],
  nextPer: number[],
  roundIdx: number,
): WodSessionState {
  if (roundIdx >= s.rounds.length - 1) {
    return {
      ...s,
      rounds: nextRounds,
      perMovementReps: nextPer,
      phase: 'done',
      finishedAtMs:
        s.startedAtMs !== null ? s.startedAtMs + s.elapsedS * 1000 : null,
      dnf: false,
    }
  }
  const restS =
    s.body.wodType === 'rounds_for_time' ? s.body.restBetweenRoundsS : undefined
  return {
    ...s,
    rounds: nextRounds,
    perMovementReps: nextPer,
    currentRoundIdx: roundIdx + 1,
    restEndsAtS: restS ? s.elapsedS + restS : null,
  }
}

// AMRAP round wrap: the caller has already stamped the completed round's
// split and updated reps — bank the round, append a fresh open round
// (honoring mid-session removals) and move the cursor onto it. Shared by
// TOGGLE_MOVEMENT and REMOVE_MOVEMENT's completion cascade.
function wrapAmrapRound(s: WodSessionState): WodSessionState {
  return {
    ...s,
    rounds: [...s.rounds, makeRound(s.body, 0, s.removedMovements)],
    amrapCompletedRounds: s.amrapCompletedRounds + 1,
    amrapPartialReps: 0,
    currentRoundIdx: s.currentRoundIdx + 1,
  }
}

export function wodSessionReducer(
  s: WodSessionState,
  a: WodSessionAction,
): WodSessionState {
  switch (a.type) {
    case 'START': {
      if (s.phase !== 'pre') return s
      return { ...s, phase: 'running', startedAtMs: a.nowMs, elapsedS: 0 }
    }

    case 'TICK': {
      if (s.phase !== 'running' || s.startedAtMs === null) return s
      // Monotonic guard: a backward clock jitter (system clock correction,
      // tab resume after sleep with a skewed timer) must never rewind the
      // elapsed clock — clamp to the last known elapsedS rather than 0.
      const computedElapsedS = Math.floor((a.nowMs - s.startedAtMs) / 1000)
      const elapsedS = Math.max(s.elapsedS, computedElapsedS, 0)

      // AMRAP auto-finishes at durationS.
      if (s.body.wodType === 'amrap' && elapsedS >= s.body.durationS) {
        return {
          ...s,
          elapsedS: s.body.durationS,
          phase: 'done',
          finishedAtMs: a.nowMs,
        }
      }

      // EMOM: at each minute boundary, the active interval either was
      // completed in time (advance + credit) or the athlete fell behind
      // (stop, DNF, score = intervals completed).
      if (s.body.wodType === 'emom') {
        // A resumed/backgrounded tab can jump the clock across several
        // interval boundaries in one tick — process each crossed boundary in
        // order so a skipped interval DNFs at the FIRST miss, not one tick
        // later against a round the athlete never got to attempt.
        const interval = Math.floor(elapsedS / s.body.intervalS)
        let roundIdx = s.currentRoundIdx
        let completed = s.emomIntervalsCompleted
        while (interval > roundIdx) {
          const active = s.rounds[roundIdx]
          const done = active !== undefined && roundIsComplete(active.moves)
          if (!done) {
            return {
              ...s,
              elapsedS,
              currentRoundIdx: roundIdx,
              emomIntervalsCompleted: completed,
              phase: 'done',
              finishedAtMs: a.nowMs,
              dnf: true,
            }
          }
          completed += 1
          if (roundIdx >= s.body.totalIntervals - 1) {
            return {
              ...s,
              elapsedS,
              currentRoundIdx: roundIdx,
              phase: 'done',
              finishedAtMs: a.nowMs,
              emomIntervalsCompleted: completed,
              dnf: false,
            }
          }
          roundIdx += 1
        }
        if (roundIdx !== s.currentRoundIdx) {
          return {
            ...s,
            elapsedS,
            currentRoundIdx: roundIdx,
            emomIntervalsCompleted: completed,
          }
        }
        return { ...s, elapsedS }
      }

      // rounds_for_time rest gate: clear once the inter-round rest elapses.
      if (s.restEndsAtS !== null && elapsedS >= s.restEndsAtS) {
        return { ...s, elapsedS, restEndsAtS: null }
      }
      return { ...s, elapsedS }
    }

    case 'TOGGLE_MOVEMENT': {
      if (s.phase !== 'running') return s
      // Only the active round is interactive — earlier rounds are frozen
      // (their splits are history), later rounds aren't reachable yet.
      if (a.roundIdx !== s.currentRoundIdx) return s
      // Blocked while resting between rounds (Barbara).
      if (s.restEndsAtS !== null) return s
      const round = s.rounds[a.roundIdx]
      const move = round?.moves[a.movementIdx]
      if (round === undefined || move === undefined) return s
      // Non-applicable movements (dropped cumulative-ladder rungs) never toggle.
      if (!move.applicable) return s

      const target = movementTargetReps(s.body, a.roundIdx, a.movementIdx)
      const nowDone = !move.done
      const nextMoves = round.moves.map((m, i) =>
        i === a.movementIdx
          ? { ...m, done: nowDone, atS: nowDone ? s.elapsedS : null }
          : m,
      )
      const nextPer = [...s.perMovementReps]
      nextPer[a.movementIdx] = Math.max(
        0,
        (nextPer[a.movementIdx] ?? 0) + (nowDone ? target : -target),
      )

      const roundComplete = roundIsComplete(nextMoves)
      const nextRounds = s.rounds.map((r, i) =>
        i === a.roundIdx
          ? { ...r, moves: nextMoves, atS: roundComplete ? s.elapsedS : null }
          : r,
      )

      // EMOM: completing a round early just banks it and waits for the minute
      // boundary (handled in TICK). Never advance or finish on toggle.
      if (s.body.wodType === 'emom') {
        return { ...s, rounds: nextRounds, perMovementReps: nextPer }
      }

      if (s.body.wodType === 'amrap') {
        const nextPartial = Math.max(
          0,
          s.amrapPartialReps + (nowDone ? target : -target),
        )
        if (!roundComplete) {
          return {
            ...s,
            rounds: nextRounds,
            perMovementReps: nextPer,
            amrapPartialReps: nextPartial,
          }
        }
        // Round wraps — append a fresh open round and keep going until the
        // timer fires.
        return wrapAmrapRound({
          ...s,
          rounds: nextRounds,
          perMovementReps: nextPer,
        })
      }

      // For Time / RFT.
      if (!roundComplete) {
        return { ...s, rounds: nextRounds, perMovementReps: nextPer }
      }
      return advanceAfterRoundComplete(s, nextRounds, nextPer, a.roundIdx)
    }

    case 'REMOVE_MOVEMENT': {
      // Drop a movement for the rest of the session (equipment gone,
      // movement aborted). Frozen past rounds keep their history and
      // credited reps verbatim; the current + all future rounds mark the
      // movement inapplicable so it stops gating completion and crediting
      // reps. Allowed during the Barbara rest gate — it's a session edit,
      // not work, and no cascade can fire there (the gated round has no
      // checked moves yet).
      if (s.phase !== 'running') return s
      const mi = a.movementIdx
      if (mi < 0 || mi >= s.body.movements.length) return s
      if (s.removedMovements.includes(mi)) return s
      // Every current/future round must keep at least one applicable
      // movement (parallel to strength's blocks.length > 1). Checked
      // against the STORED flags so it composes with cumulative-ladder
      // rounds that already dropped movements.
      for (let r = s.currentRoundIdx; r < s.rounds.length; r++) {
        const round = s.rounds[r]
        if (round === undefined) continue
        if (round.moves.filter((m, i) => m.applicable && i !== mi).length < 1) {
          return s
        }
      }
      const nextRemoved = [...s.removedMovements, mi].sort((x, y) => x - y)

      // Revoke the current round's credit if the movement was already
      // checked there (mirrors TOGGLE_MOVEMENT's uncheck branch).
      const cur = s.rounds[s.currentRoundIdx]
      const wasDoneInCurrent = cur?.moves[mi]?.done === true
      const target = movementTargetReps(s.body, s.currentRoundIdx, mi)
      const nextPer = [...s.perMovementReps]
      if (wasDoneInCurrent) {
        nextPer[mi] = Math.max(0, (nextPer[mi] ?? 0) - target)
      }
      const nextPartial =
        s.body.wodType === 'amrap' && wasDoneInCurrent
          ? Math.max(0, s.amrapPartialReps - target)
          : s.amrapPartialReps

      const roundIdx = s.currentRoundIdx
      const nextRounds = s.rounds.map((r, ri) =>
        ri < roundIdx
          ? r
          : {
              ...r,
              moves: r.moves.map((m, i) =>
                i === mi ? { ...m, done: false, atS: null, applicable: false } : m,
              ),
            },
      )

      const base: WodSessionState = {
        ...s,
        rounds: nextRounds,
        perMovementReps: nextPer,
        amrapPartialReps: nextPartial,
        removedMovements: nextRemoved,
      }

      // Completion cascade: removing the last unchecked applicable
      // movement completes the round exactly as a completing tap would.
      const active = nextRounds[roundIdx]
      if (active === undefined || !roundIsComplete(active.moves)) return base
      const stamped = nextRounds.map((r, i) =>
        i === roundIdx ? { ...r, atS: s.elapsedS } : r,
      )
      // EMOM: completing a round early just banks it and waits for the
      // minute boundary (handled in TICK) — same as TOGGLE_MOVEMENT.
      if (s.body.wodType === 'emom') {
        return { ...base, rounds: stamped }
      }
      if (s.body.wodType === 'amrap') {
        return wrapAmrapRound({ ...base, rounds: stamped })
      }
      return advanceAfterRoundComplete(base, stamped, nextPer, roundIdx)
    }

    case 'NEXT_ROUND': {
      if (s.phase !== 'running') return s
      // FT/RFT only — an AMRAP's open round is always the last one, and an
      // EMOM advances on the clock.
      if (s.body.wodType === 'amrap' || s.body.wodType === 'emom') return s
      // Blocked while resting between rounds, same as movement taps — the
      // next round hasn't started yet, so there's nothing to complete.
      if (s.restEndsAtS !== null) return s
      const roundIdx = s.currentRoundIdx
      const round = s.rounds[roundIdx]
      if (round === undefined) return s
      // Complete the active round: check every remaining applicable movement
      // at the current elapsed, credit its target reps, stamp the round
      // split, then take the normal round-complete transition (rest gate /
      // advance / finish on the last round).
      const nextPer = [...s.perMovementReps]
      const nextMoves = round.moves.map((m, mi) => {
        if (!m.applicable || m.done) return m
        nextPer[mi] =
          (nextPer[mi] ?? 0) + movementTargetReps(s.body, roundIdx, mi)
        return { ...m, done: true, atS: s.elapsedS }
      })
      const nextRounds = s.rounds.map((r, i) =>
        i === roundIdx ? { ...r, moves: nextMoves, atS: s.elapsedS } : r,
      )
      return advanceAfterRoundComplete(s, nextRounds, nextPer, roundIdx)
    }

    case 'FINISH': {
      if (s.phase === 'done') return s
      if (s.phase === 'pre') {
        // Abandoned before starting; treat as a no-op so the page can route
        // back to the library without dirtying history.
        return s
      }
      // EMOM: banking the active interval on finish means an athlete who
      // completes the final interval and hits Finish (rather than waiting out
      // the last minute) still gets credit for it. Not-DNF only when every
      // interval was banked.
      if (s.body.wodType === 'emom') {
        const active = s.rounds[s.currentRoundIdx]
        const bankCurrent = active !== undefined && roundIsComplete(active.moves)
        const completed = s.emomIntervalsCompleted + (bankCurrent ? 1 : 0)
        return {
          ...s,
          phase: 'done',
          finishedAtMs: a.nowMs,
          emomIntervalsCompleted: completed,
          dnf: completed < s.body.totalIntervals,
        }
      }
      // For_time / RFT: hitting FINISH while running = DNF.
      // AMRAP: hitting FINISH while running = early stop (counts as a
      // normal finish at the current elapsed; score uses the partial reps).
      const dnf = s.body.wodType !== 'amrap'
      return { ...s, phase: 'done', finishedAtMs: a.nowMs, dnf }
    }
  }
}

// Snapshot the score JSON to stuff in `workouts.payload` on finish.
export function wodResultFromState(s: WodSessionState): WodResult | null {
  if (s.phase !== 'done') return null
  return buildResult(s, s.dnf)
}

// Project the per-movement rep totals of a finished WOD onto
// `workout_sets` rows — one aggregate row per movement — so history and
// the volume/PR insights see WOD work, not just strength sets.
// `perMovementReps` is index-aligned with `body.movements` (the reducer
// maintains that invariant); zero-rep movements are skipped so a DNF at
// movement 1 doesn't write empty rows for the rest of the ladder.
// `warmupMovementIdxs` marks movements the athlete flagged as warm-up
// work (the live page's per-movement "W" toggle): their aggregate rows
// save with setType 'warmup' so volume/PR insights skip them.
export function wodSetsFromResult(
  body: WodBody,
  perMovementReps: number[],
  warmupMovementIdxs?: ReadonlySet<number>,
): WorkoutSetInput[] {
  const out: WorkoutSetInput[] = []
  body.movements.forEach((m, i) => {
    const reps = perMovementReps[i] ?? 0
    if (!Number.isFinite(reps) || reps <= 0) return
    const set: WorkoutSetInput = {
      exerciseId: m.exerciseId,
      setIndex: out.length,
      reps: Math.round(reps),
    }
    if (m.loadKg != null) set.loadKg = m.loadKg
    if (warmupMovementIdxs?.has(i)) set.setType = 'warmup'
    out.push(set)
  })
  return out
}

// localStorage persistence helpers — JSON-stringify-safe shape, no Date
// objects. The live page calls these on every state change (debounced).

// 24-hour hard staleness on persisted live sessions. Past this age a
// resumed session is more likely to be a forgotten state from a
// previous user on a shared browser than an in-progress workout the
// current user wants to keep. Used by both engines' restore branches
// and ResumeSessionPill. Exported separately so the threshold lives
// in one place and tests can pin nowMs deterministically.
export const LIVE_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000

export function isLiveSessionStale(
  startedAtMs: number | null,
  finishedAtMs: number | null,
  nowMs: number,
): boolean {
  // Prefer finishedAtMs (done sessions) since `startedAtMs` keeps
  // ticking forward through a long workout; fall back to startedAtMs
  // for running sessions. If neither is set (a never-started 'pre'
  // session), treat as fresh so the user can hit Start without a
  // surprise drop.
  const anchor = finishedAtMs ?? startedAtMs
  if (anchor == null) return false
  return nowMs - anchor > LIVE_SESSION_MAX_AGE_MS
}

export function serializeWodSession(s: WodSessionState): string {
  return JSON.stringify(s)
}

// Returns null when the JSON is malformed or the shape doesn't match what
// we expect — the caller deletes the localStorage slot in that case. The
// version gate deliberately drops pre-v3 blobs (older shapes without the
// applicable/rest/emom fields); they can't be mapped onto the current
// checklist model faithfully. v3 blobs migrate in place (see below).
// Per-element checks for one live round: every move must carry a boolean
// `done`, a boolean `applicable`, and an `atS` that's either null or a
// finite, non-negative number. A crafted/corrupted blob with Infinity/NaN
// in `atS` (or a wrong-type field) would poison downstream split/duration
// math (buildResult, round headers) if it slipped through.
function isValidLiveMove(m: unknown): m is WodLiveMove {
  if (typeof m !== 'object' || m === null) return false
  const move = m as Partial<WodLiveMove>
  if (typeof move.done !== 'boolean') return false
  if (typeof move.applicable !== 'boolean') return false
  if (move.atS !== null && (!Number.isFinite(move.atS) || (move.atS as number) < 0)) {
    return false
  }
  return true
}

function isValidLiveRound(r: unknown): r is WodLiveRound {
  if (typeof r !== 'object' || r === null) return false
  const round = r as Partial<WodLiveRound>
  if (
    round.targetReps !== null &&
    (!Number.isFinite(round.targetReps) || (round.targetReps as number) < 0)
  ) {
    return false
  }
  if (round.atS !== null && (!Number.isFinite(round.atS) || (round.atS as number) < 0)) {
    return false
  }
  if (!Array.isArray(round.moves) || !round.moves.every(isValidLiveMove)) return false
  return true
}

export function restoreWodSession(raw: string): WodSessionState | null {
  try {
    const parsed = JSON.parse(raw) as Omit<Partial<WodSessionState>, 'v'> & {
      body?: WodBody
      v?: number
    }
    // v3 blobs map onto the v4 shape faithfully — nothing was removed in a
    // v3 session, so an empty removedMovements is exact, not a guess.
    // (Pre-v3 blobs stay rejected: their shapes genuinely can't be mapped.)
    if (parsed.v === 3) {
      parsed.v = 4
      parsed.removedMovements = []
    }
    if (
      parsed.v !== 4 ||
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.templateName !== 'string' ||
      typeof parsed.wodType !== 'string' ||
      !parsed.body ||
      !Array.isArray(parsed.rounds) ||
      !parsed.rounds.every(isValidLiveRound) ||
      !Array.isArray(parsed.perMovementReps) ||
      !parsed.perMovementReps.every((n) => Number.isFinite(n) && n >= 0) ||
      !Array.isArray(parsed.removedMovements) ||
      !parsed.removedMovements.every((n) => Number.isInteger(n) && n >= 0) ||
      (parsed.elapsedS !== undefined &&
        (!Number.isFinite(parsed.elapsedS) || parsed.elapsedS < 0)) ||
      (parsed.amrapCompletedRounds !== undefined &&
        (!Number.isFinite(parsed.amrapCompletedRounds) || parsed.amrapCompletedRounds < 0)) ||
      (parsed.amrapPartialReps !== undefined &&
        (!Number.isFinite(parsed.amrapPartialReps) || parsed.amrapPartialReps < 0)) ||
      (parsed.emomIntervalsCompleted !== undefined &&
        (!Number.isFinite(parsed.emomIntervalsCompleted) ||
          parsed.emomIntervalsCompleted < 0)) ||
      (parsed.restEndsAtS !== null &&
        parsed.restEndsAtS !== undefined &&
        !Number.isFinite(parsed.restEndsAtS))
    ) {
      return null
    }
    return parsed as WodSessionState
  } catch {
    return null
  }
}
