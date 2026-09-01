import { describe, expect, it } from 'vitest'
import type { ExerciseHistorySession } from './insights.js'
import {
  armHistoryPrefillOverride,
  lastLoadedSession,
  prefillBlockFromHistory,
  prefillSessionFromHistory,
  topSetOf,
} from './strength-prefill.js'
import type { StrengthBlock, StrengthSessionState, StrengthSet } from './strength-session.js'

function set(overrides: Partial<StrengthSet> = {}): StrengthSet {
  return {
    reps: null,
    calories: null,
    distanceM: null,
    timeS: null,
    inclinePct: null,
    loadKg: null,
    done: false,
    doneAtMs: null,
    setType: 'working',
    ...overrides,
  }
}

function block(overrides: Partial<StrengthBlock> = {}): StrengthBlock {
  return {
    exerciseId: 'ex1',
    name: 'Back Squat',
    suggestedKg: null,
    suggestedBasis: null,
    sets: [set({ reps: 5 }), set({ reps: 5 }), set({ reps: 5 })],
    currentSetIdx: 0,
    ...overrides,
  }
}

function historySession(
  sets: Array<{ reps: number | null; loadKg: number | null }>,
  performedAt = '2026-08-30T10:00:00Z',
): ExerciseHistorySession {
  return {
    workoutId: 'w1',
    workoutTitle: null,
    performedAt,
    sets: sets.map((s) => ({ ...s, rpe: null })),
  }
}

function state(blocks: StrengthBlock[]): StrengthSessionState {
  return {
    phase: 'running',
    sessionId: 's1',
    templateName: 'T',
    templateId: null,
    sourceTemplateId: null,
    blocks,
    currentBlockIdx: 0,
    startedAtMs: 0,
    finishedAtMs: null,
    elapsedS: 0,
    restRemainingS: null,
    restTotalS: 0,
    pausedAtMs: null,
    pausedTotalMs: 0,
    defaultRestS: 90,
    setTimer: null,
  }
}

describe('lastLoadedSession', () => {
  it('returns the newest session with a positive load, skipping bodyweight-only ones', () => {
    const bw = historySession([{ reps: 10, loadKg: null }], '2026-08-30T10:00:00Z')
    const loaded = historySession([{ reps: 5, loadKg: 100 }], '2026-08-20T10:00:00Z')
    expect(lastLoadedSession([bw, loaded])).toBe(loaded)
  })

  it('returns null when every session is unloaded, empty, or undefined', () => {
    expect(lastLoadedSession(undefined)).toBeNull()
    expect(lastLoadedSession([])).toBeNull()
    expect(
      lastLoadedSession([historySession([{ reps: 10, loadKg: 0 }, { reps: 8, loadKg: null }])]),
    ).toBeNull()
  })
})

describe('topSetOf', () => {
  it('picks the heaviest set, breaking ties toward more reps', () => {
    const s = historySession([
      { reps: 5, loadKg: 100 },
      { reps: 8, loadKg: 100 },
      { reps: 3, loadKg: 90 },
    ])
    expect(topSetOf(s)).toEqual({ reps: 8, loadKg: 100 })
  })

  it('ignores rep-less or unloaded sets; null when nothing qualifies', () => {
    expect(topSetOf(null)).toBeNull()
    expect(topSetOf(historySession([{ reps: null, loadKg: 120 }]))).toBeNull()
    expect(topSetOf(historySession([{ reps: 10, loadKg: 0 }]))).toBeNull()
  })
})

describe('prefillBlockFromHistory', () => {
  const hist = [
    historySession([
      { reps: 5, loadKg: 100 },
      { reps: 5, loadKg: 105 },
      { reps: 3, loadKg: 110 },
    ]),
  ]

  it('fills blank loads set-wise from the same index', () => {
    const out = prefillBlockFromHistory(block(), hist)
    expect(out.sets.map((s) => s.loadKg)).toEqual([100, 105, 110])
  })

  it('falls back to the last loaded set when history is shorter than the template', () => {
    const b = block({ sets: [set({ reps: 5 }), set({ reps: 5 })] })
    const short = [historySession([{ reps: 5, loadKg: 80 }])]
    const out = prefillBlockFromHistory(b, short)
    expect(out.sets.map((s) => s.loadKg)).toEqual([80, 80])
  })

  it('never overwrites a non-null load — including a deliberate 0', () => {
    const b = block({
      sets: [set({ reps: 5, loadKg: 60 }), set({ reps: 5, loadKg: 0 }), set({ reps: 5 })],
    })
    const out = prefillBlockFromHistory(b, hist)
    expect(out.sets.map((s) => s.loadKg)).toEqual([60, 0, 110])
  })

  it('skips done and warmup sets', () => {
    const b = block({
      sets: [
        set({ reps: 5, done: true, doneAtMs: 1 }),
        set({ reps: 5, setType: 'warmup' }),
        set({ reps: 5 }),
      ],
    })
    const out = prefillBlockFromHistory(b, hist)
    expect(out.sets[0]!.loadKg).toBeNull()
    expect(out.sets[1]!.loadKg).toBeNull()
    // The done set consumed working ordinal 0 and the warmup none, so
    // the fillable set maps to history working set 1.
    expect(out.sets[2]!.loadKg).toBe(105)
  })

  it('fills blank reps but leaves MAX (amrapTarget) sets blank', () => {
    const b = block({
      sets: [set({ unit: 'reps' }), set({ unit: 'reps', amrapTarget: true })],
    })
    const out = prefillBlockFromHistory(b, hist)
    expect(out.sets[0]!.reps).toBe(5)
    expect(out.sets[0]!.loadKg).toBe(100)
    expect(out.sets[1]!.reps).toBeNull()
  })

  it('skips cardio blocks entirely', () => {
    const b = block({ sets: [set({ timeS: 300, unit: 'timeS' })] })
    expect(prefillBlockFromHistory(b, hist)).toBe(b)
  })

  it('computes the SUGGESTED strip from the top set when unset, and leaves an existing one alone', () => {
    const out = prefillBlockFromHistory(block(), hist)
    expect(out.suggestedKg).not.toBeNull()
    expect(out.suggestedBasis).toContain('last 110')
    // Structured basis fields ride along so the UI can rebuild the
    // line in the athlete's display unit.
    expect(out.suggestedLastKg).toBe(110)
    expect(out.suggestedBumpKg).toBeNull()

    const preset = block({ suggestedKg: 42, suggestedBasis: 'preset' })
    const kept = prefillBlockFromHistory(preset, hist)
    expect(kept.suggestedKg).toBe(42)
    expect(kept.suggestedBasis).toBe('preset')
  })

  it('aligns by working-set ordinal — warmups do not shift the mapping', () => {
    // History holds working sets only, so a leading warmup must not
    // push working set 1 onto history row 2.
    const b = block({
      sets: [set({ reps: 5, setType: 'warmup' }), set({ reps: 5 }), set({ reps: 5 })],
    })
    const out = prefillBlockFromHistory(b, hist)
    expect(out.sets.map((s) => s.loadKg)).toEqual([null, 100, 105])
  })

  it('done sets still consume a working ordinal', () => {
    const b = block({
      sets: [set({ reps: 5, done: true, doneAtMs: 1, loadKg: 97.5 }), set({ reps: 5 })],
    })
    const out = prefillBlockFromHistory(b, hist)
    expect(out.sets[0]!.loadKg).toBe(97.5)
    expect(out.sets[1]!.loadKg).toBe(105)
  })

  it('a cardio set among rep sets consumes a working ordinal', () => {
    const b = block({
      sets: [set({ reps: 5 }), set({ timeS: 60, unit: 'timeS' }), set({ reps: 5 })],
    })
    const out = prefillBlockFromHistory(b, hist)
    expect(out.sets.map((s) => s.loadKg)).toEqual([100, null, 110])
  })

  it('falls back past an unloaded history row at the matching ordinal', () => {
    const gappy = [
      historySession([
        { reps: 10, loadKg: null },
        { reps: 5, loadKg: 90 },
      ]),
    ]
    const out = prefillBlockFromHistory(block({ sets: [set({ reps: 5 })] }), gappy)
    expect(out.sets[0]!.loadKg).toBe(90)
  })

  it('suggests for an all-MAX block off the history top set (reps stay blank)', () => {
    // Amrap sets never prefill reps, so the block has no rep target to
    // anchor on — the top set's own reps stand in, suggesting the load
    // to repeat it.
    const b = block({
      sets: [set({ unit: 'reps', amrapTarget: true }), set({ unit: 'reps', amrapTarget: true })],
    })
    const out = prefillBlockFromHistory(b, hist)
    expect(out.suggestedKg).not.toBeNull()
    expect(out.suggestedLastKg).toBe(110)
    expect(out.sets.every((s) => s.reps == null)).toBe(true)
  })

  it('prefills reps from a bodyweight-only history (loads and suggestion stay empty)', () => {
    const bwHist = [
      historySession([
        { reps: 12, loadKg: null },
        { reps: 9, loadKg: 0 },
      ]),
    ]
    const out = prefillBlockFromHistory(block({ sets: [set(), set()] }), bwHist)
    expect(out.sets.map((s) => s.reps)).toEqual([12, 9])
    expect(out.sets.map((s) => s.loadKg)).toEqual([null, null])
    expect(out.suggestedKg).toBeNull()
  })

  it('still prefers the last LOADED session over a newer bodyweight-only one', () => {
    const mixed = [
      historySession([{ reps: 10, loadKg: null }], '2026-08-30T10:00:00Z'),
      historySession([{ reps: 5, loadKg: 100 }], '2026-08-20T10:00:00Z'),
    ]
    const out = prefillBlockFromHistory(block({ sets: [set()] }), mixed)
    expect(out.sets[0]!.reps).toBe(5)
    expect(out.sets[0]!.loadKg).toBe(100)
  })

  it('anchors the suggestion on the first working rep set, skipping a leading warmup', () => {
    // Warmup at 12 reps would drag the recommendation low; the first
    // working set's 3 reps must drive it instead (3 < last top's 3 is
    // false, so basis stays "last 110" with no bump).
    const b = block({
      sets: [set({ reps: 12, setType: 'warmup' }), set({ reps: 3, loadKg: 100 })],
    })
    const out = prefillBlockFromHistory(b, hist)
    expect(out.suggestedBasis).toBe('last 110')
  })

  describe("historyPrefill: 'override' (template starts)", () => {
    it('replaces prescribed reps and loads with the last session, per working ordinal', () => {
      const b = block({
        historyPrefill: 'override',
        sets: [set({ reps: 6, loadKg: 60 }), set({ reps: 6, loadKg: 60 })],
      })
      const out = prefillBlockFromHistory(b, hist)
      expect(out.sets.map((s) => [s.reps, s.loadKg])).toEqual([
        [5, 100],
        [5, 105],
      ])
      // One-shot: the directive is consumed by the pass.
      expect(out.historyPrefill).toBeUndefined()
    })

    it('still protects a deliberate bodyweight 0, MAX reps, done sets, and warmups', () => {
      const b = block({
        historyPrefill: 'override',
        sets: [
          set({ reps: 6, loadKg: 0 }),
          set({ unit: 'reps', amrapTarget: true, loadKg: 60 }),
          set({ reps: 6, loadKg: 60, done: true, doneAtMs: 1 }),
          set({ reps: 12, loadKg: 40, setType: 'warmup' }),
        ],
      })
      const out = prefillBlockFromHistory(b, hist)
      // BW set: load stays 0, reps still update to the last session's.
      expect(out.sets[0]!.loadKg).toBe(0)
      expect(out.sets[0]!.reps).toBe(5)
      // MAX set: reps stay blank (arming the check would be wrong), the
      // load still tracks history (ordinal 1).
      expect(out.sets[1]!.reps).toBeNull()
      expect(out.sets[1]!.loadKg).toBe(105)
      expect(out.sets[2]).toBe(b.sets[2])
      expect(out.sets[3]).toBe(b.sets[3])
    })

    it('without the directive, prescribed values still win (fill-blank only)', () => {
      const b = block({ sets: [set({ reps: 6, loadKg: 60 }), set({ reps: 6 })] })
      const out = prefillBlockFromHistory(b, hist)
      expect(out.sets[0]!.loadKg).toBe(60)
      expect(out.sets[0]!.reps).toBe(6)
      expect(out.sets[1]!.loadKg).toBe(105)
    })

    it('fetched-but-unusable history consumes the directive; an unfetched one leaves it armed', () => {
      const b = block({ historyPrefill: 'override', sets: [set({ reps: 6, loadKg: 60 })] })
      const consumed = prefillBlockFromHistory(b, [])
      expect(consumed.historyPrefill).toBeUndefined()
      expect(consumed.sets).toBe(b.sets)
      expect(prefillBlockFromHistory(b, undefined)).toBe(b)
    })

    it('keeps working-ordinal alignment under a LEADING warmup', () => {
      // The warmup consumes no ordinal, so working sets map to history
      // rows 0 and 1 — and the warmup itself is never overridden.
      const b = block({
        historyPrefill: 'override',
        sets: [
          set({ reps: 12, loadKg: 40, setType: 'warmup' }),
          set({ reps: 6, loadKg: 60 }),
          set({ reps: 6, loadKg: 60 }),
        ],
      })
      const out = prefillBlockFromHistory(b, hist)
      expect(out.sets[0]).toBe(b.sets[0])
      expect(out.sets.slice(1).map((s) => [s.reps, s.loadKg])).toEqual([
        [5, 100],
        [5, 105],
      ])
    })

    it('replaces prescriptions only at ordinals the history holds — the tail keeps its own', () => {
      // A 3-set template over a 1-set history: set 1 takes the logged
      // numbers, sets 2-3 keep their prescription (the last-set fallback
      // is for BLANK fields, and would otherwise flatten a pyramid).
      const short = [historySession([{ reps: 5, loadKg: 80 }])]
      const b = block({
        historyPrefill: 'override',
        sets: [set({ reps: 10, loadKg: 50 }), set({ reps: 8, loadKg: 55 }), set({ reps: 6 })],
      })
      const out = prefillBlockFromHistory(b, short)
      expect(out.sets.map((s) => [s.reps, s.loadKg])).toEqual([
        [5, 80],
        [8, 55],
        // Blank load still uses the fallback; the prescribed reps stay.
        [6, 80],
      ])
    })

    it('anchors a mixed amrap+fixed block on the fixed set, not the fallback', () => {
      const b = block({
        historyPrefill: 'override',
        sets: [set({ unit: 'reps', amrapTarget: true }), set({ reps: 6, loadKg: 60 })],
      })
      const out = prefillBlockFromHistory(b, hist)
      // Fixed set at ordinal 1 takes history reps 5, and that (not the
      // top set's 3) drives the suggestion's target: recommendLoad(5,
      // {3×110}) → 107.5, where the all-MAX fallback (target 3) would
      // give 110 — the exact value gates the anchor rule.
      expect(out.sets[1]!.reps).toBe(5)
      expect(out.suggestedKg).toBe(107.5)
      expect(out.suggestedLastKg).toBe(110)
    })

    it('a cardio block consumes an armed directive without touching its sets', () => {
      const b = block({
        historyPrefill: 'override',
        sets: [set({ timeS: 300, unit: 'timeS' })],
      })
      const out = prefillBlockFromHistory(b, hist)
      expect(out.historyPrefill).toBeUndefined()
      expect(out.sets).toBe(b.sets)
      expect(out.suggestedKg).toBeNull()
    })

    it('armHistoryPrefillOverride stamps every block', () => {
      const st = state([block(), block({ exerciseId: 'ex2' })])
      const armed = armHistoryPrefillOverride(st)
      expect(armed.blocks.every((b) => b.historyPrefill === 'override')).toBe(true)
      // The source state is untouched (pure helper).
      expect(st.blocks.every((b) => b.historyPrefill === undefined)).toBe(true)
    })

    it('is idempotent — the consumed pass no-ops on a rerun', () => {
      const b = block({
        historyPrefill: 'override',
        sets: [set({ reps: 6, loadKg: 60 }), set({ reps: 6, loadKg: 60 })],
      })
      const once = prefillBlockFromHistory(b, hist)
      expect(prefillBlockFromHistory(once, hist)).toBe(once)
    })

    it('prefillSessionFromHistory persists the consumption as a state change', () => {
      // Sets already match history — no value changes, but the stripped
      // directive must still produce a NEW state so it gets persisted
      // (otherwise a reload would re-arm the override over later edits).
      const b = block({
        historyPrefill: 'override',
        sets: [set({ reps: 5, loadKg: 100 }), set({ reps: 5, loadKg: 105 })],
      })
      const st = state([b])
      const out = prefillSessionFromHistory(st, { ex1: hist })
      expect(out).not.toBe(st)
      expect(out.blocks[0]!.historyPrefill).toBeUndefined()
    })
  })

  it('returns the same reference when nothing changes', () => {
    const b = block({
      suggestedKg: 42,
      suggestedBasis: 'preset',
      sets: [set({ reps: 5, loadKg: 100 })],
    })
    expect(prefillBlockFromHistory(b, hist)).toBe(b)
    const untouched = block()
    expect(prefillBlockFromHistory(untouched, [])).toBe(untouched)
  })
})

describe('prefillSessionFromHistory', () => {
  const hist = [historySession([{ reps: 5, loadKg: 100 }])]

  it('prefills every block matching an exercise in the map', () => {
    const st = state([
      block({ exerciseId: 'ex1' }),
      block({ exerciseId: 'ex1' }),
      block({ exerciseId: 'ex2' }),
    ])
    const out = prefillSessionFromHistory(st, { ex1: hist })
    expect(out.blocks[0]!.sets[0]!.loadKg).toBe(100)
    expect(out.blocks[1]!.sets[0]!.loadKg).toBe(100)
    expect(out.blocks[2]!.sets[0]!.loadKg).toBeNull()
  })

  it('is identity (same reference) for empty maps, unknown ids, and empty history', () => {
    const st = state([block()])
    expect(prefillSessionFromHistory(st, {})).toBe(st)
    expect(prefillSessionFromHistory(st, { other: hist })).toBe(st)
    expect(prefillSessionFromHistory(st, { ex1: [] })).toBe(st)
  })

  it('is idempotent — a second pass changes nothing', () => {
    const once = prefillSessionFromHistory(state([block()]), { ex1: hist })
    expect(prefillSessionFromHistory(once, { ex1: hist })).toBe(once)
  })
})
