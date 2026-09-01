import { describe, it, expect } from 'vitest'
import {
  advanceAfterComplete,
  pausedAwareElapsedMs,
  sessionFromStrengthBody,
  setTakesSuggestedLoad,
  bracketRange,
  buildStrengthSession,
  nextUpLabel,
  restoreStrengthSession,
  runningSetTimeS,
  serializeStrengthSession,
  strengthSessionReducer,
  strengthSetUnit,
  strengthSetsDone,
  strengthTonnage,
  type StrengthBlock,
} from './strength-session.js'

function repSet(reps: number | null, loadKg: number | null) {
  return {
    reps,
    calories: null,
    distanceM: null,
    timeS: null,
    inclinePct: null,
    loadKg,
    done: false,
    doneAtMs: null,
    setType: 'working' as const,
  }
}

function calSet(calories: number) {
  return {
    reps: null,
    calories,
    distanceM: null,
    timeS: null,
    inclinePct: null,
    loadKg: 0,
    done: false,
    doneAtMs: null,
    setType: 'working' as const,
  }
}

const squat = {
  exerciseId: 'fx_seed_back_squat',
  name: 'Back Squat',
  suggestedKg: 100,
  suggestedBasis: 'last 100',
  sets: [repSet(5, 100), repSet(5, 100), repSet(5, 100)],
}

const bike = {
  exerciseId: 'fx_seed_assault_bike',
  name: 'Assault Bike',
  suggestedKg: null,
  suggestedBasis: null,
  sets: [calSet(15), calSet(15)],
}

function freshSession() {
  return buildStrengthSession({
    sessionId: 'sess_test',
    templateName: 'Test',
    blocks: [{ ...squat }],
  })
}

describe('strengthSessionReducer', () => {
  it('starts pre and transitions to running on START', () => {
    const s = freshSession()
    expect(s.phase).toBe('pre')
    const next = strengthSessionReducer(s, { kind: 'START', nowMs: 1000 })
    expect(next.phase).toBe('running')
    expect(next.startedAtMs).toBe(1000)
  })
  it('TICK updates elapsedS based on nowMs', () => {
    let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 1000 })
    s = strengthSessionReducer(s, { kind: 'TICK', nowMs: 5000 })
    expect(s.elapsedS).toBe(4)
  })
  // A resumed tab / system clock correction can hand the reducer a
  // `nowMs` earlier than the previous tick's — elapsed must hold at the
  // last known value rather than rewinding toward 0 (mirrors the
  // wod-session.ts TICK fix).
  it('is monotonic across a backward clock jitter', () => {
    let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 100_000 })
    s = strengthSessionReducer(s, { kind: 'TICK', nowMs: 110_000 })
    expect(s.elapsedS).toBe(10)
    s = strengthSessionReducer(s, { kind: 'TICK', nowMs: 50_000 })
    expect(s.elapsedS).toBe(10)
    s = strengthSessionReducer(s, { kind: 'TICK', nowMs: 115_000 })
    expect(s.elapsedS).toBe(15)
  })
  it('does not resume decrementing the rest countdown after a backward jitter freezes it', () => {
    let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 100_000 })
    s = strengthSessionReducer(s, {
      kind: 'COMPLETE_SET',
      blockIdx: 0,
      setIdx: 0,
      nowMs: 105_000,
      restS: 90,
    })
    expect(s.restRemainingS).toBe(90)
    s = strengthSessionReducer(s, { kind: 'TICK', nowMs: 115_000 }) // elapsedS 0 -> 15
    expect(s.restRemainingS).toBe(75)
    // Backward jitter — elapsed clamps at 15, so no further decrement.
    s = strengthSessionReducer(s, { kind: 'TICK', nowMs: 108_000 })
    expect(s.restRemainingS).toBe(75)
    s = strengthSessionReducer(s, { kind: 'TICK', nowMs: 120_000 }) // elapsedS 15 -> 20
    expect(s.restRemainingS).toBe(70)
  })
  it('EDIT_SET_METRIC mutates the specific set field', () => {
    let s = freshSession()
    s = strengthSessionReducer(s, {
      kind: 'EDIT_SET_METRIC',
      blockIdx: 0,
      setIdx: 1,
      field: 'reps',
      value: 6,
    })
    s = strengthSessionReducer(s, {
      kind: 'EDIT_SET_METRIC',
      blockIdx: 0,
      setIdx: 1,
      field: 'loadKg',
      value: 105,
    })
    expect(s.blocks[0]!.sets[1]).toMatchObject({ reps: 6, loadKg: 105 })
  })
  it('EDIT_SET_METRIC edits calorie/distance/time fields', () => {
    let s = buildStrengthSession({
      sessionId: 'sess_test',
      templateName: 'Test',
      blocks: [{ ...bike }],
    })
    s = strengthSessionReducer(s, {
      kind: 'EDIT_SET_METRIC',
      blockIdx: 0,
      setIdx: 0,
      field: 'calories',
      value: 22,
    })
    expect(s.blocks[0]!.sets[0]).toMatchObject({ calories: 22, reps: null })
  })
  it('COMPLETE_SET marks done, kicks off rest, advances currentSetIdx', () => {
    let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 1000 })
    s = strengthSessionReducer(s, {
      kind: 'COMPLETE_SET',
      blockIdx: 0,
      setIdx: 0,
      nowMs: 2000,
      restS: 60,
    })
    expect(s.blocks[0]!.sets[0]!.done).toBe(true)
    expect(s.restRemainingS).toBe(60)
    expect(s.blocks[0]!.currentSetIdx).toBe(1)
  })
  it('COMPLETE_SET without restS falls back to the 90s default', () => {
    let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 1000 })
    s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 2000 })
    expect(s.restRemainingS).toBe(90)
    expect(s.restTotalS).toBe(90)
  })
  it('COMPLETE_SET with restS 0 skips the rest overlay entirely', () => {
    let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 1000 })
    s = strengthSessionReducer(s, {
      kind: 'COMPLETE_SET',
      blockIdx: 0,
      setIdx: 0,
      nowMs: 2000,
      restS: 0,
    })
    expect(s.restRemainingS).toBeNull()
    expect(s.restTotalS).toBe(0)
  })
  it('buildStrengthSession preserves a block-level restS prescription', () => {
    const s = buildStrengthSession({
      sessionId: 'sess_test',
      templateName: 'Test',
      blocks: [{ ...squat, restS: 120 }],
    })
    expect(s.blocks[0]!.restS).toBe(120)
    // Blocks without a prescription stay undefined (engine default).
    expect(freshSession().blocks[0]!.restS).toBeUndefined()
  })
  it('TICK decrements the rest counter without going below zero', () => {
    let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 1000 })
    s = strengthSessionReducer(s, {
      kind: 'COMPLETE_SET',
      blockIdx: 0,
      setIdx: 0,
      nowMs: 1000,
      restS: 30,
    })
    s = strengthSessionReducer(s, { kind: 'TICK', nowMs: 11_000 })
    expect(s.restRemainingS).toBe(20)
    s = strengthSessionReducer(s, { kind: 'TICK', nowMs: 31_000 })
    expect(s.restRemainingS).toBe(0)
    s = strengthSessionReducer(s, { kind: 'TICK', nowMs: 60_000 })
    expect(s.restRemainingS).toBe(0)
  })
  it('ADJUST_REST minus clamps to 1s (never auto-dismisses)', () => {
    let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 1000 })
    s = strengthSessionReducer(s, {
      kind: 'COMPLETE_SET',
      blockIdx: 0,
      setIdx: 0,
      nowMs: 1000,
      restS: 30,
    })
    s = strengthSessionReducer(s, { kind: 'ADJUST_REST', deltaS: -45 })
    expect(s.restRemainingS).toBe(1)
    expect(s.restTotalS).toBe(30) // minus never shrinks the ring total
  })
  it('ADJUST_REST plus grows restTotalS so the ring fraction holds', () => {
    let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 1000 })
    s = strengthSessionReducer(s, {
      kind: 'COMPLETE_SET',
      blockIdx: 0,
      setIdx: 0,
      nowMs: 1000,
      restS: 30,
    })
    s = strengthSessionReducer(s, { kind: 'ADJUST_REST', deltaS: 30 })
    expect(s.restRemainingS).toBe(60)
    expect(s.restTotalS).toBe(60)
  })
  it('START_REST opens a manual rest without completing a set', () => {
    let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 1000 })
    s = strengthSessionReducer(s, { kind: 'START_REST' })
    expect(s.restRemainingS).toBe(90)
    expect(s.restTotalS).toBe(90)
    expect(s.blocks[0]!.sets.every((set) => !set.done)).toBe(true)
    s = strengthSessionReducer(s, { kind: 'SKIP_REST' })
    s = strengthSessionReducer(s, { kind: 'START_REST', restS: 45 })
    expect(s.restRemainingS).toBe(45)
  })
  it('START_REST is a no-op outside running', () => {
    const pre = freshSession()
    expect(strengthSessionReducer(pre, { kind: 'START_REST' })).toBe(pre)
  })
  it('SKIP_REST clears the rest counter', () => {
    let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 1000 })
    s = strengthSessionReducer(s, {
      kind: 'COMPLETE_SET',
      blockIdx: 0,
      setIdx: 0,
      nowMs: 1000,
      restS: 30,
    })
    s = strengthSessionReducer(s, { kind: 'SKIP_REST' })
    expect(s.restRemainingS).toBeNull()
  })
  it('UNDO_SET re-opens a previously completed set', () => {
    let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 1000 })
    s = strengthSessionReducer(s, {
      kind: 'COMPLETE_SET',
      blockIdx: 0,
      setIdx: 0,
      nowMs: 1000,
    })
    s = strengthSessionReducer(s, { kind: 'UNDO_SET', blockIdx: 0, setIdx: 0 })
    expect(s.blocks[0]!.sets[0]!.done).toBe(false)
    expect(s.blocks[0]!.currentSetIdx).toBe(0)
  })
  it('FINISH transitions to done', () => {
    let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 1000 })
    s = strengthSessionReducer(s, { kind: 'FINISH', nowMs: 10_000 })
    expect(s.phase).toBe('done')
    expect(s.finishedAtMs).toBe(10_000)
  })
  it('REOPEN returns a done session to running, counting summary time as paused', () => {
    let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 1000 })
    s = strengthSessionReducer(s, { kind: 'FINISH', nowMs: 10_000 })
    s = strengthSessionReducer(s, { kind: 'REOPEN', nowMs: 25_000 })
    expect(s.phase).toBe('running')
    expect(s.finishedAtMs).toBeNull()
    // The 15s spent on the summary screen is paused time, not training.
    expect(s.pausedTotalMs).toBe(15_000)
    // Clock picks up where FINISH stopped it: 9s of training at finish
    // plus 2s after the reopen.
    s = strengthSessionReducer(s, { kind: 'TICK', nowMs: 27_000 })
    expect(s.elapsedS).toBe(11)
  })
  it('REOPEN clamps a negative clock-jitter gap to 0', () => {
    let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 1000 })
    s = strengthSessionReducer(s, { kind: 'FINISH', nowMs: 10_000 })
    s = strengthSessionReducer(s, { kind: 'REOPEN', nowMs: 9_000 })
    expect(s.phase).toBe('running')
    expect(s.pausedTotalMs).toBe(0)
  })
  it('REOPEN is a no-op outside the done phase', () => {
    const pre = freshSession()
    expect(strengthSessionReducer(pre, { kind: 'REOPEN', nowMs: 1000 })).toBe(pre)
    const running = strengthSessionReducer(pre, { kind: 'START', nowMs: 1000 })
    expect(strengthSessionReducer(running, { kind: 'REOPEN', nowMs: 2000 })).toBe(running)
  })
  it('strengthTonnage sums reps × load for completed sets only', () => {
    let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 1000 })
    s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 1000 })
    s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 1, nowMs: 1000 })
    expect(strengthTonnage(s)).toBe(2 * 5 * 100)
    expect(strengthSetsDone(s)).toBe(2)
  })
  it('strengthTonnage ignores completed non-rep (calorie) sets', () => {
    let s = buildStrengthSession({
      sessionId: 'sess_test',
      templateName: 'Test',
      blocks: [{ ...squat }, { ...bike }],
    })
    s = strengthSessionReducer(s, { kind: 'START', nowMs: 1000 })
    s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 1000 })
    s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 1, setIdx: 0, nowMs: 1000 })
    expect(strengthTonnage(s)).toBe(5 * 100)
    expect(strengthSetsDone(s)).toBe(2)
  })
  it('strengthTonnage excludes completed warmup sets', () => {
    let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 1000 })
    s = strengthSessionReducer(s, { kind: 'TOGGLE_SET_TYPE', blockIdx: 0, setIdx: 0 })
    expect(s.blocks[0]!.sets[0]!.setType).toBe('warmup')
    s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 1000 })
    s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 1, nowMs: 1000 })
    // Only the second (working) set's 5×100 counts; the first is warmup.
    expect(strengthTonnage(s)).toBe(5 * 100)
    // Toggling back to 'working' restores it to the tonnage total.
    s = strengthSessionReducer(s, { kind: 'TOGGLE_SET_TYPE', blockIdx: 0, setIdx: 0 })
    expect(s.blocks[0]!.sets[0]!.setType).toBe('working')
    expect(strengthTonnage(s)).toBe(2 * 5 * 100)
  })
  it('restoreStrengthSession backfills work-unit fields on legacy payloads', () => {
    const legacy = freshSession()
    const raw = JSON.stringify({
      ...legacy,
      blocks: legacy.blocks.map((b) => ({
        ...b,
        sets: b.sets.map(({ reps, loadKg, done, doneAtMs }) => ({ reps, loadKg, done, doneAtMs })),
      })),
    })
    const restored = restoreStrengthSession(raw)
    expect(restored).not.toBeNull()
    expect(restored!.blocks[0]!.sets[0]).toMatchObject({
      reps: 5,
      calories: null,
      distanceM: null,
      timeS: null,
    })
  })

  describe('serialize/restore round-trip', () => {
    it('round-trips a running session exactly', () => {
      let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 1000 })
      s = strengthSessionReducer(s, {
        kind: 'COMPLETE_SET',
        blockIdx: 0,
        setIdx: 0,
        nowMs: 1100,
        restS: 60,
      })
      const raw = serializeStrengthSession(s)
      const restored = restoreStrengthSession(raw)
      expect(restored).toEqual(s)
    })

    it('round-trips a pre-phase session', () => {
      const s = freshSession()
      expect(restoreStrengthSession(serializeStrengthSession(s))).toEqual(s)
    })

    it('returns null on malformed JSON', () => {
      expect(restoreStrengthSession('not json')).toBeNull()
    })

    it('returns null on a missing required field', () => {
      const raw = JSON.stringify({ phase: 'running' })
      expect(restoreStrengthSession(raw)).toBeNull()
    })

    it('returns null on an unknown phase', () => {
      const raw = JSON.stringify({
        ...freshSession(),
        phase: 'bogus',
      })
      expect(restoreStrengthSession(raw)).toBeNull()
    })

    it('returns null on a poisoned numeric field (negative / Infinity)', () => {
      // A crafted or corrupted blob with a negative or non-finite loadKg
      // would poison every tonnage / e1RM computation — reject it so the
      // caller clears the slot and starts fresh (epic #675).
      const neg = JSON.parse(serializeStrengthSession(freshSession())) as {
        blocks: Array<{ sets: Array<{ loadKg: number | null }> }>
      }
      neg.blocks[0]!.sets[0]!.loadKg = -5
      expect(restoreStrengthSession(JSON.stringify(neg))).toBeNull()

      // 1e999 parses to Infinity (JSON.stringify(Infinity) is "null", so a
      // crafted raw literal is the realistic vector).
      const inf = serializeStrengthSession(freshSession()).replace(
        /"loadKg":\s*100/,
        '"loadKg":1e999',
      )
      expect(restoreStrengthSession(inf)).toBeNull()
    })

    it('round-trips templateId and restores a pre-templateId blob to null', () => {
      // With a source template link.
      const linked = { ...freshSession(), templateId: 'wt_custom_1' }
      expect(restoreStrengthSession(serializeStrengthSession(linked))!.templateId).toBe(
        'wt_custom_1',
      )
      // Snapshot persisted before the field landed (key absent).
      const { templateId: _drop, ...legacy } = freshSession()
      expect(restoreStrengthSession(JSON.stringify(legacy))!.templateId).toBeNull()
      // Non-string junk in a hand-rolled blob is dropped, not kept.
      const junk = { ...freshSession(), templateId: 42 }
      expect(restoreStrengthSession(JSON.stringify(junk))!.templateId).toBeNull()
    })

    it('round-trips sourceTemplateId and backfills a pre-field blob to null', () => {
      // Benchmarks carry the done-detection link even without the
      // custom-only templateId.
      const bench = { ...freshSession(), sourceTemplateId: 'wt_bench_1' }
      expect(restoreStrengthSession(serializeStrengthSession(bench))!.sourceTemplateId).toBe(
        'wt_bench_1',
      )
      const { sourceTemplateId: _drop, ...legacy } = freshSession()
      expect(restoreStrengthSession(JSON.stringify(legacy))!.sourceTemplateId).toBeNull()
      const junk = { ...freshSession(), sourceTemplateId: 42 }
      expect(restoreStrengthSession(JSON.stringify(junk))!.sourceTemplateId).toBeNull()
    })

    it('restores a legacy blob without group/restAfterS/targetRpe (degrades to sequential)', () => {
      const legacy = freshSession()
      const restored = restoreStrengthSession(serializeStrengthSession(legacy))
      expect(restored).not.toBeNull()
      expect(bracketRange(restored!.blocks, 0)).toEqual([0, 0])
    })

    it('backfills pause + defaultRest fields on a pre-pause-era snapshot', () => {
      // Hand-frozen "old shape" JSON — exactly what the pre-C2 code
      // serialized (no pausedAtMs/pausedTotalMs/defaultRestS, numeric
      // loadKg). Restoring it must produce a valid new-shape state.
      const old = {
        phase: 'running',
        sessionId: 'sess_old',
        templateName: 'Legacy',
        blocks: [
          {
            exerciseId: 'fx_seed_back_squat',
            name: 'Back Squat',
            suggestedKg: null,
            suggestedBasis: null,
            currentSetIdx: 1,
            sets: [
              {
                reps: 5,
                calories: null,
                distanceM: null,
                timeS: null,
                inclinePct: null,
                loadKg: 100,
                done: true,
                doneAtMs: 5000,
              },
              {
                reps: 5,
                calories: null,
                distanceM: null,
                timeS: null,
                inclinePct: null,
                loadKg: 100,
                done: false,
                doneAtMs: null,
              },
            ],
          },
        ],
        currentBlockIdx: 0,
        startedAtMs: 1000,
        finishedAtMs: null,
        elapsedS: 42,
        restRemainingS: 30,
        restTotalS: 90,
      }
      const restored = restoreStrengthSession(JSON.stringify(old))
      expect(restored).not.toBeNull()
      expect(restored!.pausedAtMs).toBeNull()
      expect(restored!.pausedTotalMs).toBe(0)
      expect(restored!.defaultRestS).toBe(90)
      // …and the reducer accepts it directly.
      const ticked = strengthSessionReducer(restored!, { kind: 'TICK', nowMs: 50_000 })
      expect(ticked.elapsedS).toBeGreaterThanOrEqual(42)
    })

    it('a snapshot restored mid-pause stays paused', () => {
      let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 1000 })
      s = strengthSessionReducer(s, { kind: 'PAUSE', nowMs: 10_000 })
      const restored = restoreStrengthSession(serializeStrengthSession(s))
      expect(restored!.pausedAtMs).toBe(10_000)
      // Ticks while paused are no-ops even hours later.
      const ticked = strengthSessionReducer(restored!, { kind: 'TICK', nowMs: 9_000_000 })
      expect(ticked.elapsedS).toBe(s.elapsedS)
    })
  })

  describe('PAUSE / RESUME', () => {
    function running() {
      return strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 0 })
    }

    it('freezes the elapsed clock while paused and subtracts paused time after', () => {
      let s = running()
      s = strengthSessionReducer(s, { kind: 'TICK', nowMs: 10_000 })
      expect(s.elapsedS).toBe(10)
      s = strengthSessionReducer(s, { kind: 'PAUSE', nowMs: 10_000 })
      s = strengthSessionReducer(s, { kind: 'TICK', nowMs: 60_000 })
      expect(s.elapsedS).toBe(10) // frozen
      s = strengthSessionReducer(s, { kind: 'RESUME', nowMs: 70_000 })
      expect(s.pausedTotalMs).toBe(60_000)
      s = strengthSessionReducer(s, { kind: 'TICK', nowMs: 80_000 })
      expect(s.elapsedS).toBe(20) // 80s wall − 60s paused
    })

    it('freezes a running rest countdown while paused', () => {
      let s = running()
      s = strengthSessionReducer(s, {
        kind: 'COMPLETE_SET',
        blockIdx: 0,
        setIdx: 0,
        nowMs: 5_000,
        restS: 60,
      })
      s = strengthSessionReducer(s, { kind: 'TICK', nowMs: 10_000 })
      expect(s.restRemainingS).toBe(50)
      s = strengthSessionReducer(s, { kind: 'PAUSE', nowMs: 10_000 })
      s = strengthSessionReducer(s, { kind: 'TICK', nowMs: 40_000 })
      expect(s.restRemainingS).toBe(50)
      s = strengthSessionReducer(s, { kind: 'RESUME', nowMs: 40_000 })
      s = strengthSessionReducer(s, { kind: 'TICK', nowMs: 50_000 })
      expect(s.restRemainingS).toBe(40)
    })

    it('PAUSE is idempotent and gated to running', () => {
      const pre = freshSession()
      expect(strengthSessionReducer(pre, { kind: 'PAUSE', nowMs: 1 })).toBe(pre)
      let s = running()
      s = strengthSessionReducer(s, { kind: 'PAUSE', nowMs: 5 })
      const again = strengthSessionReducer(s, { kind: 'PAUSE', nowMs: 99 })
      expect(again.pausedAtMs).toBe(5)
    })

    it('RESUME clamps a negative clock delta to 0', () => {
      let s = running()
      s = strengthSessionReducer(s, { kind: 'PAUSE', nowMs: 10_000 })
      s = strengthSessionReducer(s, { kind: 'RESUME', nowMs: 8_000 })
      expect(s.pausedAtMs).toBeNull()
      expect(s.pausedTotalMs).toBe(0)
    })

    it('COMPLETE_SET while paused auto-resumes', () => {
      let s = running()
      s = strengthSessionReducer(s, { kind: 'PAUSE', nowMs: 10_000 })
      s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 25_000 })
      expect(s.pausedAtMs).toBeNull()
      expect(s.pausedTotalMs).toBe(15_000)
      expect(s.restRemainingS).toBe(90)
    })

    it('START_REST with nowMs while paused auto-resumes', () => {
      let s = running()
      s = strengthSessionReducer(s, { kind: 'PAUSE', nowMs: 10_000 })
      s = strengthSessionReducer(s, { kind: 'START_REST', nowMs: 12_000, restS: 45 })
      expect(s.pausedAtMs).toBeNull()
      expect(s.pausedTotalMs).toBe(2_000)
      expect(s.restRemainingS).toBe(45)
    })

    it('FINISH while paused folds the open pause and completes', () => {
      let s = running()
      s = strengthSessionReducer(s, { kind: 'PAUSE', nowMs: 10_000 })
      s = strengthSessionReducer(s, { kind: 'FINISH', nowMs: 30_000 })
      expect(s.phase).toBe('done')
      expect(s.pausedAtMs).toBeNull()
      expect(s.pausedTotalMs).toBe(20_000)
    })
  })

  describe('defaultRestS', () => {
    it('buildStrengthSession threads a custom default into COMPLETE_SET and START_REST', () => {
      let s = buildStrengthSession({
        sessionId: 'sess_t',
        templateName: 'T',
        blocks: [{ ...squat }],
        defaultRestS: 120,
      })
      s = strengthSessionReducer(s, { kind: 'START', nowMs: 0 })
      s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 1 })
      expect(s.restRemainingS).toBe(120)
      s = strengthSessionReducer(s, { kind: 'SKIP_REST' })
      s = strengthSessionReducer(s, { kind: 'START_REST' })
      expect(s.restRemainingS).toBe(120)
    })

    it('a block-level restS still beats the session default', () => {
      let s = buildStrengthSession({
        sessionId: 'sess_t',
        templateName: 'T',
        blocks: [{ ...squat, restS: 30 }],
        defaultRestS: 120,
      })
      s = strengthSessionReducer(s, { kind: 'START', nowMs: 0 })
      s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 1 })
      expect(s.restRemainingS).toBe(30)
    })

    it('defaultRestS 0 means no auto rest (and does not fall back to 90)', () => {
      let s = buildStrengthSession({
        sessionId: 'sess_t',
        templateName: 'T',
        blocks: [{ ...squat }],
        defaultRestS: 0,
      })
      expect(s.defaultRestS).toBe(0)
      s = strengthSessionReducer(s, { kind: 'START', nowMs: 0 })
      s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 1 })
      expect(s.restRemainingS).toBeNull()
    })
  })

  describe('SET_SESSION_REST (live rest-between-sets edit)', () => {
    function running(blocks: Omit<StrengthBlock, 'currentSetIdx'>[]) {
      const s = buildStrengthSession({ sessionId: 'sess_t', templateName: 'T', blocks })
      return strengthSessionReducer(s, { kind: 'START', nowMs: 0 })
    }

    it('updates the session default and stamps restS onto every block', () => {
      let s = running([{ ...squat, restS: 30 }, { ...bike }])
      s = strengthSessionReducer(s, { kind: 'SET_SESSION_REST', restS: 150 })
      expect(s.defaultRestS).toBe(150)
      expect(s.blocks.map((b) => b.restS)).toEqual([150, 150])
    })

    it('makes the NEXT completed set rest for the new duration', () => {
      let s = running([{ ...squat }])
      s = strengthSessionReducer(s, { kind: 'SET_SESSION_REST', restS: 120 })
      s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 1 })
      expect(s.restRemainingS).toBe(120)
    })

    it('leaves the currently-running countdown alone', () => {
      let s = running([{ ...squat }])
      s = strengthSessionReducer(s, { kind: 'START_REST', restS: 45 })
      expect(s.restRemainingS).toBe(45)
      s = strengthSessionReducer(s, { kind: 'SET_SESSION_REST', restS: 120 })
      // the active rest is unchanged; only future sets pick up 120
      expect(s.restRemainingS).toBe(45)
      expect(s.restTotalS).toBe(45)
    })

    it('preserves restAfterS / intraRestS (between-exercise + superset rests)', () => {
      let s = running([{ ...squat, restAfterS: 300, intraRestS: 10, group: 'A' }])
      s = strengthSessionReducer(s, { kind: 'SET_SESSION_REST', restS: 120 })
      expect(s.blocks[0]!.restAfterS).toBe(300)
      expect(s.blocks[0]!.intraRestS).toBe(10)
      expect(s.blocks[0]!.restS).toBe(120)
    })

    it('clamps to [0, 600]', () => {
      let s = running([{ ...squat }])
      s = strengthSessionReducer(s, { kind: 'SET_SESSION_REST', restS: 9999 })
      expect(s.defaultRestS).toBe(600)
      s = strengthSessionReducer(s, { kind: 'SET_SESSION_REST', restS: -5 })
      expect(s.defaultRestS).toBe(0)
    })
  })

  describe('ADD/REMOVE blocks and sets (mid-workout edits)', () => {
    function runningTwoBlocks() {
      let s = buildStrengthSession({
        sessionId: 'sess_t',
        templateName: 'T',
        blocks: [{ ...squat }, { ...bike }],
      })
      return strengthSessionReducer(s, { kind: 'START', nowMs: 0 })
    }

    it('ADD_BLOCK appends an ungrouped block with pointer at set 0', () => {
      let s = runningTwoBlocks()
      s = strengthSessionReducer(s, {
        kind: 'ADD_BLOCK',
        block: {
          exerciseId: 'fx_seed_bench_press',
          name: 'Bench Press',
          suggestedKg: null,
          suggestedBasis: null,
          sets: [repSet(8, null)],
        },
      })
      expect(s.blocks).toHaveLength(3)
      expect(s.blocks[2]!.currentSetIdx).toBe(0)
      expect(s.blocks[2]!.name).toBe('Bench Press')
    })

    it('ADD_BLOCK is gated to running', () => {
      const pre = freshSession()
      expect(
        strengthSessionReducer(pre, {
          kind: 'ADD_BLOCK',
          block: { ...squat },
        }),
      ).toBe(pre)
    })

    it('REMOVE_BLOCK before the current one shifts the pointer down', () => {
      let s = runningTwoBlocks()
      s = strengthSessionReducer(s, { kind: 'JUMP_TO_BLOCK', blockIdx: 1 })
      s = strengthSessionReducer(s, { kind: 'REMOVE_BLOCK', blockIdx: 0 })
      expect(s.blocks).toHaveLength(1)
      expect(s.currentBlockIdx).toBe(0)
      expect(s.blocks[0]!.name).toBe('Assault Bike')
    })

    it('REMOVE_BLOCK of the current last block clamps the pointer', () => {
      let s = runningTwoBlocks()
      s = strengthSessionReducer(s, { kind: 'JUMP_TO_BLOCK', blockIdx: 1 })
      s = strengthSessionReducer(s, { kind: 'REMOVE_BLOCK', blockIdx: 1 })
      expect(s.blocks).toHaveLength(1)
      expect(s.currentBlockIdx).toBe(0)
    })

    it('REMOVE_BLOCK never removes the last remaining block', () => {
      let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 0 })
      const after = strengthSessionReducer(s, { kind: 'REMOVE_BLOCK', blockIdx: 0 })
      expect(after).toBe(s)
    })

    it('REMOVE_BLOCK with done sets keeps derived tonnage consistent', () => {
      let s = runningTwoBlocks()
      s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 1 })
      expect(strengthTonnage(s)).toBe(500)
      s = strengthSessionReducer(s, { kind: 'REMOVE_BLOCK', blockIdx: 0 })
      expect(strengthTonnage(s)).toBe(0)
      expect(strengthSetsDone(s)).toBe(0)
    })

    it('ADD_SET clones the last set targets as a fresh undone set', () => {
      let s = runningTwoBlocks()
      s = strengthSessionReducer(s, {
        kind: 'EDIT_SET_METRIC',
        blockIdx: 0,
        setIdx: 2,
        field: 'rpe',
        value: 8,
      })
      s = strengthSessionReducer(s, { kind: 'ADD_SET', blockIdx: 0 })
      const added = s.blocks[0]!.sets[3]!
      expect(s.blocks[0]!.sets).toHaveLength(4)
      expect(added).toMatchObject({ reps: 5, loadKg: 100, done: false, doneAtMs: null, rpe: null })
    })

    it('ADD_SET on a MAX (amrap) set clears the achieved rep count', () => {
      // The previous set's `reps` on an amrap set is the ACHIEVED count
      // just entered — cloning it would arm the new set's check button
      // with reps never performed.
      const maxBlock = {
        exerciseId: 'fx_seed_bench',
        name: 'Bench',
        suggestedKg: null,
        suggestedBasis: null,
        sets: [{ ...repSet(null, 80), amrapTarget: true }],
      }
      let s = strengthSessionReducer(
        buildStrengthSession({ sessionId: 's', templateName: 'T', blocks: [maxBlock] }),
        { kind: 'START', nowMs: 0 },
      )
      s = strengthSessionReducer(s, {
        kind: 'EDIT_SET_METRIC',
        blockIdx: 0,
        setIdx: 0,
        field: 'reps',
        value: 15,
      })
      s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 1 })
      s = strengthSessionReducer(s, { kind: 'ADD_SET', blockIdx: 0 })
      const added = s.blocks[0]!.sets[1]!
      expect(added).toMatchObject({ reps: null, loadKg: 80, amrapTarget: true, done: false })
    })

    it('ADD_SET on a fully-done block moves the pointer to the new set', () => {
      let s = strengthSessionReducer(
        buildStrengthSession({
          sessionId: 's',
          templateName: 'T',
          blocks: [{ ...squat, sets: [repSet(5, 100)] }],
        }),
        { kind: 'START', nowMs: 0 },
      )
      s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 1 })
      s = strengthSessionReducer(s, { kind: 'ADD_SET', blockIdx: 0 })
      expect(s.blocks[0]!.currentSetIdx).toBe(1)
    })

    it('REMOVE_SET keeps at least one set and fixes the pointer', () => {
      let s = runningTwoBlocks()
      // Move the block pointer to set 2 by completing sets 0+1.
      s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 1 })
      s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 1, nowMs: 2 })
      expect(s.blocks[0]!.currentSetIdx).toBe(2)
      s = strengthSessionReducer(s, { kind: 'REMOVE_SET', blockIdx: 0, setIdx: 0 })
      expect(s.blocks[0]!.sets).toHaveLength(2)
      expect(s.blocks[0]!.currentSetIdx).toBe(1)
      // Shrink to a single set — further removals no-op.
      s = strengthSessionReducer(s, { kind: 'REMOVE_SET', blockIdx: 0, setIdx: 0 })
      expect(s.blocks[0]!.sets).toHaveLength(1)
      const after = strengthSessionReducer(s, { kind: 'REMOVE_SET', blockIdx: 0, setIdx: 0 })
      expect(after.blocks[0]!.sets).toHaveLength(1)
    })
  })

  describe('sessionFromStrengthBody (template body → runtime session)', () => {
    it('maps targets, rpe→targetRpe, amrap→amrapTarget, and block extras', () => {
      const s = sessionFromStrengthBody({
        sessionId: 'sess_b',
        templateName: 'SS Day',
        defaultRestS: 120,
        body: {
          kind: 'strength',
          blocks: [
            {
              exerciseId: 'fx_seed_back_squat',
              name: 'Back Squat',
              sets: [
                { reps: 5, loadKg: 100, rpe: 8 },
                { amrap: true, loadKg: 100 },
              ],
              restS: 90,
              restAfterS: 180,
              group: 'A',
            },
            { exerciseId: 'fx_seed_pull_up', name: 'Pull Up', sets: [{ reps: 8 }], group: 'A' },
          ],
        },
      })
      expect(s.phase).toBe('pre')
      expect(s.defaultRestS).toBe(120)
      expect(s.blocks[0]).toMatchObject({ restS: 90, restAfterS: 180, group: 'A' })
      expect(s.blocks[0]!.sets[0]).toMatchObject({ reps: 5, loadKg: 100, targetRpe: 8 })
      expect(s.blocks[0]!.sets[1]).toMatchObject({ reps: null, loadKg: 100, amrapTarget: true })
      // Missing load stays null (bodyweight/blank), not 0.
      expect(s.blocks[1]!.sets[0]!.loadKg).toBeNull()
      // Rep-based blocks may carry a weight suggestion; non-rep never do.
      expect(bracketRange(s.blocks, 0)).toEqual([0, 1])
    })

    it('an amrap set with an authored rep HINT still starts blank', () => {
      // The template's `reps` on an amrap set is a "last time you got N"
      // hint — pre-filling the achieved-reps input would let one stray
      // tap log a count the athlete never entered this session.
      const s = sessionFromStrengthBody({
        sessionId: 'sess_hint',
        templateName: 'Bench day',
        body: {
          kind: 'strength',
          blocks: [
            {
              exerciseId: 'fx_seed_barbell_bench_press',
              name: 'Barbell Bench Press',
              sets: [{ amrap: true, reps: 12, loadKg: 80 }],
            },
          ],
        },
      })
      expect(s.blocks[0]!.sets[0]).toMatchObject({
        reps: null,
        loadKg: 80,
        amrapTarget: true,
      })
    })
  })

  describe('pausedAwareElapsedMs', () => {
    it('running with no pauses: now - started', () => {
      expect(pausedAwareElapsedMs(1000, null, 0, 11_000)).toBe(10_000)
    })
    it('mid-pause: frozen at pausedAtMs regardless of now', () => {
      expect(pausedAwareElapsedMs(1000, 6_000, 0, 999_000)).toBe(5_000)
    })
    it('after accumulated pauses: paused time excluded', () => {
      expect(pausedAwareElapsedMs(1000, null, 4_000, 15_000)).toBe(10_000)
    })
    it('matches the reducer TICK clock across a pause cycle', () => {
      let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 0 })
      s = strengthSessionReducer(s, { kind: 'PAUSE', nowMs: 10_000 })
      s = strengthSessionReducer(s, { kind: 'RESUME', nowMs: 30_000 })
      s = strengthSessionReducer(s, { kind: 'TICK', nowMs: 40_000 })
      expect(s.elapsedS).toBe(20)
      expect(
        Math.floor(
          pausedAwareElapsedMs(s.startedAtMs!, s.pausedAtMs, s.pausedTotalMs, 40_000) / 1000,
        ),
      ).toBe(20)
    })
  })

  describe('null loadKg (bodyweight / blank input)', () => {
    it('EDIT_SET_METRIC null clears the load; tonnage skips it', () => {
      let s = strengthSessionReducer(freshSession(), { kind: 'START', nowMs: 0 })
      s = strengthSessionReducer(s, {
        kind: 'EDIT_SET_METRIC',
        blockIdx: 0,
        setIdx: 0,
        field: 'loadKg',
        value: null,
      })
      expect(s.blocks[0]!.sets[0]!.loadKg).toBeNull()
      s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 1 })
      s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 1, nowMs: 2 })
      expect(strengthTonnage(s)).toBe(500) // only set 2's 5×100
    })

    it('restore accepts a null loadKg and a snapshot missing loadKg', () => {
      const s = freshSession()
      const blob = JSON.parse(serializeStrengthSession(s)) as {
        blocks: Array<{ sets: Array<Record<string, unknown>> }>
      }
      blob.blocks[0]!.sets[0]!.loadKg = null
      delete blob.blocks[0]!.sets[1]!.loadKg
      const restored = restoreStrengthSession(JSON.stringify(blob))
      expect(restored).not.toBeNull()
      expect(restored!.blocks[0]!.sets[0]!.loadKg).toBeNull()
      expect(restored!.blocks[0]!.sets[1]!.loadKg).toBeNull()
    })
  })
})

// ── Superset brackets + interleaving ──────────────────────────────────

function mkBlock(
  name: string,
  setCount: number,
  extra: Partial<StrengthBlock> = {},
): Omit<StrengthBlock, 'currentSetIdx'> {
  return {
    exerciseId: `fx_${name.toLowerCase().replace(/\s+/g, '_')}`,
    name,
    suggestedKg: null,
    suggestedBasis: null,
    sets: Array.from({ length: setCount }, () => ({
      reps: 5,
      loadKg: 100,
      done: false,
      doneAtMs: null,
      setType: 'working' as const,
    })),
    ...extra,
  }
}

function supersetSession(blocks: Omit<StrengthBlock, 'currentSetIdx'>[]) {
  let s = buildStrengthSession({ sessionId: 'sess_ss', templateName: 'SS', blocks })
  s = strengthSessionReducer(s, { kind: 'START', nowMs: 1000 })
  return s
}

function complete(s: ReturnType<typeof supersetSession>, blockIdx: number, setIdx: number) {
  return strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx, setIdx, nowMs: 2000 })
}

describe('bracketRange', () => {
  it('groups consecutive same-letter blocks and isolates the rest', () => {
    const blocks = supersetSession([
      mkBlock('Squat', 3, { group: 'A' }),
      mkBlock('Pull-up', 3, { group: 'A' }),
      mkBlock('Press', 3),
      mkBlock('Row', 3, { group: 'B' }),
    ]).blocks
    expect(bracketRange(blocks, 0)).toEqual([0, 1])
    expect(bracketRange(blocks, 1)).toEqual([0, 1])
    expect(bracketRange(blocks, 2)).toEqual([2, 2])
    expect(bracketRange(blocks, 3)).toEqual([3, 3])
  })

  it('does NOT merge same-letter groups separated by another block', () => {
    const blocks = supersetSession([
      mkBlock('Squat', 3, { group: 'A' }),
      mkBlock('Press', 3),
      mkBlock('Row', 3, { group: 'A' }),
    ]).blocks
    expect(bracketRange(blocks, 0)).toEqual([0, 0])
    expect(bracketRange(blocks, 2)).toEqual([2, 2])
  })
})

describe('superset interleaving (COMPLETE_SET)', () => {
  it('hands off to the next bracket member with zero rest mid-pass', () => {
    let s = supersetSession([
      mkBlock('Squat', 2, { group: 'A', restS: 60, restAfterS: 180 }),
      mkBlock('Pull-up', 2, { group: 'A' }),
    ])
    s = complete(s, 0, 0) // A1 s1 → hand off to A2, no rest
    expect(s.currentBlockIdx).toBe(1)
    expect(s.restRemainingS).toBeNull()
    expect(s.restTotalS).toBe(0)
  })

  it('rests restS after a full pass, then loops back for the next pass', () => {
    let s = supersetSession([
      mkBlock('Squat', 2, { group: 'A', restS: 60, restAfterS: 180 }),
      mkBlock('Pull-up', 2, { group: 'A', restS: 45 }),
    ])
    s = complete(s, 0, 0)
    s = complete(s, 1, 0) // pass 1 complete → back to A1, pull-up's restS (45)
    expect(s.currentBlockIdx).toBe(0)
    expect(s.restRemainingS).toBe(45)
  })

  it('rests restAfterS when the bracket is exhausted, moving to the next block', () => {
    let s = supersetSession([
      mkBlock('Squat', 1, { group: 'A', restS: 60 }),
      mkBlock('Pull-up', 1, { group: 'A', restS: 45, restAfterS: 180 }),
      mkBlock('Press', 2),
    ])
    s = complete(s, 0, 0)
    s = complete(s, 1, 0) // bracket done → Press, pull-up's restAfterS
    expect(s.currentBlockIdx).toBe(2)
    expect(s.restRemainingS).toBe(180)
  })

  it('handles uneven set counts — the shorter member drops out of later passes', () => {
    let s = supersetSession([
      mkBlock('Squat', 3, { group: 'A', restS: 60 }),
      mkBlock('Pull-up', 1, { group: 'A' }),
    ])
    s = complete(s, 0, 0)
    expect(s.currentBlockIdx).toBe(1) // pass 1: A1 → A2
    s = complete(s, 1, 0)
    expect(s.currentBlockIdx).toBe(0) // A2 exhausted → back to A1
    s = complete(s, 0, 1)
    expect(s.currentBlockIdx).toBe(0) // A2 has nothing left: stay on A1
    expect(s.restRemainingS).toBe(60)
  })

  it('ungrouped blocks keep the sequential default: restS between sets, restAfterS after', () => {
    let s = supersetSession([
      mkBlock('Squat', 2, { restS: 120, restAfterS: 30 }),
      mkBlock('Press', 1),
    ])
    s = complete(s, 0, 0)
    expect(s.currentBlockIdx).toBe(0)
    expect(s.restRemainingS).toBe(120)
    s = complete(s, 0, 1)
    expect(s.currentBlockIdx).toBe(1)
    expect(s.restRemainingS).toBe(30)
  })

  it('restAfterS falls back to restS, then the 90s default', () => {
    const blocks = supersetSession([
      mkBlock('Squat', 1, { restS: 120 }),
      mkBlock('Press', 1),
    ]).blocks
    const doneBlocks = blocks.map((b, i) =>
      i === 0 ? { ...b, sets: b.sets.map((x) => ({ ...x, done: true })) } : b,
    )
    expect(advanceAfterComplete(doneBlocks, 0)).toEqual({ nextBlockIdx: 1, restS: 120 })
    const plain = doneBlocks.map((b) => {
      const { restS: _restS, ...rest } = b
      return rest as StrengthBlock
    })
    expect(advanceAfterComplete(plain, 0)).toEqual({ nextBlockIdx: 1, restS: 90 })
  })

  it('an explicit action.restS still overrides the computed rest', () => {
    let s = supersetSession([
      mkBlock('Squat', 2, { group: 'A' }),
      mkBlock('Pull-up', 2, { group: 'A' }),
    ])
    s = strengthSessionReducer(s, {
      kind: 'COMPLETE_SET',
      blockIdx: 0,
      setIdx: 0,
      nowMs: 2000,
      restS: 33,
    })
    expect(s.restRemainingS).toBe(33)
    expect(s.currentBlockIdx).toBe(1)
  })

  it('carries amrapTarget and achieved rpe through edits untouched', () => {
    const b = mkBlock('Squat', 1)
    b.sets[0]!.amrapTarget = true
    let s = supersetSession([b])
    s = strengthSessionReducer(s, {
      kind: 'EDIT_SET_METRIC',
      blockIdx: 0,
      setIdx: 0,
      field: 'rpe',
      value: 9,
    })
    expect(s.blocks[0]!.sets[0]!.amrapTarget).toBe(true)
    expect(s.blocks[0]!.sets[0]!.rpe).toBe(9)
  })

  it('carries targetRpe through build + edits untouched', () => {
    const b = mkBlock('Squat', 1)
    b.sets[0]!.targetRpe = 8.5
    let s = supersetSession([b])
    s = strengthSessionReducer(s, {
      kind: 'EDIT_SET_METRIC',
      blockIdx: 0,
      setIdx: 0,
      field: 'loadKg',
      value: 110,
    })
    expect(s.blocks[0]!.sets[0]!.targetRpe).toBe(8.5)
    expect(s.blocks[0]!.sets[0]!.loadKg).toBe(110)
  })
})

describe('intra-superset rest (intraRestS)', () => {
  it('mid-pass handoff rests the completed block intraRestS', () => {
    let s = supersetSession([
      mkBlock('Squat', 2, { group: 'A', restS: 60, intraRestS: 30 }),
      mkBlock('Pull-up', 2, { group: 'A' }),
    ])
    s = complete(s, 0, 0) // A1 s1 → A2 with 30s rest
    expect(s.currentBlockIdx).toBe(1)
    expect(s.restRemainingS).toBe(30)
    expect(s.restTotalS).toBe(30)
  })

  it('absent intraRestS keeps the classic zero-rest handoff (backward compat)', () => {
    let s = supersetSession([
      mkBlock('Squat', 2, { group: 'A', restS: 60 }),
      mkBlock('Pull-up', 2, { group: 'A' }),
    ])
    s = complete(s, 0, 0)
    expect(s.restRemainingS).toBeNull()
    expect(s.restTotalS).toBe(0)
  })

  it('does not affect pass loop-back (restS) or bracket exit (restAfterS)', () => {
    let s = supersetSession([
      mkBlock('Squat', 1, { group: 'A', intraRestS: 30, restS: 60 }),
      mkBlock('Pull-up', 1, { group: 'A', intraRestS: 25, restS: 45, restAfterS: 180 }),
      mkBlock('Press', 1),
    ])
    s = complete(s, 0, 0) // → A2, intra 30
    expect(s.restRemainingS).toBe(30)
    s = complete(s, 1, 0) // bracket exhausted → Press, restAfterS 180 (not 25)
    expect(s.currentBlockIdx).toBe(2)
    expect(s.restRemainingS).toBe(180)
  })

  it('is inert on ungrouped blocks (bracket of one has no mid-pass handoff)', () => {
    let s = supersetSession([mkBlock('Squat', 2, { intraRestS: 30, restS: 120 })])
    s = complete(s, 0, 0)
    expect(s.restRemainingS).toBe(120)
  })

  it('carries through sessionFromStrengthBody and serialize/restore', () => {
    const s = sessionFromStrengthBody({
      sessionId: 'sess_ss',
      templateName: 'SS',
      body: {
        kind: 'strength',
        blocks: [
          { exerciseId: 'fx_a', name: 'A', sets: [{ reps: 5 }], group: 'A', intraRestS: 45 },
          { exerciseId: 'fx_b', name: 'B', sets: [{ reps: 5 }], group: 'A' },
        ],
      },
    })
    expect(s.blocks[0]!.intraRestS).toBe(45)
    expect(s.blocks[1]!.intraRestS).toBeUndefined()
    const restored = restoreStrengthSession(serializeStrengthSession(s))
    expect(restored!.blocks[0]!.intraRestS).toBe(45)
  })
})

describe('ADD_BLOCKS (mid-workout superset add)', () => {
  it('appends at the end without a group when not a superset', () => {
    let s = supersetSession([mkBlock('Squat', 2)])
    s = strengthSessionReducer(s, { kind: 'ADD_BLOCKS', blocks: [mkBlock('Press', 3)] })
    expect(s.blocks.map((b) => b.name)).toEqual(['Squat', 'Press'])
    expect(s.blocks[1]!.group ?? null).toBeNull()
    expect(s.blocks[1]!.currentSetIdx).toBe(0)
  })

  it('stamps a fresh shared letter on a multi-block superset append', () => {
    let s = supersetSession([
      mkBlock('Squat', 2, { group: 'A' }),
      mkBlock('Row', 2, { group: 'A' }),
    ])
    s = strengthSessionReducer(s, {
      kind: 'ADD_BLOCKS',
      blocks: [mkBlock('Curl', 3), mkBlock('Dip', 3)],
      asSuperset: true,
    })
    expect(s.blocks.map((b) => b.group)).toEqual(['A', 'A', 'B', 'B'])
    expect(bracketRange(s.blocks, 2)).toEqual([2, 3])
  })

  it('skips used letters when picking the fresh group key', () => {
    const blocks = [
      mkBlock('Squat', 1, { group: 'A' }),
      mkBlock('Row', 1, { group: 'A' }),
      mkBlock('Press', 1, { group: 'B' }),
      mkBlock('Chin', 1, { group: 'B' }),
    ]
    let s = supersetSession(blocks)
    s = strengthSessionReducer(s, {
      kind: 'ADD_BLOCKS',
      blocks: [mkBlock('Curl', 1), mkBlock('Dip', 1)],
      asSuperset: true,
    })
    expect(s.blocks[4]!.group).toBe('C')
  })

  it('attaching to an ungrouped block forms a new bracket with it', () => {
    let s = supersetSession([mkBlock('Squat', 2), mkBlock('Press', 2)])
    s = strengthSessionReducer(s, {
      kind: 'ADD_BLOCKS',
      blocks: [mkBlock('Pull-up', 2)],
      attachTo: 0,
      asSuperset: true,
    })
    expect(s.blocks.map((b) => b.name)).toEqual(['Squat', 'Pull-up', 'Press'])
    expect(s.blocks[0]!.group).toBe('A')
    expect(s.blocks[1]!.group).toBe('A')
    expect(s.blocks[2]!.group ?? null).toBeNull()
    expect(bracketRange(s.blocks, 0)).toEqual([0, 1])
  })

  it('attaching to a grouped block inserts AFTER the whole bracket, adopting its key', () => {
    let s = supersetSession([
      mkBlock('Squat', 2, { group: 'A' }),
      mkBlock('Row', 2, { group: 'A' }),
      mkBlock('Press', 2),
    ])
    s = strengthSessionReducer(s, {
      kind: 'ADD_BLOCKS',
      blocks: [mkBlock('Curl', 2)],
      attachTo: 0, // first member — insertion must land after Row, not split A
      asSuperset: true,
    })
    expect(s.blocks.map((b) => b.name)).toEqual(['Squat', 'Row', 'Curl', 'Press'])
    expect(s.blocks[2]!.group).toBe('A')
    expect(bracketRange(s.blocks, 0)).toEqual([0, 2])
  })

  it('shifts currentBlockIdx when inserting at or before the pointer', () => {
    let s = supersetSession([mkBlock('Squat', 2), mkBlock('Press', 2)])
    s = strengthSessionReducer(s, { kind: 'JUMP_TO_BLOCK', blockIdx: 1 })
    s = strengthSessionReducer(s, {
      kind: 'ADD_BLOCKS',
      blocks: [mkBlock('Pull-up', 2)],
      attachTo: 0,
      asSuperset: true,
    })
    // Press moved from index 1 to 2; the pointer follows it.
    expect(s.blocks[s.currentBlockIdx]!.name).toBe('Press')
  })

  it('ignores empty payloads and out-of-range attach targets', () => {
    const s0 = supersetSession([mkBlock('Squat', 2)])
    expect(strengthSessionReducer(s0, { kind: 'ADD_BLOCKS', blocks: [] })).toBe(s0)
    const s1 = strengthSessionReducer(s0, {
      kind: 'ADD_BLOCKS',
      blocks: [mkBlock('Press', 1)],
      attachTo: 99,
      asSuperset: true,
    })
    // Falls back to append-at-end with a fresh group on both? No — an
    // invalid target means no join partner, so only the new blocks group.
    expect(s1.blocks.map((b) => b.name)).toEqual(['Squat', 'Press'])
    expect(s1.blocks[0]!.group ?? null).toBeNull()
  })

  it('no-ops outside the running phase', () => {
    const pre = buildStrengthSession({
      sessionId: 'x',
      templateName: 'X',
      blocks: [mkBlock('Squat', 1)],
    })
    expect(strengthSessionReducer(pre, { kind: 'ADD_BLOCKS', blocks: [mkBlock('P', 1)] })).toBe(pre)
  })
})

// ── MOVE_BLOCK (exercise reorder) ─────────────────────────────────────

describe('MOVE_BLOCK', () => {
  it('swaps two ungrouped blocks', () => {
    let s = supersetSession([mkBlock('Squat', 2), mkBlock('Press', 2)])
    s = strengthSessionReducer(s, { kind: 'MOVE_BLOCK', blockIdx: 1, dir: -1 })
    expect(s.blocks.map((b) => b.name)).toEqual(['Press', 'Squat'])
    s = strengthSessionReducer(s, { kind: 'MOVE_BLOCK', blockIdx: 0, dir: 1 })
    expect(s.blocks.map((b) => b.name)).toEqual(['Squat', 'Press'])
  })

  it('no-ops at the edges and on out-of-range indices', () => {
    const s = supersetSession([mkBlock('Squat', 2), mkBlock('Press', 2)])
    expect(strengthSessionReducer(s, { kind: 'MOVE_BLOCK', blockIdx: 0, dir: -1 })).toBe(s)
    expect(strengthSessionReducer(s, { kind: 'MOVE_BLOCK', blockIdx: 1, dir: 1 })).toBe(s)
    expect(strengthSessionReducer(s, { kind: 'MOVE_BLOCK', blockIdx: 5, dir: -1 })).toBe(s)
    expect(strengthSessionReducer(s, { kind: 'MOVE_BLOCK', blockIdx: -1, dir: 1 })).toBe(s)
  })

  it('moves a grouped block with its whole bracket as a unit', () => {
    let s = supersetSession([
      mkBlock('Squat', 2),
      mkBlock('Row', 2, { group: 'A' }),
      mkBlock('Press', 2, { group: 'A' }),
    ])
    // Moving the SECOND bracket member up moves the bracket past Squat.
    s = strengthSessionReducer(s, { kind: 'MOVE_BLOCK', blockIdx: 2, dir: -1 })
    expect(s.blocks.map((b) => b.name)).toEqual(['Row', 'Press', 'Squat'])
    expect(s.blocks.map((b) => b.group ?? null)).toEqual(['A', 'A', null])
  })

  it('lets an ungrouped block hop over an adjacent bracket without splitting it', () => {
    let s = supersetSession([
      mkBlock('Row', 2, { group: 'A' }),
      mkBlock('Press', 2, { group: 'A' }),
      mkBlock('Squat', 2),
    ])
    s = strengthSessionReducer(s, { kind: 'MOVE_BLOCK', blockIdx: 2, dir: -1 })
    expect(s.blocks.map((b) => b.name)).toEqual(['Squat', 'Row', 'Press'])
    expect(s.blocks.map((b) => b.group ?? null)).toEqual([null, 'A', 'A'])
  })

  it('keeps currentBlockIdx on the same logical block', () => {
    let s = supersetSession([mkBlock('Squat', 2), mkBlock('Press', 2), mkBlock('Curl', 2)])
    s = strengthSessionReducer(s, { kind: 'JUMP_TO_BLOCK', blockIdx: 1 })
    s = strengthSessionReducer(s, { kind: 'MOVE_BLOCK', blockIdx: 1, dir: -1 })
    // Press moved to index 0; the pointer follows it.
    expect(s.blocks[s.currentBlockIdx]!.name).toBe('Press')
    // Moving an unrelated pair keeps the pointer on Press too.
    s = strengthSessionReducer(s, { kind: 'MOVE_BLOCK', blockIdx: 2, dir: -1 })
    expect(s.blocks[s.currentBlockIdx]!.name).toBe('Press')
  })

  it('is gated on the running phase', () => {
    const pre = buildStrengthSession({
      sessionId: 'x',
      templateName: 'X',
      blocks: [mkBlock('Squat', 1), mkBlock('Press', 1)],
    })
    expect(strengthSessionReducer(pre, { kind: 'MOVE_BLOCK', blockIdx: 1, dir: -1 })).toBe(pre)
  })

  it('remaps a running set stopwatch across the move', () => {
    let s = supersetSession([mkBlock('Squat', 2), mkBlock('Erg', 2)])
    s = strengthSessionReducer(s, { kind: 'START_SET_TIMER', blockIdx: 1, setIdx: 0, nowMs: 2000 })
    s = strengthSessionReducer(s, { kind: 'MOVE_BLOCK', blockIdx: 1, dir: -1 })
    expect(s.setTimer).toMatchObject({ blockIdx: 0, setIdx: 0 })
  })
})

// ── Per-set stopwatch ─────────────────────────────────────────────────

function timeSet(timeS: number | null): Omit<StrengthBlock, 'currentSetIdx'>['sets'][number] {
  return {
    reps: null,
    calories: null,
    distanceM: null,
    timeS,
    inclinePct: null,
    loadKg: null,
    done: false,
    doneAtMs: null,
    setType: 'working',
    unit: 'timeS',
  }
}

function ergSession() {
  let s = buildStrengthSession({
    sessionId: 'sess_erg',
    templateName: 'Erg',
    blocks: [
      { ...mkBlock('Squat', 2) },
      {
        exerciseId: 'fx_seed_ski_erg',
        name: 'Ski Erg',
        suggestedKg: null,
        suggestedBasis: null,
        sets: [timeSet(null), timeSet(null)],
      },
    ],
  })
  return strengthSessionReducer(s, { kind: 'START', nowMs: 1000 })
}

describe('set stopwatch (START_SET_TIMER / STOP_SET_TIMER)', () => {
  it('start → stop banks elapsed seconds into timeS', () => {
    let s = ergSession()
    s = strengthSessionReducer(s, {
      kind: 'START_SET_TIMER',
      blockIdx: 1,
      setIdx: 0,
      nowMs: 10_000,
    })
    expect(s.setTimer).toMatchObject({ blockIdx: 1, setIdx: 0, startedAtMs: 10_000, baseTimeS: 0 })
    s = strengthSessionReducer(s, { kind: 'STOP_SET_TIMER', nowMs: 73_500 })
    expect(s.setTimer).toBeNull()
    expect(s.blocks[1]!.sets[0]!.timeS).toBe(63)
  })

  it('restart resumes from the banked time', () => {
    let s = ergSession()
    s = strengthSessionReducer(s, {
      kind: 'START_SET_TIMER',
      blockIdx: 1,
      setIdx: 0,
      nowMs: 10_000,
    })
    s = strengthSessionReducer(s, { kind: 'STOP_SET_TIMER', nowMs: 40_000 }) // 30s banked
    s = strengthSessionReducer(s, {
      kind: 'START_SET_TIMER',
      blockIdx: 1,
      setIdx: 0,
      nowMs: 100_000,
    })
    expect(s.setTimer!.baseTimeS).toBe(30)
    s = strengthSessionReducer(s, { kind: 'STOP_SET_TIMER', nowMs: 110_000 })
    expect(s.blocks[1]!.sets[0]!.timeS).toBe(40)
  })

  it('starting a watch on another set banks the first', () => {
    let s = ergSession()
    s = strengthSessionReducer(s, {
      kind: 'START_SET_TIMER',
      blockIdx: 1,
      setIdx: 0,
      nowMs: 10_000,
    })
    s = strengthSessionReducer(s, {
      kind: 'START_SET_TIMER',
      blockIdx: 1,
      setIdx: 1,
      nowMs: 25_000,
    })
    expect(s.blocks[1]!.sets[0]!.timeS).toBe(15)
    expect(s.setTimer).toMatchObject({ blockIdx: 1, setIdx: 1, baseTimeS: 0 })
  })

  it('COMPLETE_SET on the timed set banks its stopwatch first', () => {
    let s = ergSession()
    s = strengthSessionReducer(s, {
      kind: 'START_SET_TIMER',
      blockIdx: 1,
      setIdx: 0,
      nowMs: 10_000,
    })
    s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 1, setIdx: 0, nowMs: 55_000 })
    expect(s.setTimer).toBeNull()
    expect(s.blocks[1]!.sets[0]).toMatchObject({ done: true, timeS: 45 })
  })

  it('COMPLETE_SET on a DIFFERENT set leaves the watch running', () => {
    let s = ergSession()
    s = strengthSessionReducer(s, {
      kind: 'START_SET_TIMER',
      blockIdx: 1,
      setIdx: 0,
      nowMs: 10_000,
    })
    s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 20_000 })
    expect(s.setTimer).toMatchObject({ blockIdx: 1, setIdx: 0 })
  })

  it('PAUSE banks the running watch', () => {
    let s = ergSession()
    s = strengthSessionReducer(s, {
      kind: 'START_SET_TIMER',
      blockIdx: 1,
      setIdx: 0,
      nowMs: 10_000,
    })
    s = strengthSessionReducer(s, { kind: 'PAUSE', nowMs: 30_000 })
    expect(s.setTimer).toBeNull()
    expect(s.blocks[1]!.sets[0]!.timeS).toBe(20)
  })

  it('FINISH banks the running watch', () => {
    let s = ergSession()
    s = strengthSessionReducer(s, {
      kind: 'START_SET_TIMER',
      blockIdx: 1,
      setIdx: 0,
      nowMs: 10_000,
    })
    s = strengthSessionReducer(s, { kind: 'FINISH', nowMs: 50_000 })
    expect(s.setTimer).toBeNull()
    expect(s.blocks[1]!.sets[0]!.timeS).toBe(40)
  })

  it('no-ops on done sets, bad indices, and outside running', () => {
    let s = ergSession()
    s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 1, setIdx: 0, nowMs: 5000 })
    expect(
      strengthSessionReducer(s, { kind: 'START_SET_TIMER', blockIdx: 1, setIdx: 0, nowMs: 6000 })
        .setTimer,
    ).toBeNull()
    expect(
      strengthSessionReducer(s, { kind: 'START_SET_TIMER', blockIdx: 9, setIdx: 0, nowMs: 6000 })
        .setTimer,
    ).toBeNull()
    expect(strengthSessionReducer(s, { kind: 'STOP_SET_TIMER', nowMs: 6000 })).toBe(s)
  })

  it('REMOVE_BLOCK clears a watch on the removed block and shifts a later one', () => {
    let s = ergSession()
    s = strengthSessionReducer(s, {
      kind: 'START_SET_TIMER',
      blockIdx: 1,
      setIdx: 0,
      nowMs: 10_000,
    })
    const removedTimed = strengthSessionReducer(s, { kind: 'REMOVE_BLOCK', blockIdx: 1 })
    expect(removedTimed.setTimer).toBeNull()
    const removedOther = strengthSessionReducer(s, { kind: 'REMOVE_BLOCK', blockIdx: 0 })
    expect(removedOther.setTimer).toMatchObject({ blockIdx: 0, setIdx: 0 })
  })

  it('REMOVE_SET clears a watch on the removed set and shifts a later one', () => {
    let s = ergSession()
    s = strengthSessionReducer(s, {
      kind: 'START_SET_TIMER',
      blockIdx: 1,
      setIdx: 1,
      nowMs: 10_000,
    })
    const shifted = strengthSessionReducer(s, { kind: 'REMOVE_SET', blockIdx: 1, setIdx: 0 })
    expect(shifted.setTimer).toMatchObject({ blockIdx: 1, setIdx: 0 })
    const cleared = strengthSessionReducer(s, { kind: 'REMOVE_SET', blockIdx: 1, setIdx: 1 })
    expect(cleared.setTimer).toBeNull()
  })

  it('runningSetTimeS derives base + elapsed and clamps backward jitter', () => {
    const timer = { blockIdx: 0, setIdx: 0, startedAtMs: 10_000, baseTimeS: 30 }
    expect(runningSetTimeS(timer, 25_500)).toBe(45)
    expect(runningSetTimeS(timer, 9_000)).toBe(30)
  })

  it('round-trips through serialize/restore and drops out-of-range timers', () => {
    let s = ergSession()
    s = strengthSessionReducer(s, {
      kind: 'START_SET_TIMER',
      blockIdx: 1,
      setIdx: 0,
      nowMs: 10_000,
    })
    const restored = restoreStrengthSession(serializeStrengthSession(s))
    expect(restored!.setTimer).toMatchObject({ blockIdx: 1, setIdx: 0, startedAtMs: 10_000 })
    // A timer pointing at a set that no longer exists is dropped.
    const mangled = { ...s, setTimer: { blockIdx: 9, setIdx: 0, startedAtMs: 1, baseTimeS: 0 } }
    expect(restoreStrengthSession(serializeStrengthSession(mangled))!.setTimer).toBeNull()
    // Pre-stopwatch snapshots backfill null.
    const legacy = JSON.parse(serializeStrengthSession(s)) as Record<string, unknown>
    delete legacy['setTimer']
    expect(restoreStrengthSession(JSON.stringify(legacy))!.setTimer).toBeNull()
  })
})

// ── Set unit hint ─────────────────────────────────────────────────────

describe('strengthSetUnit', () => {
  it('prefers the explicit hint over field inference', () => {
    expect(
      strengthSetUnit({ reps: null, calories: 12, distanceM: null, timeS: 60, unit: 'timeS' }),
    ).toBe('timeS')
  })
  it('falls back to field-priority inference without a hint', () => {
    expect(strengthSetUnit({ reps: 5, calories: null, distanceM: null, timeS: null })).toBe('reps')
    expect(strengthSetUnit({ reps: null, calories: 12, distanceM: null, timeS: null })).toBe(
      'calories',
    )
    expect(strengthSetUnit({ reps: null, calories: null, distanceM: 500, timeS: null })).toBe(
      'distanceM',
    )
    expect(strengthSetUnit({ reps: null, calories: null, distanceM: null, timeS: 60 })).toBe(
      'timeS',
    )
    expect(strengthSetUnit({ reps: null, calories: null, distanceM: null, timeS: null })).toBe(
      'reps',
    )
  })
  it('survives serialize/restore; invalid hints are stripped', () => {
    let s = ergSession()
    const restored = restoreStrengthSession(serializeStrengthSession(s))!
    expect(restored.blocks[1]!.sets[0]!.unit).toBe('timeS')
    const raw = JSON.parse(serializeStrengthSession(s)) as {
      blocks: { sets: { unit?: string }[] }[]
    }
    raw.blocks[1]!.sets[0]!.unit = 'bogus'
    const cleaned = restoreStrengthSession(JSON.stringify(raw))!
    expect(cleaned.blocks[1]!.sets[0]!.unit).toBeUndefined()
  })
})

// ── Blank (zero-block) sessions ───────────────────────────────────────

describe('empty-blocks session (blank free strength start)', () => {
  function blank() {
    const s = buildStrengthSession({
      sessionId: 'sess_blank',
      templateName: 'Free strength',
      blocks: [],
    })
    return strengthSessionReducer(s, { kind: 'START', nowMs: 1000 })
  }

  it('starts, ticks, and serializes with zero blocks', () => {
    let s = blank()
    expect(s.phase).toBe('running')
    s = strengthSessionReducer(s, { kind: 'TICK', nowMs: 5000 })
    expect(s.elapsedS).toBe(4)
    expect(strengthSetsDone(s)).toBe(0)
    expect(strengthTonnage(s)).toBe(0)
    const restored = restoreStrengthSession(serializeStrengthSession(s))
    expect(restored!.blocks).toEqual([])
  })

  it('JUMP_TO_BLOCK clamps to 0 rather than -1', () => {
    const s = strengthSessionReducer(blank(), { kind: 'JUMP_TO_BLOCK', blockIdx: 3 })
    expect(s.currentBlockIdx).toBe(0)
  })

  it('ADD_BLOCKS into an empty session points at the first added block', () => {
    let s = strengthSessionReducer(blank(), {
      kind: 'ADD_BLOCKS',
      blocks: [mkBlock('Squat', 2), mkBlock('Press', 2)],
    })
    expect(s.blocks).toHaveLength(2)
    expect(s.currentBlockIdx).toBe(0)
  })

  it('MOVE_BLOCK / REMOVE_BLOCK no-op on an empty session', () => {
    const s = blank()
    expect(strengthSessionReducer(s, { kind: 'MOVE_BLOCK', blockIdx: 0, dir: 1 })).toBe(s)
    expect(strengthSessionReducer(s, { kind: 'REMOVE_BLOCK', blockIdx: 0 })).toBe(s)
  })
})

describe('nextUpLabel', () => {
  function running(blocks: Omit<StrengthBlock, 'currentSetIdx'>[]) {
    const s = buildStrengthSession({ sessionId: 'sess_t', templateName: 'T', blocks })
    return strengthSessionReducer(s, { kind: 'START', nowMs: 0 })
  }
  const complete = (s: ReturnType<typeof running>, blockIdx: number, setIdx: number) =>
    strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx, setIdx, nowMs: 1 })

  it('names the next set mid-block', () => {
    let s = running([{ ...squat }, { ...bike }])
    s = complete(s, 0, 0)
    expect(nextUpLabel(s)).toBe('Back Squat · set 2')
  })

  it('names the next exercise after the last set of a block', () => {
    let s = running([{ ...squat }, { ...bike }])
    s = complete(s, 0, 0)
    s = complete(s, 0, 1)
    s = complete(s, 0, 2)
    expect(nextUpLabel(s)).toBe('Assault Bike · set 1')
  })

  it('is empty after the last set of the whole session (→ "Back to work.")', () => {
    let s = running([{ ...bike }])
    s = complete(s, 0, 0)
    s = complete(s, 0, 1)
    // advanceAfterComplete stays put when everything is done — the label
    // must NOT name the set the athlete just finished.
    expect(nextUpLabel(s)).toBe('')
  })

  it('points at a skipped earlier set when the visually-last set completes first', () => {
    let s = running([{ ...squat }, { ...bike }])
    s = complete(s, 0, 1)
    s = complete(s, 0, 2) // set 1 still undone; raw pointer clamps to the just-done set
    expect(nextUpLabel(s)).toBe('Back Squat · set 1')
  })

  it('is empty for an empty session', () => {
    const s = buildStrengthSession({ sessionId: 'sess_t', templateName: 'T', blocks: [] })
    expect(nextUpLabel(s)).toBe('')
  })
})

describe('APPLY_SUGGESTED_LOAD (accept the SUGGESTED strip)', () => {
  function running(blocks: Omit<StrengthBlock, 'currentSetIdx'>[]) {
    return strengthSessionReducer(
      buildStrengthSession({ sessionId: 'sess_t', templateName: 'T', blocks }),
      { kind: 'START', nowMs: 1000 },
    )
  }

  it('writes suggestedKg into every undone working rep set', () => {
    const s = running([
      {
        ...squat,
        suggestedKg: 102.5,
        sets: [repSet(5, 100), repSet(5, null), repSet(5, 90)],
      },
    ])
    const next = strengthSessionReducer(s, { kind: 'APPLY_SUGGESTED_LOAD', blockIdx: 0 })
    expect(next.blocks[0]!.sets.map((x) => x.loadKg)).toEqual([102.5, 102.5, 102.5])
    // Reps and everything else stay untouched.
    expect(next.blocks[0]!.sets.map((x) => x.reps)).toEqual([5, 5, 5])
  })

  it('skips done sets, warmups, and non-rep work', () => {
    const doneSet = { ...repSet(5, 100), done: true, doneAtMs: 5 }
    const warmup = { ...repSet(10, 60), setType: 'warmup' as const }
    const s = running([
      { ...squat, suggestedKg: 110, sets: [doneSet, warmup, repSet(5, 100)] },
      { ...bike, suggestedKg: 110 },
    ])
    const next = strengthSessionReducer(s, { kind: 'APPLY_SUGGESTED_LOAD', blockIdx: 0 })
    expect(next.blocks[0]!.sets.map((x) => x.loadKg)).toEqual([100, 60, 110])
    const cardio = strengthSessionReducer(s, { kind: 'APPLY_SUGGESTED_LOAD', blockIdx: 1 })
    expect(cardio.blocks[1]!.sets.map((x) => x.loadKg)).toEqual([0, 0])
  })

  it('only touches the addressed block', () => {
    const s = running([
      { ...squat, suggestedKg: 110 },
      { ...squat, exerciseId: 'fx2', suggestedKg: 120 },
    ])
    const next = strengthSessionReducer(s, { kind: 'APPLY_SUGGESTED_LOAD', blockIdx: 1 })
    expect(next.blocks[0]!.sets.map((x) => x.loadKg)).toEqual([100, 100, 100])
    expect(next.blocks[1]!.sets.map((x) => x.loadKg)).toEqual([120, 120, 120])
  })

  it('prefers an explicit display-snapped kg over the raw suggestion', () => {
    // The UI snaps the shown value to the display unit's plate increment
    // (5 lb / 2.5 kg) and passes the matching kg so rows land on exactly
    // the number the strip showed.
    const s = running([{ ...squat, suggestedKg: 44.9, sets: [repSet(5, null)] }])
    const next = strengthSessionReducer(s, {
      kind: 'APPLY_SUGGESTED_LOAD',
      blockIdx: 0,
      kg: 45.36,
    })
    expect(next.blocks[0]!.sets[0]!.loadKg).toBe(45.36)
    // A junk explicit value no-ops rather than poisoning the session.
    expect(
      strengthSessionReducer(s, { kind: 'APPLY_SUGGESTED_LOAD', blockIdx: 0, kg: Number.NaN }),
    ).toBe(s)
  })

  it('no-ops (same reference) without a suggestion, on a bad index, or when already applied', () => {
    const noSuggestion = running([{ ...squat, suggestedKg: null }])
    expect(
      strengthSessionReducer(noSuggestion, { kind: 'APPLY_SUGGESTED_LOAD', blockIdx: 0 }),
    ).toBe(noSuggestion)
    const s = running([{ ...squat, suggestedKg: 100 }])
    expect(strengthSessionReducer(s, { kind: 'APPLY_SUGGESTED_LOAD', blockIdx: 5 })).toBe(s)
    // Every fillable set already carries the suggestion — identity.
    expect(strengthSessionReducer(s, { kind: 'APPLY_SUGGESTED_LOAD', blockIdx: 0 })).toBe(s)
  })
})

describe('historyPrefill directive restore', () => {
  it('round-trips the literal override directive and strips junk values', () => {
    const s = buildStrengthSession({
      sessionId: 'sess_t',
      templateName: 'T',
      blocks: [{ ...squat, historyPrefill: 'override' }, { ...bike }],
    })
    const restored = restoreStrengthSession(serializeStrengthSession(s))!
    expect(restored.blocks[0]!.historyPrefill).toBe('override')
    expect(restored.blocks[1]!.historyPrefill).toBeUndefined()

    const junk = JSON.parse(serializeStrengthSession(s)) as {
      blocks: { historyPrefill?: unknown }[]
    }
    junk.blocks[0]!.historyPrefill = 'everything'
    const cleaned = restoreStrengthSession(JSON.stringify(junk))!
    expect(cleaned.blocks[0]!.historyPrefill).toBeUndefined()
  })
})

describe('historyPrefill disarm on athlete interaction', () => {
  function armedRunning() {
    const s = buildStrengthSession({
      sessionId: 'sess_t',
      templateName: 'T',
      blocks: [
        { ...squat, historyPrefill: 'override' },
        { ...squat, exerciseId: 'fx2', historyPrefill: 'override' },
      ],
    })
    return strengthSessionReducer(s, { kind: 'START', nowMs: 1000 })
  }

  it('EDIT_SET_METRIC strips the directive from the edited block only', () => {
    const next = strengthSessionReducer(armedRunning(), {
      kind: 'EDIT_SET_METRIC',
      blockIdx: 0,
      setIdx: 0,
      field: 'loadKg',
      value: 80,
    })
    expect(next.blocks[0]!.historyPrefill).toBeUndefined()
    expect(next.blocks[1]!.historyPrefill).toBe('override')
  })

  it('COMPLETE_SET and APPLY_SUGGESTED_LOAD strip it too', () => {
    const completed = strengthSessionReducer(armedRunning(), {
      kind: 'COMPLETE_SET',
      blockIdx: 0,
      setIdx: 0,
      nowMs: 2000,
    })
    expect(completed.blocks[0]!.historyPrefill).toBeUndefined()
    expect(completed.blocks[1]!.historyPrefill).toBe('override')

    const applied = strengthSessionReducer(armedRunning(), {
      kind: 'APPLY_SUGGESTED_LOAD',
      blockIdx: 1,
      kg: 110,
    })
    expect(applied.blocks[1]!.historyPrefill).toBeUndefined()
    expect(applied.blocks[0]!.historyPrefill).toBe('override')
  })

  it('ADD_SET, REMOVE_SET, and TOGGLE_SET_TYPE strip it as well', () => {
    const added = strengthSessionReducer(armedRunning(), { kind: 'ADD_SET', blockIdx: 0 })
    expect(added.blocks[0]!.historyPrefill).toBeUndefined()
    const removed = strengthSessionReducer(armedRunning(), {
      kind: 'REMOVE_SET',
      blockIdx: 0,
      setIdx: 2,
    })
    expect(removed.blocks[0]!.historyPrefill).toBeUndefined()
    const toggled = strengthSessionReducer(armedRunning(), {
      kind: 'TOGGLE_SET_TYPE',
      blockIdx: 0,
      setIdx: 0,
    })
    expect(toggled.blocks[0]!.historyPrefill).toBeUndefined()
  })
})

describe('historyPrefill survives non-interactive actions', () => {
  it('UNDO_SET does not disarm (unreachable while armed, asserted for the contract)', () => {
    const s = strengthSessionReducer(
      buildStrengthSession({
        sessionId: 'sess_t',
        templateName: 'T',
        blocks: [{ ...squat, historyPrefill: 'override' }],
      }),
      { kind: 'START', nowMs: 1000 },
    )
    const undone = strengthSessionReducer(s, { kind: 'UNDO_SET', blockIdx: 0, setIdx: 0 })
    expect(undone.blocks[0]!.historyPrefill).toBe('override')
  })

  it('an out-of-range EDIT_SET_METRIC / TOGGLE_SET_TYPE is a no-op that keeps the directive', () => {
    const s = strengthSessionReducer(
      buildStrengthSession({
        sessionId: 'sess_t',
        templateName: 'T',
        blocks: [{ ...squat, historyPrefill: 'override' }],
      }),
      { kind: 'START', nowMs: 1000 },
    )
    const edited = strengthSessionReducer(s, {
      kind: 'EDIT_SET_METRIC',
      blockIdx: 0,
      setIdx: 99,
      field: 'loadKg',
      value: 80,
    })
    expect(edited.blocks[0]).toBe(s.blocks[0])
    const toggled = strengthSessionReducer(s, {
      kind: 'TOGGLE_SET_TYPE',
      blockIdx: 0,
      setIdx: 99,
    })
    expect(toggled.blocks[0]).toBe(s.blocks[0])
  })
})

describe('setTakesSuggestedLoad', () => {
  it('accepts only undone working rep sets — the one rule the reducer and Use pill share', () => {
    expect(setTakesSuggestedLoad(repSet(5, 100))).toBe(true)
    expect(setTakesSuggestedLoad({ ...repSet(5, 100), done: true })).toBe(false)
    expect(setTakesSuggestedLoad({ ...repSet(5, 100), setType: 'warmup' as const })).toBe(false)
    expect(setTakesSuggestedLoad(calSet(15))).toBe(false)
    // A fully-blank set infers 'reps' (strengthSetUnit fallback).
    expect(setTakesSuggestedLoad(repSet(null, null))).toBe(true)
  })
})
