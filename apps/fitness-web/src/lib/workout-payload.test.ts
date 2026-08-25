import { describe, expect, it } from 'vitest'
import {
  buildStrengthSession,
  strengthSessionReducer,
  type StrengthSessionState,
} from '@rallypoint/fitness-shared'
import { buildStrengthWorkoutPayload } from './workout-payload.js'

function session(): StrengthSessionState {
  let s = buildStrengthSession({
    sessionId: 'sess_1',
    templateName: 'Lower A',
    blocks: [
      {
        exerciseId: 'fx_seed_back_squat',
        name: 'Back Squat',
        suggestedKg: null,
        suggestedBasis: null,
        sets: [
          { reps: 5, calories: null, distanceM: null, timeS: null, inclinePct: null, loadKg: 100, done: false, doneAtMs: null, setType: 'working' as const },
          { reps: 5, calories: null, distanceM: null, timeS: null, inclinePct: null, loadKg: null, done: false, doneAtMs: null, setType: 'working' as const },
          { reps: 5, calories: null, distanceM: null, timeS: null, inclinePct: null, loadKg: 100, done: false, doneAtMs: null, setType: 'working' as const },
        ],
      },
      {
        exerciseId: 'fx_seed_pull_up',
        name: 'Pull Up',
        suggestedKg: null,
        suggestedBasis: null,
        sets: [
          { reps: 8, calories: null, distanceM: null, timeS: null, inclinePct: null, loadKg: 0, done: false, doneAtMs: null, setType: 'working' as const },
        ],
      },
    ],
  })
  s = strengthSessionReducer(s, { kind: 'START', nowMs: 0 })
  return s
}

const AT = '2026-07-08T10:00:00.000Z'

describe('buildStrengthWorkoutPayload', () => {
  it('emits only completed sets, with block-scoped setIndex', () => {
    let s = session()
    s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 1 })
    s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 1, setIdx: 0, nowMs: 2 })
    const p = buildStrengthWorkoutPayload(s, null, AT)
    expect(p.sets).toHaveLength(2)
    expect(p.sets![0]).toMatchObject({ exerciseId: 'fx_seed_back_squat', setIndex: 0, reps: 5, loadKg: 100 })
    expect(p.sets![1]).toMatchObject({ exerciseId: 'fx_seed_pull_up', setIndex: 1000, reps: 8 })
    // Bodyweight zero load drops from the logged set (junk-zero rule).
    expect(p.sets![1]!.loadKg).toBeUndefined()
    expect(p).toMatchObject({
      performedAt: AT,
      modality: 'strength',
      title: 'Lower A',
    })
    expect(p.rpe).toBeUndefined()
  })

  it('stamps templateId into the payload only when the session has one', () => {
    const free = session()
    expect(buildStrengthWorkoutPayload(free, null, AT).payload).not.toHaveProperty('templateId')
    const linked = { ...session(), templateId: 'wt_custom_1' }
    expect(buildStrengthWorkoutPayload(linked, null, AT).payload).toMatchObject({
      templateId: 'wt_custom_1',
    })
  })

  it('threads setType through to the logged set payload', () => {
    let s = session()
    s = strengthSessionReducer(s, { kind: 'TOGGLE_SET_TYPE', blockIdx: 0, setIdx: 0 })
    s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 1 })
    s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 2, nowMs: 2 })
    const p = buildStrengthWorkoutPayload(s, null, AT)
    expect(p.sets![0]).toMatchObject({ setType: 'warmup' })
    expect(p.sets![1]).toMatchObject({ setType: 'working' })
  })

  it('forwards per-set achieved RPE and the session RPE', () => {
    let s = session()
    s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 1 })
    s = strengthSessionReducer(s, {
      kind: 'EDIT_SET_METRIC', blockIdx: 0, setIdx: 0, field: 'rpe', value: 9,
    })
    const p = buildStrengthWorkoutPayload(s, 7, AT)
    expect(p.sets![0]!.rpe).toBe(9)
    expect(p.rpe).toBe(7)
  })

  it('null loads (bodyweight blank) are omitted; tonnage payload skips them', () => {
    let s = session()
    s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 1 })
    s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 1, nowMs: 2 })
    const p = buildStrengthWorkoutPayload(s, null, AT)
    expect(p.sets![1]!.loadKg).toBeUndefined()
    expect((p.payload as { tonnageKg: number }).tonnageKg).toBe(500)
  })
})

describe('running sets + weather snapshot', () => {
  function runningSession() {
    let s = buildStrengthSession({
      sessionId: 'sess_run',
      templateName: 'Morning run',
      blocks: [
        {
          exerciseId: 'fx_seed_run',
          name: 'Run',
          suggestedKg: null,
          suggestedBasis: null,
          sets: [
            {
              reps: null,
              calories: null,
              distanceM: 8046.72,
              timeS: 2400,
              inclinePct: 1.5,
              loadKg: null,
              done: false,
              doneAtMs: null,
              rpe: 7,
              setType: 'working' as const,
            },
          ],
        },
      ],
    })
    s = strengthSessionReducer(s, { kind: 'START', nowMs: 0 })
    s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 1 })
    return s
  }

  it('forwards distance + time + incline + rpe on a run set', () => {
    const p = buildStrengthWorkoutPayload(runningSession(), null, AT)
    expect(p.sets[0]).toMatchObject({
      exerciseId: 'fx_seed_run',
      distanceM: 8046.72,
      timeS: 2400,
      inclinePct: 1.5,
      rpe: 7,
    })
    expect(p.sets[0]?.reps).toBeUndefined()
  })

  it('never emits incline on rep-only sets', () => {
    let s = session()
    // poison a rep set with a stray incline (e.g. stale reducer state)
    s = {
      ...s,
      blocks: s.blocks.map((b, i) =>
        i === 0
          ? { ...b, sets: b.sets.map((st, j) => (j === 0 ? { ...st, inclinePct: 2 } : st)) }
          : b,
      ),
    }
    s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 1 })
    const p = buildStrengthWorkoutPayload(s, null, AT)
    expect(p.sets[0]?.inclinePct).toBeUndefined()
  })

  it('stamps the weather snapshot into the payload when provided', () => {
    const weather = {
      temperatureC: 18.2,
      apparentTemperatureC: null,
      windSpeedKmh: 9,
      weatherCode: 1,
      isDay: true,
      fetchedAt: AT,
    }
    const withWeather = buildStrengthWorkoutPayload(runningSession(), null, AT, weather)
    expect(withWeather.payload).toMatchObject({ weather })
    const without = buildStrengthWorkoutPayload(runningSession(), null, AT, null)
    expect(without.payload).not.toHaveProperty('weather')
  })
})
