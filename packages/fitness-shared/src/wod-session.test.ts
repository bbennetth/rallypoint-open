import { describe, expect, it } from 'vitest'
import {
  initWodSession,
  isLiveSessionStale,
  LIVE_SESSION_MAX_AGE_MS,
  movementTargetReps,
  restoreWodSession,
  roundTotalReps,
  serializeWodSession,
  wodResultFromState,
  wodSessionReducer,
  wodSetsFromResult,
  type WodSessionAction,
  type WodSessionState,
} from './wod-session.js'
import type { WodBody } from './wods.js'

const FRAN: WodBody = {
  wodType: 'for_time',
  rounds: 1,
  schemeRounds: [21, 15, 9],
  movements: [
    { exerciseId: 'fx_seed_thruster', reps: 1, loadKg: 43 },
    { exerciseId: 'fx_seed_pull_up', reps: 1 },
  ],
}

const HELEN: WodBody = {
  wodType: 'rounds_for_time',
  rounds: 3,
  movements: [
    { exerciseId: 'fx_seed_run', distanceM: 400 },
    { exerciseId: 'fx_seed_kettlebell_swing', reps: 21, loadKg: 24 },
    { exerciseId: 'fx_seed_pull_up', reps: 12 },
  ],
}

const CINDY: WodBody = {
  wodType: 'amrap',
  durationS: 1200,
  movements: [
    { exerciseId: 'fx_seed_pull_up', reps: 5 },
    { exerciseId: 'fx_seed_push_up', reps: 10 },
    { exerciseId: 'fx_seed_air_squat', reps: 15 },
  ],
}

function start(body: WodBody): WodSessionState {
  const pre = initWodSession({
    templateId: 'wt_test',
    templateName: 'Test WOD',
    body,
    sessionId: 'ses_test',
  })
  return wodSessionReducer(pre, { type: 'START', nowMs: 0 })
}

function toggle(roundIdx: number, movementIdx: number): WodSessionAction {
  return { type: 'TOGGLE_MOVEMENT', roundIdx, movementIdx }
}

// Check every movement of the given round in order.
function completeRound(s: WodSessionState, roundIdx: number): WodSessionState {
  for (let m = 0; m < s.body.movements.length; m++) {
    s = wodSessionReducer(s, toggle(roundIdx, m))
  }
  return s
}

function runActions(
  state: WodSessionState,
  actions: WodSessionAction[],
): WodSessionState {
  return actions.reduce(wodSessionReducer, state)
}

describe('initWodSession', () => {
  it('builds one round per scheme rung with targetReps (Fran)', () => {
    const s = initWodSession({
      templateId: 'wt_fran',
      templateName: 'Fran',
      body: FRAN,
      sessionId: 'ses_abc',
    })
    expect(s.v).toBe(4)
    expect(s.phase).toBe('pre')
    expect(s.startedAtMs).toBeNull()
    expect(s.elapsedS).toBe(0)
    expect(s.currentRoundIdx).toBe(0)
    expect(s.rounds).toHaveLength(3)
    expect(s.rounds.map((r) => r.targetReps)).toEqual([21, 15, 9])
    expect(s.rounds[0]!.moves).toHaveLength(2)
    expect(s.rounds[0]!.moves.every((m) => !m.done && m.atS === null)).toBe(true)
    expect(s.rounds.every((r) => r.atS === null)).toBe(true)
    expect(s.perMovementReps).toEqual([0, 0])
    expect(s.amrapCompletedRounds).toBe(0)
    expect(s.amrapPartialReps).toBe(0)
    expect(s.dnf).toBe(false)
  })

  it('builds body.rounds rounds with null targetReps for a fixed ladder (Helen)', () => {
    const s = initWodSession({
      templateId: 'wt_helen',
      templateName: 'Helen',
      body: HELEN,
      sessionId: 'ses_abc',
    })
    expect(s.rounds).toHaveLength(3)
    expect(s.rounds.map((r) => r.targetReps)).toEqual([null, null, null])
    expect(s.rounds[0]!.moves).toHaveLength(3)
  })

  it('seeds a single open round for AMRAP (Cindy)', () => {
    const s = initWodSession({
      templateId: 'wt_cindy',
      templateName: 'Cindy',
      body: CINDY,
      sessionId: 'ses_abc',
    })
    expect(s.rounds).toHaveLength(1)
    expect(s.rounds[0]!.targetReps).toBeNull()
    expect(s.rounds[0]!.moves).toHaveLength(3)
  })
})

describe('movementTargetReps / roundTotalReps', () => {
  it('reads schemeRounds per round for ladder WODs', () => {
    expect(movementTargetReps(FRAN, 0, 0)).toBe(21)
    expect(movementTargetReps(FRAN, 1, 1)).toBe(15)
    expect(movementTargetReps(FRAN, 2, 0)).toBe(9)
    expect(roundTotalReps(FRAN, 0)).toBe(42)
    expect(roundTotalReps(FRAN, 2)).toBe(18)
  })

  it('reads per-movement reps for fixed ladders, 1 for distance entries', () => {
    expect(movementTargetReps(HELEN, 0, 0)).toBe(1) // 400m run — 1 unit
    expect(movementTargetReps(HELEN, 0, 1)).toBe(21)
    expect(movementTargetReps(HELEN, 2, 2)).toBe(12)
    expect(roundTotalReps(HELEN, 0)).toBe(34)
  })

  it('reads per-movement reps for AMRAP', () => {
    expect(movementTargetReps(CINDY, 0, 0)).toBe(5)
    expect(movementTargetReps(CINDY, 0, 2)).toBe(15)
    expect(roundTotalReps(CINDY, 0)).toBe(30)
  })
})

describe('START', () => {
  it('moves pre → running and stamps startedAtMs', () => {
    const pre = initWodSession({
      templateId: null,
      templateName: 'X',
      body: CINDY,
      sessionId: 'ses_x',
    })
    const s = wodSessionReducer(pre, { type: 'START', nowMs: 5000 })
    expect(s.phase).toBe('running')
    expect(s.startedAtMs).toBe(5000)
    expect(s.elapsedS).toBe(0)
  })

  it('is a no-op from running and done', () => {
    let s = start(CINDY)
    const before = s
    s = wodSessionReducer(s, { type: 'START', nowMs: 9999 })
    expect(s).toBe(before) // identical reference — no mutation
  })
})

describe('TICK', () => {
  it('updates elapsedS from nowMs - startedAtMs (floored)', () => {
    let s = wodSessionReducer(
      initWodSession({
        templateId: null,
        templateName: 'X',
        body: HELEN,
        sessionId: 'ses_x',
      }),
      { type: 'START', nowMs: 1000 },
    )
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 1500 })
    expect(s.elapsedS).toBe(0)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 4900 })
    expect(s.elapsedS).toBe(3)
  })

  it('AMRAP auto-finishes at durationS', () => {
    let s = start(CINDY)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 1199 * 1000 })
    expect(s.phase).toBe('running')
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 1200 * 1000 })
    expect(s.phase).toBe('done')
    expect(s.elapsedS).toBe(1200)
  })

  // A resumed tab / system clock correction can hand the reducer a
  // `nowMs` earlier than the previous tick's. Elapsed must never rewind —
  // it should hold at the last known value, not reset toward 0.
  it('is monotonic across a backward clock jitter', () => {
    let s = wodSessionReducer(
      initWodSession({
        templateId: null,
        templateName: 'X',
        body: HELEN,
        sessionId: 'ses_jitter',
      }),
      { type: 'START', nowMs: 100_000 },
    )
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 110_000 })
    expect(s.elapsedS).toBe(10)
    // Clock jumps backward relative to startedAtMs.
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 50_000 })
    expect(s.elapsedS).toBe(10)
    // Recovers normally once the clock catches back up.
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 115_000 })
    expect(s.elapsedS).toBe(15)
  })
})

describe('TOGGLE_MOVEMENT — For Time ladder (Fran)', () => {
  it('checking a movement stamps its split and credits its target reps', () => {
    let s = start(FRAN)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 45_000 })
    s = wodSessionReducer(s, toggle(0, 0)) // 21 thrusters done
    expect(s.rounds[0]!.moves[0]).toEqual({ done: true, atS: 45, applicable: true })
    expect(s.perMovementReps).toEqual([21, 0])
    expect(s.rounds[0]!.atS).toBeNull() // round not complete yet
    expect(s.currentRoundIdx).toBe(0)
    expect(s.phase).toBe('running')
  })

  it('completing every movement stamps the round split and advances', () => {
    let s = start(FRAN)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 30_000 })
    s = completeRound(s, 0)
    expect(s.rounds[0]!.atS).toBe(30)
    expect(s.currentRoundIdx).toBe(1)
    expect(s.perMovementReps).toEqual([21, 21])
    expect(s.phase).toBe('running')
  })

  it('completing the last round finishes the workout (not DNF)', () => {
    let s = start(FRAN)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 30_000 })
    s = completeRound(s, 0)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 90_000 })
    s = completeRound(s, 1)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 130_000 })
    s = completeRound(s, 2)
    expect(s.phase).toBe('done')
    expect(s.dnf).toBe(false)
    expect(s.finishedAtMs).toBe(130_000) // startedAtMs 0 + 130s
    expect(s.perMovementReps).toEqual([45, 45])
    expect(s.rounds.map((r) => r.atS)).toEqual([30, 90, 130])
  })

  it('completes Helen (3 RFT) crediting per-movement reps', () => {
    let s = start(HELEN)
    for (let r = 0; r < 3; r++) s = completeRound(s, r)
    expect(s.phase).toBe('done')
    expect(s.perMovementReps).toEqual([3, 63, 36])
  })

  it('unchecking clears the movement split, the reps, and the round split', () => {
    let s = start(FRAN)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 20_000 })
    s = wodSessionReducer(s, toggle(0, 0))
    expect(s.perMovementReps[0]).toBe(21)
    s = wodSessionReducer(s, toggle(0, 0)) // undo
    expect(s.rounds[0]!.moves[0]).toEqual({ done: false, atS: null, applicable: true })
    expect(s.perMovementReps[0]).toBe(0)
    expect(s.rounds[0]!.atS).toBeNull()
  })

  it('ignores toggles on non-active rounds (frozen history / future rounds)', () => {
    let s = start(FRAN)
    s = completeRound(s, 0)
    expect(s.currentRoundIdx).toBe(1)
    const before = s
    // Round 0 is frozen; round 2 isn't reachable yet.
    expect(wodSessionReducer(s, toggle(0, 0))).toBe(before)
    expect(wodSessionReducer(s, toggle(2, 0))).toBe(before)
  })

  it('ignores out-of-range movement indices and non-running phases', () => {
    const pre = initWodSession({
      templateId: null,
      templateName: 'X',
      body: FRAN,
      sessionId: 'ses_x',
    })
    expect(wodSessionReducer(pre, toggle(0, 0))).toBe(pre)
    const s = start(FRAN)
    expect(wodSessionReducer(s, toggle(0, 99))).toBe(s)
  })
})

describe('TOGGLE_MOVEMENT — AMRAP (Cindy)', () => {
  it('checking credits target reps to amrapPartialReps', () => {
    let s = start(CINDY)
    s = wodSessionReducer(s, toggle(0, 0)) // 5 pull-ups
    expect(s.amrapPartialReps).toBe(5)
    s = wodSessionReducer(s, toggle(0, 1)) // +10 push-ups
    expect(s.amrapPartialReps).toBe(15)
    expect(s.amrapCompletedRounds).toBe(0)
  })

  it('unchecking removes the credit', () => {
    let s = start(CINDY)
    s = wodSessionReducer(s, toggle(0, 0))
    s = wodSessionReducer(s, toggle(0, 0))
    expect(s.amrapPartialReps).toBe(0)
    expect(s.perMovementReps).toEqual([0, 0, 0])
  })

  it('a full round bumps completedRounds, resets partial, appends a fresh round', () => {
    let s = start(CINDY)
    s = completeRound(s, 0)
    expect(s.amrapCompletedRounds).toBe(1)
    expect(s.amrapPartialReps).toBe(0)
    expect(s.rounds).toHaveLength(2)
    expect(s.currentRoundIdx).toBe(1)
    expect(s.rounds[1]!.moves.every((m) => !m.done)).toBe(true)
    expect(s.phase).toBe('running')
  })

  it('3 rounds + a partial finishes as 3 + 15 at the timer', () => {
    let s = start(CINDY)
    for (let r = 0; r < 3; r++) s = completeRound(s, r)
    // 5 pull-ups + 10 push-ups into round 4 = 15 partial reps.
    s = wodSessionReducer(s, toggle(3, 0))
    s = wodSessionReducer(s, toggle(3, 1))
    expect(s.amrapCompletedRounds).toBe(3)
    expect(s.amrapPartialReps).toBe(15)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 1200 * 1000 })
    expect(s.phase).toBe('done')
    const result = wodResultFromState(s)!
    expect(result.wodType).toBe('amrap')
    if (result.wodType === 'amrap') {
      expect(result.completedRounds).toBe(3)
      expect(result.partialReps).toBe(15)
      expect(result.totalReps).toBe(3 * 30 + 15)
    }
  })
})

describe('NEXT_ROUND', () => {
  it('completes the active round: remaining movements checked, split stamped, reps credited', () => {
    let s = start(HELEN)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 10_000 })
    s = wodSessionReducer(s, toggle(0, 0)) // run done, KBS + pull-ups pending
    s = wodSessionReducer(s, { type: 'NEXT_ROUND' })
    expect(s.currentRoundIdx).toBe(1)
    expect(s.rounds[0]!.atS).toBe(10) // round split stamped
    expect(s.rounds[0]!.moves.every((m) => m.done && m.atS !== null)).toBe(true)
    expect(s.perMovementReps).toEqual([1, 21, 12]) // full round credit
  })

  it('finishes the WOD (done, not DNF) when pressed on the last round', () => {
    let s = start(HELEN)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 30_000 })
    s = wodSessionReducer(s, { type: 'NEXT_ROUND' })
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 60_000 })
    s = wodSessionReducer(s, { type: 'NEXT_ROUND' })
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 90_000 })
    s = wodSessionReducer(s, { type: 'NEXT_ROUND' })
    expect(s.phase).toBe('done')
    expect(s.dnf).toBe(false)
    const result = wodResultFromState(s)!
    expect(result.wodType).toBe('rounds_for_time')
    if (result.wodType === 'rounds_for_time') {
      expect(result.timeS).toBe(90)
      expect(result.roundSplits).toEqual([30, 60, 90])
    }
  })

  it('arms the rest gate (Barbara) and is blocked while resting', () => {
    let s = start(BARBARA)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 120_000 })
    s = wodSessionReducer(s, { type: 'NEXT_ROUND' }) // completes round 0
    expect(s.currentRoundIdx).toBe(1)
    expect(s.restEndsAtS).toBe(120 + 180)
    // Pressing again mid-rest is a no-op — round 1 hasn't started.
    const resting = s
    expect(wodSessionReducer(s, { type: 'NEXT_ROUND' })).toBe(resting)
  })

  it('only completes the applicable rungs of a cumulative-ladder round', () => {
    let s = start(XMAS)
    s = wodSessionReducer(s, { type: 'NEXT_ROUND' }) // round 0 = movement 0 only
    expect(s.currentRoundIdx).toBe(1)
    expect(s.rounds[0]!.moves.map((m) => m.done)).toEqual([true, false, false])
    expect(s.perMovementReps).toEqual([1, 0, 0])
  })

  it('is a no-op for AMRAP, EMOM, and outside running', () => {
    const amrap = start(CINDY)
    expect(wodSessionReducer(amrap, { type: 'NEXT_ROUND' })).toBe(amrap)

    const emom = start(CHELSEA)
    expect(wodSessionReducer(emom, { type: 'NEXT_ROUND' })).toBe(emom)

    const pre = initWodSession({
      templateId: null,
      templateName: 'X',
      body: HELEN,
      sessionId: 'ses_x',
    })
    expect(wodSessionReducer(pre, { type: 'NEXT_ROUND' })).toBe(pre)
  })
})

describe('FINISH', () => {
  it('For Time + still running = DNF with timeS = null and sparse splits', () => {
    let s = start(FRAN)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 25_000 })
    s = wodSessionReducer(s, toggle(0, 0)) // 21 thrusters only
    s = wodSessionReducer(s, { type: 'FINISH', nowMs: 999 * 1000 })
    expect(s.phase).toBe('done')
    expect(s.dnf).toBe(true)
    const result = wodResultFromState(s)
    expect(result?.wodType).toBe('for_time')
    if (result?.wodType === 'for_time') {
      expect(result.timeS).toBeNull()
      expect(result.dnf).toBe(true)
      expect(result.perMovementReps).toEqual([21, 0])
      expect(result.roundSplits).toEqual([null, null, null])
      expect(result.movementSplits).toEqual({ '0_0': 25 })
    }
  })

  it('AMRAP + running = early stop counted as a finish (not DNF)', () => {
    let s = start(CINDY)
    s = wodSessionReducer(s, toggle(0, 0))
    s = wodSessionReducer(s, { type: 'FINISH', nowMs: 600 * 1000 })
    expect(s.phase).toBe('done')
    expect(s.dnf).toBe(false)
    const result = wodResultFromState(s)!
    expect(result.wodType).toBe('amrap')
    if (result.wodType === 'amrap') {
      expect(result.completedRounds).toBe(0)
      expect(result.partialReps).toBe(5)
      expect(result.totalReps).toBe(5)
    }
  })

  it('FINISH from done is a no-op', () => {
    let s = start(CINDY)
    s = wodSessionReducer(s, { type: 'FINISH', nowMs: 100 })
    const before = s
    s = wodSessionReducer(s, { type: 'FINISH', nowMs: 999 })
    expect(s).toBe(before)
  })
})

describe('reducer is deterministic against an action stream', () => {
  it('two replays of the same action stream produce equal states', () => {
    const actions: WodSessionAction[] = [
      { type: 'START', nowMs: 100 },
      { type: 'TICK', nowMs: 8_000 },
      toggle(0, 0),
      toggle(0, 0),
      toggle(0, 0),
      { type: 'TICK', nowMs: 20_000 },
      toggle(0, 1),
      { type: 'NEXT_ROUND' },
      { type: 'FINISH', nowMs: 42_000 },
    ]
    const a = runActions(
      initWodSession({
        templateId: 'wt_a',
        templateName: 'A',
        body: FRAN,
        sessionId: 'ses_repro_a',
      }),
      actions,
    )
    const b = runActions(
      initWodSession({
        templateId: 'wt_a',
        templateName: 'A',
        body: FRAN,
        sessionId: 'ses_repro_a',
      }),
      actions,
    )
    expect(a).toEqual(b)
  })
})

describe('serialize / restore', () => {
  it('round-trips a mid-run state', () => {
    let s = start(HELEN)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 5000 })
    s = wodSessionReducer(s, toggle(0, 0))
    const raw = serializeWodSession(s)
    const restored = restoreWodSession(raw)
    expect(restored).toEqual(s)
  })

  // Code-review F5: previously the WOD restore branch dropped
  // `phase==='done'` rows on the floor, so a force-closed tab right
  // after the finish overlay nuked the user's recoverable result. The
  // serialize half is checked here; the page-level restore behaviour
  // is wired in WodSessionPage.tsx.
  it('round-trips a done state', () => {
    let s = start(CINDY)
    s = completeRound(s, 0)
    s = wodSessionReducer(s, { type: 'FINISH', nowMs: 600 * 1000 })
    expect(s.phase).toBe('done')
    const raw = serializeWodSession(s)
    const restored = restoreWodSession(raw)
    expect(restored).toEqual(s)
    expect(restored?.phase).toBe('done')
  })

  it('returns null on malformed JSON or wrong shape', () => {
    expect(restoreWodSession('{not json')).toBeNull()
    expect(restoreWodSession('{"foo":1}')).toBeNull()
    expect(restoreWodSession('null')).toBeNull()
  })

  it('rejects pre-v2 blobs (old per-rep model) so they start fresh', () => {
    // Shape of the retired per-rep engine: no `v`, no `rounds`, has
    // currentReps/currentMovementIdx. Must NOT restore.
    const v1 = JSON.stringify({
      phase: 'running',
      sessionId: 'ses_old',
      templateId: 'wt_old',
      templateName: 'Old',
      wodType: 'for_time',
      body: FRAN,
      startedAtMs: 0,
      finishedAtMs: null,
      elapsedS: 42,
      currentRoundIdx: 0,
      currentMovementIdx: 1,
      currentReps: 3,
      perMovementReps: [21, 3],
      amrapCompletedRounds: 0,
      amrapPartialReps: 0,
      dnf: false,
      roundSplits: [],
      movementSplits: {},
    })
    expect(restoreWodSession(v1)).toBeNull()
  })

  // Per-element validation (mirrors restoreStrengthSession's fix): the
  // top-level shape checks alone let a crafted/corrupted blob through
  // with poisoned per-round / per-move fields that would wreck downstream
  // split + duration math.
  describe('rejects bad element shapes inside rounds', () => {
    function baseBlob(overrideRoundsJson: string): string {
      let s = start(HELEN)
      s = wodSessionReducer(s, { type: 'TICK', nowMs: 5000 })
      const good = JSON.parse(serializeWodSession(s)) as Record<string, unknown>
      // `rounds` is spliced in as raw JSON text (not a JS value re-stringified)
      // so an out-of-range numeric token like `1e400` — valid JSON syntax that
      // JS parses to Infinity — survives the round-trip. JSON itself has no
      // NaN/Infinity literal, so this is the only way a real localStorage
      // blob could carry a non-finite number into the reducer.
      const withPlaceholder = { ...good, rounds: '__ROUNDS__' }
      return JSON.stringify(withPlaceholder).replace('"__ROUNDS__"', overrideRoundsJson)
    }

    it('rejects Infinity (an overflowing numeric literal) in a move.atS', () => {
      const blob = baseBlob(
        '[{"targetReps":null,"atS":null,"moves":[{"done":true,"atS":1e400,"applicable":true}]}]',
      )
      expect(restoreWodSession(blob)).toBeNull()
    })

    it('rejects Infinity (an overflowing numeric literal) in a round.atS', () => {
      const blob = baseBlob(
        '[{"targetReps":null,"atS":1e400,"moves":[{"done":true,"atS":5,"applicable":true}]}]',
      )
      expect(restoreWodSession(blob)).toBeNull()
    })

    it('rejects a negative move.atS', () => {
      const blob = baseBlob(
        '[{"targetReps":null,"atS":null,"moves":[{"done":true,"atS":-1,"applicable":true}]}]',
      )
      expect(restoreWodSession(blob)).toBeNull()
    })

    it('rejects a move with a wrong-type `done` field', () => {
      const blob = baseBlob(
        '[{"targetReps":null,"atS":null,"moves":[{"done":"yes","atS":null,"applicable":true}]}]',
      )
      expect(restoreWodSession(blob)).toBeNull()
    })

    it('rejects a round missing the moves array', () => {
      const blob = baseBlob('[{"targetReps":null,"atS":null}]')
      expect(restoreWodSession(blob)).toBeNull()
    })

    it('rejects an overflowing numeric literal in perMovementReps', () => {
      let s = start(HELEN)
      s = wodSessionReducer(s, { type: 'TICK', nowMs: 5000 })
      const good = JSON.parse(serializeWodSession(s)) as Record<string, unknown>
      const withPlaceholder = { ...good, perMovementReps: '__PMR__' }
      const blob = JSON.stringify(withPlaceholder).replace('"__PMR__"', '[1e400,0,0]')
      expect(restoreWodSession(blob)).toBeNull()
    })

    it('accepts a well-formed blob unchanged', () => {
      let s = start(HELEN)
      s = wodSessionReducer(s, { type: 'TICK', nowMs: 5000 })
      s = wodSessionReducer(s, toggle(0, 0))
      const raw = serializeWodSession(s)
      expect(restoreWodSession(raw)).toEqual(s)
    })
  })
})

describe('isLiveSessionStale', () => {
  const NOW = 10_000_000_000_000 // fixed reference instant
  const HOUR = 60 * 60 * 1000

  it('treats a never-started session as fresh', () => {
    expect(isLiveSessionStale(null, null, NOW)).toBe(false)
  })

  it('treats a running session inside the window as fresh', () => {
    expect(isLiveSessionStale(NOW - 23 * HOUR, null, NOW)).toBe(false)
  })

  it('treats a done session inside the window as fresh', () => {
    expect(isLiveSessionStale(NOW - 25 * HOUR, NOW - 23 * HOUR, NOW)).toBe(false)
  })

  it('marks a running session past 24h as stale', () => {
    expect(isLiveSessionStale(NOW - 25 * HOUR, null, NOW)).toBe(true)
  })

  it('marks a done session past 24h as stale via finishedAtMs anchor', () => {
    // startedAtMs is fresh, but finishedAtMs is the load-bearing anchor
    // for done sessions — the threshold runs from when they stopped
    // moving, not from when they started.
    expect(isLiveSessionStale(NOW - HOUR, NOW - 25 * HOUR, NOW)).toBe(true)
  })

  it('exposes a 24h threshold constant', () => {
    expect(LIVE_SESSION_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000)
  })
})

describe('wodResultFromState', () => {
  it('returns null while still running', () => {
    const s = start(CINDY)
    expect(wodResultFromState(s)).toBeNull()
  })

  it('produces the right shape on a happy AMRAP finish', () => {
    let s = start(CINDY)
    s = completeRound(s, 0)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 1200 * 1000 })
    const result = wodResultFromState(s)!
    expect(result).toMatchObject({
      wodType: 'amrap',
      templateId: 'wt_test',
      templateName: 'Test WOD',
      completedRounds: 1,
      partialReps: 0,
      totalReps: 30,
      asPrescribed: true,
    })
  })

  it('derives splits from the live rounds on a happy Fran finish', () => {
    let s = start(FRAN)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 30_000 })
    s = completeRound(s, 0)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 90_000 })
    s = completeRound(s, 1)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 145_000 })
    s = completeRound(s, 2)
    const result = wodResultFromState(s)!
    expect(result.wodType).toBe('for_time')
    if (result.wodType === 'for_time') {
      expect(result.dnf).toBe(false)
      expect(result.timeS).toBe(145)
      expect(result.perMovementReps).toEqual([45, 45])
      expect(result.roundSplits).toEqual([30, 90, 145])
      expect(result.movementSplits).toEqual({
        '0_0': 30,
        '0_1': 30,
        '1_0': 90,
        '1_1': 90,
        '2_0': 145,
        '2_1': 145,
      })
    }
  })

  it('a NEXT_ROUND-completed round stamps its split like a tapped-out round', () => {
    let s = start(HELEN)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 60_000 })
    s = completeRound(s, 0)
    s = wodSessionReducer(s, { type: 'NEXT_ROUND' }) // completes round 1 at 60s
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 300_000 })
    s = completeRound(s, 2)
    expect(s.phase).toBe('done')
    const result = wodResultFromState(s)!
    if (result.wodType === 'rounds_for_time') {
      expect(result.roundSplits).toEqual([60, 60, 300])
    }
  })
})

describe('wodSetsFromResult', () => {
  it('projects a finished Fran onto one aggregate set per movement', () => {
    // 21+15+9 = 45 reps of each movement.
    expect(wodSetsFromResult(FRAN, [45, 45])).toEqual([
      { exerciseId: 'fx_seed_thruster', setIndex: 0, reps: 45, loadKg: 43 },
      { exerciseId: 'fx_seed_pull_up', setIndex: 1, reps: 45 },
    ])
  })

  it('stamps setType warmup on flagged movement indices only', () => {
    const sets = wodSetsFromResult(FRAN, [45, 45], new Set([1]))
    expect(sets).toEqual([
      { exerciseId: 'fx_seed_thruster', setIndex: 0, reps: 45, loadKg: 43 },
      { exerciseId: 'fx_seed_pull_up', setIndex: 1, reps: 45, setType: 'warmup' },
    ])
    // No flags → identical to the two-arg call (no setType key at all).
    expect(wodSetsFromResult(FRAN, [45, 45], new Set())).toEqual(
      wodSetsFromResult(FRAN, [45, 45]),
    )
  })

  it('keeps partial AMRAP totals as-is (no rounding up to full rounds)', () => {
    const sets = wodSetsFromResult(CINDY, [23, 40, 60])
    expect(sets.map((s) => s.reps)).toEqual([23, 40, 60])
    expect(sets.map((s) => s.setIndex)).toEqual([0, 1, 2])
  })

  it('skips zero-rep movements and reindexes (DNF mid-ladder)', () => {
    const sets = wodSetsFromResult(FRAN, [21, 0])
    expect(sets).toEqual([{ exerciseId: 'fx_seed_thruster', setIndex: 0, reps: 21, loadKg: 43 }])
  })

  it('returns [] when nothing was completed', () => {
    expect(wodSetsFromResult(FRAN, [0, 0])).toEqual([])
    expect(wodSetsFromResult(FRAN, [])).toEqual([])
  })

  it('matches the reducer output end-to-end on a finished Fran', () => {
    let s = start(FRAN)
    for (let r = 0; r < 3; r++) s = completeRound(s, r)
    expect(s.phase).toBe('done')
    const result = wodResultFromState(s)!
    const sets = wodSetsFromResult(s.body, result.perMovementReps)
    // 21+15+9 = 45 reps of each of Fran's two movements.
    expect(sets.map((x) => x.reps)).toEqual([45, 45])
  })
})

// ── Benchmark-coverage expansion: EMOM, cumulative ladder, rest-between ──────

const CHELSEA: WodBody = {
  wodType: 'emom',
  intervalS: 60,
  totalIntervals: 30,
  movements: [
    { exerciseId: 'fx_seed_pull_up', reps: 5 },
    { exerciseId: 'fx_seed_push_up', reps: 10 },
    { exerciseId: 'fx_seed_air_squat', reps: 15 },
  ],
}

// 12 Days of Christmas — reverse-cumulative ladder over 3 movements for the test.
const XMAS: WodBody = {
  wodType: 'for_time',
  rounds: 3,
  ladder: 'cumulative',
  movements: [
    { exerciseId: 'fx_seed_sumo_deadlift_high_pull', reps: 1 },
    { exerciseId: 'fx_seed_thruster', reps: 2 },
    { exerciseId: 'fx_seed_push_press', reps: 3 },
  ],
}

const BARBARA: WodBody = {
  wodType: 'rounds_for_time',
  rounds: 5,
  restBetweenRoundsS: 180,
  movements: [
    { exerciseId: 'fx_seed_pull_up', reps: 20 },
    { exerciseId: 'fx_seed_push_up', reps: 30 },
  ],
}

describe('EMOM (Chelsea)', () => {
  it('allocates one round per interval', () => {
    const s = start(CHELSEA)
    expect(s.rounds).toHaveLength(30)
    expect(s.wodType).toBe('emom')
  })

  it('banks a completed interval and advances on the minute boundary', () => {
    let s = start(CHELSEA)
    s = completeRound(s, 0)
    // Completing early does not advance — the clock does.
    expect(s.currentRoundIdx).toBe(0)
    expect(s.emomIntervalsCompleted).toBe(0)
    // Cross into the second minute.
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 60_000 })
    expect(s.emomIntervalsCompleted).toBe(1)
    expect(s.currentRoundIdx).toBe(1)
    expect(s.phase).toBe('running')
  })

  it('DNFs when the active interval is not completed in time', () => {
    let s = start(CHELSEA)
    // Only check two of three movements before the minute rolls.
    s = wodSessionReducer(s, toggle(0, 0))
    s = wodSessionReducer(s, toggle(0, 1))
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 60_000 })
    expect(s.phase).toBe('done')
    expect(s.dnf).toBe(true)
    expect(s.emomIntervalsCompleted).toBe(0)
  })

  it('DNFs at the first skipped interval on a multi-boundary clock jump', () => {
    let s = start(CHELSEA)
    s = completeRound(s, 0)
    // Backgrounded tab: the next tick lands 3 minutes in. Interval 1 was
    // completed (banked); interval 2 was never attempted -> DNF there.
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 185_000 })
    expect(s.phase).toBe('done')
    expect(s.dnf).toBe(true)
    expect(s.emomIntervalsCompleted).toBe(1)
    expect(s.currentRoundIdx).toBe(1)
  })

  it('banks the current interval on manual Finish (completed all, no DNF)', () => {
    const short: WodBody = { ...CHELSEA, totalIntervals: 2 }
    let s = start(short)
    s = completeRound(s, 0)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 60_000 }) // bank interval 1
    s = completeRound(s, 1)
    // Hit Finish mid-minute rather than waiting out the 2nd interval.
    s = wodSessionReducer(s, { type: 'FINISH', nowMs: 90_000 })
    expect(s.phase).toBe('done')
    expect(s.emomIntervalsCompleted).toBe(2)
    expect(s.dnf).toBe(false)
  })

  it('finishes successfully after the final interval completes', () => {
    const short: WodBody = { ...CHELSEA, totalIntervals: 2 }
    let s = start(short)
    s = completeRound(s, 0)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 60_000 }) // bank interval 1
    s = completeRound(s, 1)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 120_000 }) // bank interval 2 (last)
    expect(s.phase).toBe('done')
    expect(s.dnf).toBe(false)
    expect(s.emomIntervalsCompleted).toBe(2)
    const result = wodResultFromState(s)!
    expect(result.wodType).toBe('emom')
  })
})

describe('cumulative ladder (12 Days)', () => {
  it('drops movement j from every round < j', () => {
    const s = start(XMAS)
    // Round 0: only movement 0 applies.
    expect(s.rounds[0].moves.map((m) => m.applicable)).toEqual([true, false, false])
    // Round 1: movements 0 and 1.
    expect(s.rounds[1].moves.map((m) => m.applicable)).toEqual([true, true, false])
    // Round 2: all three.
    expect(s.rounds[2].moves.map((m) => m.applicable)).toEqual([true, true, true])
  })

  it('completes a round once every applicable movement is checked', () => {
    let s = start(XMAS)
    // Round 0 completes after checking just movement 0.
    s = wodSessionReducer(s, toggle(0, 0))
    expect(s.currentRoundIdx).toBe(1)
    expect(s.rounds[0].atS).not.toBeNull()
  })

  it('credits each applicable movement its own reps (1/2/3 pyramid)', () => {
    let s = start(XMAS)
    s = wodSessionReducer(s, toggle(0, 0)) // r0: m0 (1)
    s = wodSessionReducer(s, toggle(1, 0)) // r1: m0 (1)
    s = wodSessionReducer(s, toggle(1, 1)) // r1: m1 (2)
    s = wodSessionReducer(s, toggle(2, 0)) // r2: m0 (1)
    s = wodSessionReducer(s, toggle(2, 1)) // r2: m1 (2)
    s = wodSessionReducer(s, toggle(2, 2)) // r2: m2 (3)
    expect(s.phase).toBe('done')
    // m0 appears 3× (1 each) = 3; m1 appears 2× (2 each) = 4; m2 once = 3.
    expect(s.perMovementReps).toEqual([3, 4, 3])
  })
})

describe('rest between rounds (Barbara)', () => {
  it('gates the next round until the rest elapses', () => {
    let s = start(BARBARA)
    s = completeRound(s, 0)
    expect(s.currentRoundIdx).toBe(1)
    expect(s.restEndsAtS).toBe(180)
    // Toggling round 1 is blocked during the rest.
    s = wodSessionReducer(s, toggle(1, 0))
    expect(s.rounds[1].moves[0].done).toBe(false)
    // After the rest elapses, round 1 becomes tappable.
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 181_000 })
    expect(s.restEndsAtS).toBeNull()
    s = wodSessionReducer(s, toggle(1, 0))
    expect(s.rounds[1].moves[0].done).toBe(true)
  })
})

describe('REMOVE_MOVEMENT', () => {
  const remove = (movementIdx: number): WodSessionAction => ({
    type: 'REMOVE_MOVEMENT',
    movementIdx,
  })

  it('drops the movement from current + future rounds, keeps frozen history (Fran)', () => {
    let s = start(FRAN)
    // Finish round 0 normally, then remove the pull-ups mid-round-1.
    s = completeRound(s, 0)
    expect(s.currentRoundIdx).toBe(1)
    s = wodSessionReducer(s, remove(1))
    expect(s.removedMovements).toEqual([1])
    // Frozen round 0 untouched, credited reps intact.
    expect(s.rounds[0].moves[1]).toMatchObject({ done: true, applicable: true })
    expect(s.perMovementReps).toEqual([21, 21])
    // Current + future rounds drop it.
    expect(s.rounds[1].moves[1].applicable).toBe(false)
    expect(s.rounds[2].moves[1].applicable).toBe(false)
    // The session finishes by checking only the remaining movement.
    s = wodSessionReducer(s, toggle(1, 0))
    expect(s.currentRoundIdx).toBe(2)
    s = wodSessionReducer(s, toggle(2, 0))
    expect(s.phase).toBe('done')
    expect(s.dnf).toBe(false)
    expect(s.perMovementReps).toEqual([21 + 15 + 9, 21])
  })

  it('revokes a done move\'s credit in the current round only', () => {
    let s = start(FRAN)
    s = completeRound(s, 0) // round 0 frozen: 21 + 21
    s = wodSessionReducer(s, toggle(1, 1)) // pull-ups checked in round 1 (+15)
    expect(s.perMovementReps).toEqual([21, 36])
    s = wodSessionReducer(s, remove(1))
    // Round-1 credit revoked, frozen round-0 credit survives.
    expect(s.perMovementReps).toEqual([21, 21])
    expect(s.rounds[1].moves[1]).toMatchObject({
      done: false,
      atS: null,
      applicable: false,
    })
  })

  it('cascades round completion: stamping the split and advancing (Fran)', () => {
    let s = start(FRAN)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 30_000 })
    s = wodSessionReducer(s, toggle(0, 0)) // thrusters done, pull-ups pending
    s = wodSessionReducer(s, remove(1)) // removal completes round 0
    expect(s.rounds[0].atS).toBe(30)
    expect(s.currentRoundIdx).toBe(1)
    expect(s.phase).toBe('running')
  })

  it('cascades to done on the last round with dnf false (Fran)', () => {
    let s = start(FRAN)
    s = completeRound(s, 0)
    s = completeRound(s, 1)
    s = wodSessionReducer(s, toggle(2, 0))
    s = wodSessionReducer(s, remove(1))
    expect(s.phase).toBe('done')
    expect(s.dnf).toBe(false)
  })

  it('cascade arms the Barbara rest gate; removal during rest is allowed and does not cascade', () => {
    let s = start(BARBARA)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 60_000 })
    s = wodSessionReducer(s, toggle(0, 0))
    s = wodSessionReducer(s, remove(1)) // completes round 0 via removal
    expect(s.rounds[0].atS).toBe(60)
    expect(s.currentRoundIdx).toBe(1)
    expect(s.restEndsAtS).toBe(60 + 180)
    // Un-remove isn't a thing; but removing the OTHER movement during rest
    // is blocked only by the ≥1-remaining guard (round 1 would go empty).
    const blocked = wodSessionReducer(s, remove(0))
    expect(blocked).toBe(s)
  })

  it('allows removal during rest when the round keeps a movement (Barbara-3)', () => {
    const BARBARA3: WodBody = {
      ...BARBARA,
      movements: [
        { exerciseId: 'fx_seed_pull_up', reps: 20 },
        { exerciseId: 'fx_seed_push_up', reps: 30 },
        { exerciseId: 'fx_seed_sit_up', reps: 40 },
      ],
    }
    let s = start(BARBARA3)
    s = completeRound(s, 0)
    expect(s.restEndsAtS).toBe(180)
    s = wodSessionReducer(s, remove(2))
    expect(s.removedMovements).toEqual([2])
    expect(s.restEndsAtS).toBe(180) // rest untouched, no cascade
    expect(s.rounds[1].moves[2].applicable).toBe(false)
  })

  it('AMRAP: appended rounds honor the removal and totals stay rep-accurate (Cindy)', () => {
    let s = start(CINDY)
    s = completeRound(s, 0) // round 1 banked: 5 + 10 + 15
    s = wodSessionReducer(s, remove(1)) // drop push-ups
    // Fresh open round already omits the movement.
    expect(s.rounds[1].moves[1].applicable).toBe(false)
    // Complete the shortened round: pull-ups + squats only.
    s = wodSessionReducer(s, toggle(1, 0))
    s = wodSessionReducer(s, toggle(1, 2))
    expect(s.amrapCompletedRounds).toBe(2)
    // The next appended round omits it too.
    expect(s.rounds[2].moves[1].applicable).toBe(false)
    s = wodSessionReducer(s, toggle(2, 0)) // partial: 5
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 1200_000 })
    expect(s.phase).toBe('done')
    const result = wodResultFromState(s)
    expect(result?.wodType).toBe('amrap')
    if (result?.wodType === 'amrap') {
      // 30 (full round) + 20 (shortened round) + 5 (partial) — the naive
      // completedRounds × 30 + partial formula would say 65 + 5.
      expect(result.totalReps).toBe(30 + 20 + 5)
      expect(result.completedRounds).toBe(2)
      expect(result.partialReps).toBe(5)
    }
  })

  it('AMRAP: revoking a done move in the open round decrements partials (Cindy)', () => {
    let s = start(CINDY)
    s = wodSessionReducer(s, toggle(0, 0)) // +5
    s = wodSessionReducer(s, toggle(0, 1)) // +10
    expect(s.amrapPartialReps).toBe(15)
    s = wodSessionReducer(s, remove(1))
    expect(s.amrapPartialReps).toBe(5)
    expect(s.perMovementReps).toEqual([5, 0, 0])
  })

  it('AMRAP: unchanged Cindy still scores completedRounds × 30 + partial', () => {
    let s = start(CINDY)
    s = completeRound(s, 0)
    s = completeRound(s, 1)
    s = completeRound(s, 2)
    s = wodSessionReducer(s, toggle(3, 0)) // +5 partial
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 1200_000 })
    const result = wodResultFromState(s)
    if (result?.wodType === 'amrap') {
      expect(result.totalReps).toBe(3 * 30 + 5)
    } else {
      expect.unreachable('expected an AMRAP result')
    }
  })

  it('EMOM: the shortened checklist banks at the minute boundary (Chelsea)', () => {
    let s = start(CHELSEA)
    s = wodSessionReducer(s, remove(2)) // drop squats before working
    s = wodSessionReducer(s, toggle(0, 0))
    s = wodSessionReducer(s, toggle(0, 1))
    // Round complete via the shortened checklist — banks on the boundary.
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 61_000 })
    expect(s.emomIntervalsCompleted).toBe(1)
    expect(s.currentRoundIdx).toBe(1)
    expect(s.phase).toBe('running')
    expect(s.rounds[1].moves[2].applicable).toBe(false)
  })

  it('EMOM: removal completing the active interval stamps it and waits for TICK', () => {
    let s = start(CHELSEA)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 10_000 })
    s = wodSessionReducer(s, toggle(0, 0))
    s = wodSessionReducer(s, toggle(0, 1))
    s = wodSessionReducer(s, remove(2))
    // Stamped but not banked — banking happens at the minute boundary.
    expect(s.rounds[0].atS).toBe(10)
    expect(s.emomIntervalsCompleted).toBe(0)
    s = wodSessionReducer(s, { type: 'TICK', nowMs: 60_000 })
    expect(s.emomIntervalsCompleted).toBe(1)
  })

  it('cumulative ladder: blocked while the sole-movement round is active (12 Days)', () => {
    const s = start(XMAS)
    // Round 0 only performs movement 0 — removing it would empty the round.
    const blocked = wodSessionReducer(s, remove(0))
    expect(blocked).toBe(s)
  })

  it('cumulative ladder: removing a later movement composes with dropped rungs (12 Days)', () => {
    let s = start(XMAS)
    s = wodSessionReducer(s, toggle(0, 0)) // finish round 0 (m0 only)
    expect(s.currentRoundIdx).toBe(1)
    s = wodSessionReducer(s, remove(1))
    // Round 1 loses m1 (was applicable), round 2 too; m1 was never
    // applicable in the frozen round 0 anyway.
    expect(s.rounds[1].moves[1].applicable).toBe(false)
    expect(s.rounds[2].moves[1].applicable).toBe(false)
    // Rounds still complete via their remaining movements.
    s = wodSessionReducer(s, toggle(1, 0))
    expect(s.currentRoundIdx).toBe(2)
    s = wodSessionReducer(s, toggle(2, 0))
    s = wodSessionReducer(s, toggle(2, 2))
    expect(s.phase).toBe('done')
    expect(s.perMovementReps).toEqual([3, 0, 3])
  })

  it('no-ops in pre and done phases', () => {
    const pre = initWodSession({
      templateId: 'wt_test',
      templateName: 'Test WOD',
      body: FRAN,
      sessionId: 'ses_test',
    })
    expect(wodSessionReducer(pre, remove(0))).toBe(pre)
    let s = start(FRAN)
    s = wodSessionReducer(s, { type: 'FINISH', nowMs: 1000 })
    expect(s.phase).toBe('done')
    expect(wodSessionReducer(s, remove(0))).toBe(s)
  })

  it('no-ops on the last remaining movement, duplicates, and bad indices', () => {
    let s = start(FRAN)
    s = wodSessionReducer(s, remove(1))
    // Only thrusters remain — removing them would empty every round.
    expect(wodSessionReducer(s, remove(0))).toBe(s)
    // Duplicate removal and out-of-range indices are no-ops too.
    expect(wodSessionReducer(s, remove(1))).toBe(s)
    expect(wodSessionReducer(s, remove(-1))).toBe(s)
    expect(wodSessionReducer(s, remove(99))).toBe(s)
  })

  it('replays deterministically inside an action stream', () => {
    const actions: WodSessionAction[] = [
      { type: 'START', nowMs: 100 },
      { type: 'TICK', nowMs: 8_000 },
      toggle(0, 0),
      remove(1),
      { type: 'TICK', nowMs: 20_000 },
      toggle(1, 0),
      { type: 'FINISH', nowMs: 42_000 },
    ]
    const init = () =>
      initWodSession({
        templateId: 'wt_a',
        templateName: 'A',
        body: FRAN,
        sessionId: 'ses_repro_a',
      })
    expect(runActions(init(), actions)).toEqual(runActions(init(), actions))
  })
})

describe('serialize / restore — removedMovements (v4)', () => {
  it('round-trips a state with a non-empty removedMovements', () => {
    let s = start(FRAN)
    s = wodSessionReducer(s, { type: 'REMOVE_MOVEMENT', movementIdx: 1 })
    expect(s.removedMovements).toEqual([1])
    const restored = restoreWodSession(serializeWodSession(s))
    expect(restored).toEqual(s)
  })

  it('migrates a v3 blob by defaulting removedMovements to []', () => {
    const s = start(HELEN)
    const { removedMovements: _drop, ...rest } = s
    const v3 = JSON.stringify({ ...rest, v: 3 })
    const restored = restoreWodSession(v3)
    expect(restored).not.toBeNull()
    expect(restored?.v).toBe(4)
    expect(restored?.removedMovements).toEqual([])
  })

  it('rejects a v4 blob with a poisoned removedMovements', () => {
    const s = start(HELEN)
    const good = JSON.parse(serializeWodSession(s)) as Record<string, unknown>
    expect(
      restoreWodSession(JSON.stringify({ ...good, removedMovements: [-1] })),
    ).toBeNull()
    expect(
      restoreWodSession(JSON.stringify({ ...good, removedMovements: [1.5] })),
    ).toBeNull()
    expect(
      restoreWodSession(JSON.stringify({ ...good, removedMovements: 'nope' })),
    ).toBeNull()
  })
})
