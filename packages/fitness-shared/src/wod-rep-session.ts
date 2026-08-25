// Pure live-session reducer for the REP-ENTRY WOD types — `interval`
// (Fight Gone Bad) and `max_reps_rounds` (Lynne, Nicole). Unlike the
// tap-to-check timer in wod-session.ts, these are scored by the reps (or
// calories) the athlete enters per round per movement, so the live UI is a
// numeric grid over a reference clock rather than a checklist.
//
// Same purity contract as wod-session.ts: every action carries `nowMs` (or
// ignores time); the reducer and constructor never call Date.now() or
// Math.random(), so a given action stream against a given template always
// produces the same state.

import type {
  WodBody,
  WodIntervalResult,
  WodMaxRepsResult,
  WodResult,
} from './wods.js'
import type { WorkoutSetInput } from './workouts.js'

export type RepWodType = 'interval' | 'max_reps_rounds'

export interface RepSessionState {
  // Shape version — restoreRepSession() drops anything that isn't current.
  v: 1
  phase: 'pre' | 'running' | 'done'
  sessionId: string
  templateId: string | null
  templateName: string
  wodType: RepWodType
  body: WodBody

  startedAtMs: number | null
  finishedAtMs: number | null
  elapsedS: number

  // scores[round][movement] — entered reps (or calories for a calorie
  // station). Movements that aren't scored (Nicole's fixed 400m run) stay 0.
  scores: number[][]
}

export type RepSessionAction =
  | { type: 'START'; nowMs: number }
  | { type: 'TICK'; nowMs: number }
  | { type: 'SET_REPS'; roundIdx: number; movementIdx: number; value: number }
  | { type: 'FINISH'; nowMs: number }

export interface InitRepSessionInput {
  templateId: string | null
  templateName: string
  body: WodBody
  sessionId: string
}

// Total work+rest wall-clock for an `interval` body: every round is `workS`
// of continuous stations, with `restBetweenRoundsS` between rounds.
export function intervalTotalS(body: WodBody): number {
  if (body.wodType !== 'interval') return 0
  const rest = body.restBetweenRoundsS ?? 0
  return body.rounds * body.workS + Math.max(0, body.rounds - 1) * rest
}

// The clock cap after which the session auto-finishes, or null for an
// untimed body (Lynne — rest as needed, finish manually).
function autoFinishS(body: WodBody): number | null {
  if (body.wodType === 'interval') return intervalTotalS(body)
  if (body.wodType === 'max_reps_rounds') return body.durationS ?? null
  return null
}

function roundsFor(body: WodBody): number {
  if (body.wodType === 'interval' || body.wodType === 'max_reps_rounds') {
    return body.rounds
  }
  return 1
}

// True when the athlete enters a score for this movement. Interval scores
// every station; max_reps_rounds scores only movements flagged `scored`
// (Nicole's run is unscored fixed work).
export function isScoredMovement(body: WodBody, movementIdx: number): boolean {
  const m = body.movements[movementIdx]
  if (m === undefined) return false
  if (body.wodType === 'interval') return true
  if (body.wodType === 'max_reps_rounds') return m.scored === true
  return false
}

export function initRepSession(input: InitRepSessionInput): RepSessionState {
  const body = input.body
  const rounds = roundsFor(body)
  const movements = body.movements.length
  return {
    v: 1,
    phase: 'pre',
    sessionId: input.sessionId,
    templateId: input.templateId,
    templateName: input.templateName,
    wodType: (body.wodType === 'interval' ? 'interval' : 'max_reps_rounds') as RepWodType,
    body,
    startedAtMs: null,
    finishedAtMs: null,
    elapsedS: 0,
    scores: Array.from({ length: rounds }, () => new Array(movements).fill(0)),
  }
}

function columnSums(scores: number[][], movements: number): number[] {
  const out = new Array(movements).fill(0)
  for (const row of scores) {
    for (let i = 0; i < movements; i++) out[i] += row[i] ?? 0
  }
  return out
}

function buildResult(s: RepSessionState): WodResult {
  const movements = s.body.movements.length
  const perMovementReps = columnSums(s.scores, movements)
  if (s.body.wodType === 'interval') {
    const totalScore = perMovementReps.reduce((a, b) => a + b, 0)
    const result: WodIntervalResult = {
      wodType: 'interval',
      templateId: s.templateId,
      templateName: s.templateName,
      roundStationScores: s.scores.map((r) => [...r]),
      totalScore,
      perMovementReps,
      asPrescribed: true,
    }
    return result
  }
  // max_reps_rounds — total counts only the scored movement columns.
  let totalReps = 0
  for (let i = 0; i < movements; i++) {
    if (isScoredMovement(s.body, i)) totalReps += perMovementReps[i] ?? 0
  }
  const result: WodMaxRepsResult = {
    wodType: 'max_reps_rounds',
    templateId: s.templateId,
    templateName: s.templateName,
    roundMovementReps: s.scores.map((r) => [...r]),
    totalReps,
    perMovementReps,
    asPrescribed: true,
  }
  return result
}

export function repSessionReducer(
  s: RepSessionState,
  a: RepSessionAction,
): RepSessionState {
  switch (a.type) {
    case 'START': {
      if (s.phase !== 'pre') return s
      return { ...s, phase: 'running', startedAtMs: a.nowMs, elapsedS: 0 }
    }
    case 'TICK': {
      if (s.phase !== 'running' || s.startedAtMs === null) return s
      const elapsedS = Math.max(0, Math.floor((a.nowMs - s.startedAtMs) / 1000))
      const cap = autoFinishS(s.body)
      if (cap !== null && elapsedS >= cap) {
        return { ...s, elapsedS: cap, phase: 'done', finishedAtMs: a.nowMs }
      }
      return { ...s, elapsedS }
    }
    case 'SET_REPS': {
      if (s.phase !== 'running') return s
      if (!isScoredMovement(s.body, a.movementIdx)) return s
      const row = s.scores[a.roundIdx]
      if (row === undefined || a.movementIdx >= row.length) return s
      if (!Number.isFinite(a.value) || a.value < 0) return s
      const value = Math.floor(a.value)
      const nextScores = s.scores.map((r, ri) =>
        ri === a.roundIdx ? r.map((v, mi) => (mi === a.movementIdx ? value : v)) : r,
      )
      return { ...s, scores: nextScores }
    }
    case 'FINISH': {
      if (s.phase !== 'running') return s
      return { ...s, phase: 'done', finishedAtMs: a.nowMs }
    }
  }
}

export function repResultFromState(s: RepSessionState): WodResult | null {
  if (s.phase !== 'done') return null
  return buildResult(s)
}

// Project a finished rep-entry WOD onto workout_sets: one aggregate row per
// movement. Scored movements carry their column-sum reps; an unscored
// movement with a prescribed distance (Nicole's run) carries distance ×
// rounds so history/insights still see the aerobic work.
export function repSetsFromResult(
  body: WodBody,
  scores: number[][],
): WorkoutSetInput[] {
  const out: WorkoutSetInput[] = []
  const rounds = scores.length
  const movements = body.movements.length
  const sums = columnSums(scores, movements)
  body.movements.forEach((m, i) => {
    const scored = isScoredMovement(body, i)
    if (scored) {
      const total = Math.round(sums[i] ?? 0)
      if (total <= 0) return
      // A calorie-scored station (FGB's row) logs its total as calories,
      // not reps, so history/insights see machine work as machine work.
      const set: WorkoutSetInput =
        m.scoreUnit === 'calories'
          ? { exerciseId: m.exerciseId, setIndex: out.length, calories: total }
          : { exerciseId: m.exerciseId, setIndex: out.length, reps: total }
      if (m.loadKg != null) set.loadKg = m.loadKg
      out.push(set)
      return
    }
    // Unscored fixed movement — record prescribed distance across rounds.
    if (m.distanceM != null && m.distanceM > 0 && rounds > 0) {
      out.push({
        exerciseId: m.exerciseId,
        setIndex: out.length,
        distanceM: m.distanceM * rounds,
      })
    }
  })
  return out
}

export function serializeRepSession(s: RepSessionState): string {
  return JSON.stringify(s)
}

export function restoreRepSession(raw: string): RepSessionState | null {
  try {
    const parsed = JSON.parse(raw) as Partial<RepSessionState> & { body?: WodBody }
    if (
      parsed.v !== 1 ||
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.templateName !== 'string' ||
      typeof parsed.wodType !== 'string' ||
      !parsed.body ||
      !Array.isArray(parsed.scores)
    ) {
      return null
    }
    return parsed as RepSessionState
  } catch {
    return null
  }
}
