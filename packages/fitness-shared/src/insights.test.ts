import { describe, expect, it } from 'vitest'
import {
  computeExercisePr,
  computeWeeklyVolume,
  estimateOneRepMax,
  groupExerciseHistory,
  volumeByMuscle,
  volumeByMuscleGroup,
  WEEK_MS,
  type ExerciseHistorySetRow,
} from './insights.js'
import { MUSCLES } from './taxonomy.js'

describe('estimateOneRepMax', () => {
  it('returns the load itself for a single rep', () => {
    expect(estimateOneRepMax(100, 1)).toBe(100)
  })

  it('applies Epley for multi-rep sets', () => {
    expect(estimateOneRepMax(100, 5)).toBeCloseTo(100 * (1 + 5 / 30), 6) // 116.67
  })

  it('returns null when load or reps are missing/non-positive', () => {
    expect(estimateOneRepMax(null, 5)).toBeNull()
    expect(estimateOneRepMax(100, null)).toBeNull()
    expect(estimateOneRepMax(0, 5)).toBeNull()
    expect(estimateOneRepMax(100, 0)).toBeNull()
  })

  it('pins Epley behavior across rep ranges (incl. > 15 where it gets fuzzy)', () => {
    // Documented in insights.ts: Epley over-estimates above ~15 reps, no
    // clamp. Pin the numbers so a future refactor can't silently swap to
    // a different formula (Brzycki etc.) without updating callers.
    expect(estimateOneRepMax(100, 5)).toBeCloseTo(100 * (1 + 5 / 30), 6) // ~116.67
    expect(estimateOneRepMax(100, 10)).toBeCloseTo(100 * (1 + 10 / 30), 6) // ~133.33
    expect(estimateOneRepMax(50, 20)).toBeCloseTo(50 * (1 + 20 / 30), 6) // ~83.33 — fuzzy
  })
})

describe('volumeByMuscleGroup', () => {
  it('credits a set once per group at its strongest role-fraction', () => {
    // A bench-press-like set: chest primary, delts + triceps secondary.
    const vol = volumeByMuscleGroup([
      {
        reps: 5,
        loadKg: 100,
        muscles: [
          { muscleId: 'chest', role: 'primary' },
          { muscleId: 'delts', role: 'secondary' },
          { muscleId: 'triceps', role: 'secondary' },
        ],
      },
    ])
    const byId = Object.fromEntries(vol.map((v) => [v.groupId, v]))
    // Chest counts once at max role weight.
    expect(byId.chest.weightedSets).toBe(1)
    expect(byId.chest.tonnageKg).toBe(500) // 5*100*1.0
    expect(byId.shoulder.weightedSets).toBe(0.5)
    expect(byId.shoulder.tonnageKg).toBe(250) // 5*100*0.5
    expect(byId.arm.weightedSets).toBe(0.5)
    // Untouched groups appear with zeros.
    expect(byId.back.weightedSets).toBe(0)
  })

  it('ignores stabilizer-only contributions (weight 0) and bodyweight tonnage', () => {
    const vol = volumeByMuscleGroup([
      // A plank-like set: abs primary, no load → counts a set but no tonnage.
      { reps: null, loadKg: null, muscles: [{ muscleId: 'abs', role: 'primary' }] },
      // Stabilizer-only on core → no volume credit.
      { reps: 10, loadKg: 40, muscles: [{ muscleId: 'abs', role: 'stabilizer' }] },
    ])
    const core = vol.find((v) => v.groupId === 'core')!
    expect(core.weightedSets).toBe(1) // only the primary set
    expect(core.tonnageKg).toBe(0) // first set bodyweight, second set stabilizer (weight 0)
  })

  it('returns every group in taxonomy order even with no sets', () => {
    const vol = volumeByMuscleGroup([])
    expect(vol.map((v) => v.groupId)).toEqual(['leg', 'back', 'chest', 'shoulder', 'arm', 'core'])
    expect(vol.every((v) => v.weightedSets === 0 && v.tonnageKg === 0)).toBe(true)
  })

  it('silently drops sets whose muscles fall outside the taxonomy', () => {
    // Pinning the deliberate behavior: an unknown muscleId contributes
    // zero everywhere rather than throwing. The catalog validator
    // prevents this on the way in, but custom-exercise raw inserts or a
    // future taxonomy edit can still produce them.
    const vol = volumeByMuscleGroup([
      {
        reps: 5,
        loadKg: 100,
        muscles: [{ muscleId: 'not_in_taxonomy', role: 'primary' }],
      },
    ])
    expect(vol.every((v) => v.weightedSets === 0 && v.tonnageKg === 0)).toBe(true)
  })
})

describe('volumeByMuscle', () => {
  it('credits each muscle independently at its role-fraction', () => {
    const vol = volumeByMuscle([
      {
        reps: 5,
        loadKg: 100,
        muscles: [
          { muscleId: 'chest', role: 'primary' },
          { muscleId: 'delts', role: 'secondary' },
          { muscleId: 'triceps', role: 'secondary' },
          { muscleId: 'abs', role: 'stabilizer' },
        ],
      },
    ])
    const byId = Object.fromEntries(vol.map((v) => [v.muscleId, v]))
    expect(byId.chest.weightedSets).toBe(1)
    expect(byId.chest.tonnageKg).toBe(500)
    expect(byId.delts.weightedSets).toBe(0.5)
    expect(byId.delts.tonnageKg).toBe(250)
    expect(byId.triceps.weightedSets).toBe(0.5)
    // Stabilizer weight is 0 — no credit.
    expect(byId.abs.weightedSets).toBe(0)
    // Untouched muscles appear with zeros.
    expect(byId.quads.weightedSets).toBe(0)
  })

  it('a duplicate muscleId in one set counts once at its strongest role', () => {
    const vol = volumeByMuscle([
      {
        reps: 10,
        loadKg: 50,
        muscles: [
          { muscleId: 'lats', role: 'secondary' },
          { muscleId: 'lats', role: 'primary' },
        ],
      },
    ])
    const lats = vol.find((v) => v.muscleId === 'lats')!
    expect(lats.weightedSets).toBe(1)
    expect(lats.tonnageKg).toBe(500)
  })

  it('returns every taxonomy muscle in group-then-muscle order, zero-filled', () => {
    const vol = volumeByMuscle([])
    expect(vol).toHaveLength(MUSCLES.length)
    expect(vol.every((v) => v.weightedSets === 0 && v.tonnageKg === 0)).toBe(true)
    // Group order: leg first, core last (per MUSCLE_GROUPS sort).
    expect(vol[0]!.muscleId).toBe('quads')
    expect(vol[vol.length - 1]!.muscleId).toBe('obliques')
    // Each entry carries its groupId for the UI drill-down.
    expect(vol.find((v) => v.muscleId === 'lats')!.groupId).toBe('back')
  })

  it('silently drops unknown muscle ids', () => {
    const vol = volumeByMuscle([
      { reps: 5, loadKg: 100, muscles: [{ muscleId: 'not_a_muscle', role: 'primary' }] },
    ])
    expect(vol.every((v) => v.weightedSets === 0)).toBe(true)
  })

  it('per-muscle totals are consistent with the group rollup at the max-fraction level', () => {
    const sets = [
      {
        reps: 5,
        loadKg: 100,
        muscles: [
          { muscleId: 'lats', role: 'primary' },
          { muscleId: 'traps', role: 'secondary' },
          { muscleId: 'biceps', role: 'secondary' },
        ],
      },
    ]
    const groups = volumeByMuscleGroup(sets)
    const muscles = volumeByMuscle(sets)
    const back = groups.find((g) => g.groupId === 'back')!
    const backMax = Math.max(
      ...muscles.filter((m) => m.groupId === 'back').map((m) => m.weightedSets),
    )
    // The group counts once at the strongest fraction among its muscles.
    expect(back.weightedSets).toBe(backMax)
  })
})

describe('computeWeeklyVolume', () => {
  // Mon 2026-01-05 00:00 UTC — a clean Monday anchor for the tests. The
  // real caller supplies a *local*-Monday-midnight instant; the function
  // only ever sees epoch-ms so UTC anchors here lose no generality.
  const FROM = Date.UTC(2026, 0, 5)

  it('returns exactly `weeks` zero bins for empty input, oldest first', () => {
    const out = computeWeeklyVolume([], FROM, 8)
    expect(out).toHaveLength(8)
    expect(out[0]!.from).toBe(new Date(FROM).toISOString())
    expect(out[7]!.to).toBe(new Date(FROM + 8 * WEEK_MS).toISOString())
    for (const w of out) {
      expect(w.tonnageKg).toBe(0)
      expect(w.sets).toBe(0)
    }
  })

  it('buckets sets into their week and sums reps × load', () => {
    const out = computeWeeklyVolume(
      [
        { performedAtMs: FROM + 1000, reps: 5, loadKg: 100 },
        { performedAtMs: FROM + 2000, reps: 5, loadKg: 100 },
        { performedAtMs: FROM + 3 * WEEK_MS + 1000, reps: 10, loadKg: 60 },
      ],
      FROM,
      8,
    )
    expect(out[0]).toMatchObject({ tonnageKg: 1000, sets: 2 })
    expect(out[3]).toMatchObject({ tonnageKg: 600, sets: 1 })
    expect(out[1]!.sets).toBe(0)
  })

  it('is half-open: a set exactly on a bin boundary lands in the later bin', () => {
    const out = computeWeeklyVolume(
      [{ performedAtMs: FROM + WEEK_MS, reps: 1, loadKg: 50 }],
      FROM,
      3,
    )
    expect(out[0]!.sets).toBe(0)
    expect(out[1]!.sets).toBe(1)
  })

  it('includes a set at fromMs and at the last in-window millisecond', () => {
    const out = computeWeeklyVolume(
      [
        { performedAtMs: FROM, reps: 1, loadKg: 10 },
        { performedAtMs: FROM + 2 * WEEK_MS - 1, reps: 1, loadKg: 20 },
      ],
      FROM,
      2,
    )
    expect(out[0]!.tonnageKg).toBe(10)
    expect(out[1]!.tonnageKg).toBe(20)
  })

  it('ignores sets before fromMs', () => {
    const out = computeWeeklyVolume(
      [{ performedAtMs: FROM - 1, reps: 5, loadKg: 100 }],
      FROM,
      2,
    )
    expect(out[0]!.sets).toBe(0)
    expect(out[1]!.sets).toBe(0)
  })

  it('clamps a set past the nominal end into the last bin (DST overshoot)', () => {
    // A local-Monday-midnight `to` computed across a fall-back transition
    // sits up to an hour past fromMs + weeks·WEEK_MS; the repo's [from,to)
    // filter admits the set, so the pure fn must not drop it.
    const out = computeWeeklyVolume(
      [{ performedAtMs: FROM + 2 * WEEK_MS + 30 * 60 * 1000, reps: 2, loadKg: 40 }],
      FROM,
      2,
    )
    expect(out[1]).toMatchObject({ tonnageKg: 80, sets: 1 })
  })

  it('counts a set with null reps or load toward `sets` but not tonnage', () => {
    const out = computeWeeklyVolume(
      [
        { performedAtMs: FROM + 1000, reps: null, loadKg: 100 },
        { performedAtMs: FROM + 2000, reps: 12, loadKg: null },
      ],
      FROM,
      1,
    )
    expect(out[0]!.sets).toBe(2)
    expect(out[0]!.tonnageKg).toBe(0)
    expect(Number.isNaN(out[0]!.tonnageKg)).toBe(false)
  })

  it('buckets correctly across a year boundary', () => {
    // Mon 2025-12-22 anchor: week 0 is Dec, week 1 spans Dec 29 → Jan 5,
    // week 2 is pure January.
    const from = Date.UTC(2025, 11, 22)
    const out = computeWeeklyVolume(
      [
        { performedAtMs: Date.UTC(2025, 11, 31, 23), reps: 1, loadKg: 100 },
        { performedAtMs: Date.UTC(2026, 0, 1, 1), reps: 1, loadKg: 200 },
        { performedAtMs: Date.UTC(2026, 0, 7), reps: 1, loadKg: 300 },
      ],
      from,
      3,
    )
    expect(out[1]!.tonnageKg).toBe(300) // both New-Year's-eve/day sets, same ISO week
    expect(out[2]!.tonnageKg).toBe(300)
    expect(out[1]!.from).toBe('2025-12-29T00:00:00.000Z')
    expect(out[2]!.from).toBe('2026-01-05T00:00:00.000Z')
  })
})

describe('computeExercisePr', () => {
  it('tracks best e1RM, heaviest load, longest distance and fastest time', () => {
    const pr = computeExercisePr([
      { reps: 5, loadKg: 100, distanceM: null, timeS: null, performedAt: '2026-06-01T00:00:00.000Z' },
      { reps: 3, loadKg: 110, distanceM: null, timeS: null, performedAt: '2026-06-08T00:00:00.000Z' },
      { reps: 1, loadKg: 120, distanceM: null, timeS: null, performedAt: '2026-06-15T00:00:00.000Z' },
    ])
    // e1RM: 100*(1.1667)=116.7, 110*(1.1)=121, 120*1=120 → best is the triple at 121.
    expect(pr.bestE1rmKg).toBeCloseTo(121, 4)
    expect(pr.bestE1rmAt).toBe('2026-06-08T00:00:00.000Z')
    expect(pr.heaviestLoadKg).toBe(120)
    expect(pr.heaviestLoadAt).toBe('2026-06-15T00:00:00.000Z')
  })

  it('tracks endurance records independently of strength', () => {
    const pr = computeExercisePr([
      { reps: null, loadKg: null, distanceM: 5000, timeS: 1500, performedAt: '2026-06-01T00:00:00.000Z' },
      { reps: null, loadKg: null, distanceM: 10000, timeS: 2900, performedAt: '2026-06-08T00:00:00.000Z' },
      { reps: null, loadKg: null, distanceM: 3000, timeS: 800, performedAt: '2026-06-15T00:00:00.000Z' },
    ])
    expect(pr.longestDistanceM).toBe(10000)
    expect(pr.fastestTimeS).toBe(800)
    expect(pr.bestE1rmKg).toBeNull()
  })

  it('returns all-null for an empty set list', () => {
    expect(computeExercisePr([])).toEqual({
      bestE1rmKg: null,
      bestE1rmAt: null,
      heaviestLoadKg: null,
      heaviestLoadAt: null,
      longestDistanceM: null,
      fastestTimeS: null,
    })
  })
})

describe('groupExerciseHistory', () => {
  const row = (
    workoutId: string,
    performedAt: string,
    setIndex: number,
    reps: number | null,
    loadKg: number | null,
    rpe: number | null = null,
    workoutTitle: string | null = null,
  ): ExerciseHistorySetRow => ({ workoutId, workoutTitle, performedAt, setIndex, reps, loadKg, rpe })

  it('returns [] for no rows', () => {
    expect(groupExerciseHistory([], 5)).toEqual([])
  })

  it('groups a single session and orders sets by setIndex', () => {
    const rows = [
      row('w1', '2026-07-10T00:00:00.000Z', 1, 7, 150, null, 'Upper A'),
      row('w1', '2026-07-10T00:00:00.000Z', 0, 8, 155, 8, 'Upper A'),
    ]
    expect(groupExerciseHistory(rows, 5)).toEqual([
      {
        workoutId: 'w1',
        workoutTitle: 'Upper A',
        performedAt: '2026-07-10T00:00:00.000Z',
        sets: [
          { reps: 8, loadKg: 155, rpe: 8 },
          { reps: 7, loadKg: 150, rpe: null },
        ],
      },
    ])
  })

  it('orders sessions newest-first regardless of input order', () => {
    const rows = [
      row('old', '2026-07-01T00:00:00.000Z', 0, 5, 100),
      row('new', '2026-07-15T00:00:00.000Z', 0, 5, 110),
    ]
    expect(groupExerciseHistory(rows, 5).map((s) => s.workoutId)).toEqual(['new', 'old'])
  })

  it('caps to sessionLimit sessions', () => {
    const rows = [
      row('a', '2026-07-03T00:00:00.000Z', 0, 5, 100),
      row('b', '2026-07-02T00:00:00.000Z', 0, 5, 100),
      row('c', '2026-07-01T00:00:00.000Z', 0, 5, 100),
    ]
    expect(groupExerciseHistory(rows, 2).map((s) => s.workoutId)).toEqual(['a', 'b'])
  })

  it('returns every session when sessionLimit <= 0', () => {
    const rows = [
      row('a', '2026-07-03T00:00:00.000Z', 0, 5, 100),
      row('b', '2026-07-02T00:00:00.000Z', 0, 5, 100),
    ]
    expect(groupExerciseHistory(rows, 0)).toHaveLength(2)
  })
})
