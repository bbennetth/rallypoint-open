import { describe, expect, it } from 'vitest'
import {
  initRepSession,
  intervalTotalS,
  isScoredMovement,
  repResultFromState,
  repSessionReducer,
  repSetsFromResult,
  restoreRepSession,
  serializeRepSession,
  type RepSessionState,
} from './wod-rep-session.js'
import type { WodBody, WodIntervalResult, WodMaxRepsResult } from './wods.js'

const FIGHT_GONE_BAD: WodBody = {
  wodType: 'interval',
  rounds: 3,
  workS: 60,
  restBetweenRoundsS: 60,
  movements: [
    { exerciseId: 'fx_seed_wall_ball', reps: 1, loadKg: 9, scoreUnit: 'reps' },
    { exerciseId: 'fx_seed_rowing_erg', scoreUnit: 'calories' },
  ],
}

const LYNNE: WodBody = {
  wodType: 'max_reps_rounds',
  rounds: 5,
  movements: [
    { exerciseId: 'fx_seed_barbell_bench_press', loadBwMultiple: 1, scored: true },
    { exerciseId: 'fx_seed_pull_up', scored: true },
  ],
}

const NICOLE: WodBody = {
  wodType: 'max_reps_rounds',
  rounds: 6,
  durationS: 1200,
  movements: [
    { exerciseId: 'fx_seed_run', distanceM: 400, scored: false },
    { exerciseId: 'fx_seed_pull_up', scored: true },
  ],
}

function start(body: WodBody): RepSessionState {
  const pre = initRepSession({
    templateId: 'wt_test',
    templateName: 'Test',
    body,
    sessionId: 'ses_test',
  })
  return repSessionReducer(pre, { type: 'START', nowMs: 0 })
}

describe('intervalTotalS', () => {
  it('sums work + inter-round rest (Fight Gone Bad = 3×60 + 2×60 = 300)', () => {
    expect(intervalTotalS(FIGHT_GONE_BAD)).toBe(300)
  })
})

describe('isScoredMovement', () => {
  it('scores every interval station', () => {
    expect(isScoredMovement(FIGHT_GONE_BAD, 0)).toBe(true)
    expect(isScoredMovement(FIGHT_GONE_BAD, 1)).toBe(true)
  })
  it('scores only flagged movements for max_reps_rounds (Nicole run is unscored)', () => {
    expect(isScoredMovement(NICOLE, 0)).toBe(false)
    expect(isScoredMovement(NICOLE, 1)).toBe(true)
  })
})

describe('interval rep entry (Fight Gone Bad)', () => {
  it('allocates a rounds × movements score grid', () => {
    const s = start(FIGHT_GONE_BAD)
    expect(s.scores).toHaveLength(3)
    expect(s.scores[0]).toHaveLength(2)
  })

  it('sums entered reps/calories into a total score', () => {
    let s = start(FIGHT_GONE_BAD)
    s = repSessionReducer(s, { type: 'SET_REPS', roundIdx: 0, movementIdx: 0, value: 20 })
    s = repSessionReducer(s, { type: 'SET_REPS', roundIdx: 0, movementIdx: 1, value: 15 })
    s = repSessionReducer(s, { type: 'SET_REPS', roundIdx: 1, movementIdx: 0, value: 18 })
    s = repSessionReducer(s, { type: 'FINISH', nowMs: 300_000 })
    const result = repResultFromState(s) as WodIntervalResult
    expect(result.wodType).toBe('interval')
    expect(result.totalScore).toBe(53)
    expect(result.perMovementReps).toEqual([38, 15])
  })

  it('auto-finishes at the total work+rest time', () => {
    let s = start(FIGHT_GONE_BAD)
    s = repSessionReducer(s, { type: 'TICK', nowMs: 300_000 })
    expect(s.phase).toBe('done')
    expect(s.elapsedS).toBe(300)
  })

  it('rejects negative or non-finite entries', () => {
    let s = start(FIGHT_GONE_BAD)
    s = repSessionReducer(s, { type: 'SET_REPS', roundIdx: 0, movementIdx: 0, value: -5 })
    s = repSessionReducer(s, { type: 'SET_REPS', roundIdx: 0, movementIdx: 1, value: Infinity })
    expect(s.scores[0]).toEqual([0, 0])
  })
})

describe('max_reps_rounds (Lynne, untimed)', () => {
  it('has no auto-finish clock; totals only scored columns', () => {
    let s = start(LYNNE)
    s = repSessionReducer(s, { type: 'TICK', nowMs: 999_000 })
    expect(s.phase).toBe('running') // untimed — never auto-finishes
    s = repSessionReducer(s, { type: 'SET_REPS', roundIdx: 0, movementIdx: 0, value: 12 })
    s = repSessionReducer(s, { type: 'SET_REPS', roundIdx: 0, movementIdx: 1, value: 15 })
    s = repSessionReducer(s, { type: 'FINISH', nowMs: 600_000 })
    const result = repResultFromState(s) as WodMaxRepsResult
    expect(result.totalReps).toBe(27)
  })
})

describe('max_reps_rounds (Nicole, time-capped)', () => {
  it('auto-finishes at durationS and ignores the unscored run column', () => {
    let s = start(NICOLE)
    s = repSessionReducer(s, { type: 'SET_REPS', roundIdx: 0, movementIdx: 0, value: 99 }) // run — unscored, rejected
    s = repSessionReducer(s, { type: 'SET_REPS', roundIdx: 0, movementIdx: 1, value: 20 })
    s = repSessionReducer(s, { type: 'TICK', nowMs: 1_200_000 })
    expect(s.phase).toBe('done')
    const result = repResultFromState(s) as WodMaxRepsResult
    expect(result.totalReps).toBe(20)
    // The run column stayed 0 (SET_REPS on an unscored movement is a no-op).
    expect(result.roundMovementReps[0]).toEqual([0, 20])
  })

  it('projects sets: scored reps + run distance × rounds', () => {
    const scores = [
      [0, 20],
      [0, 18],
    ]
    const sets = repSetsFromResult(NICOLE, scores)
    // pull-ups: 38 reps; run: 400m × 2 rounds = 800m.
    expect(sets).toContainEqual({ exerciseId: 'fx_seed_run', setIndex: 0, distanceM: 800 })
    expect(sets).toContainEqual({ exerciseId: 'fx_seed_pull_up', setIndex: 1, reps: 38 })
  })

  it('projects a calorie-scored station as calories, not reps (FGB row)', () => {
    const scores = [
      [25, 12],
      [22, 10],
      [20, 9],
    ]
    const sets = repSetsFromResult(FIGHT_GONE_BAD, scores)
    expect(sets).toContainEqual({
      exerciseId: 'fx_seed_wall_ball',
      setIndex: 0,
      reps: 67,
      loadKg: 9,
    })
    expect(sets).toContainEqual({
      exerciseId: 'fx_seed_rowing_erg',
      setIndex: 1,
      calories: 31,
    })
  })
})

describe('serialize / restore', () => {
  it('round-trips a running session', () => {
    const s = start(LYNNE)
    expect(restoreRepSession(serializeRepSession(s))).toEqual(s)
  })
  it('drops malformed or wrong-version blobs', () => {
    expect(restoreRepSession('not json')).toBeNull()
    expect(restoreRepSession(JSON.stringify({ v: 99 }))).toBeNull()
  })
})
