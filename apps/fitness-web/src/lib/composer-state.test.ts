import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SETS,
  defaultSetsForExercise,
  defaultWorkUnitForShape,
  emptyComposerState,
  emptyMovementRow,
  normalizeMovement,
  normalizeStrengthBlock,
  parseScheme,
  stateFromStrengthTemplate,
  switchDistanceUnit,
  switchType,
  unitSwitchable,
  validateForSave,
  validateStrengthForSave,
  workUnitForMovement,
  workUnitForStrengthSet,
  workValueForMovement,
  type ComposerMovementRow,
  applyFirstSetToAll,
  applyRestToAllBlocks,
  showRestForBlock,
  slugify,
  validateStrengthForStart,
  moveStrengthBlock,
  nextComposerGroupKey,
  renumberGroups,
  toggleSupersetWithPrevious,
  type ComposerStrengthBlockRow,
  type ComposerStrengthSetRow,
} from './composer-state.js'

// Movement-row literal helper — fills the non-essential fields so tests
// only spell out what they assert on.
function row(p: Partial<ComposerMovementRow> & { name: string }): ComposerMovementRow {
  return { ...emptyMovementRow(), ...p }
}


// Strength set-row helper: fills the C4 fields (amrap/rpe) so tests read
// as reps×load pairs.
function sset(reps: string, loadKg = '', extra: Partial<ComposerStrengthSetRow> = {}) {
  return { reps, loadKg, timeS: '', inclinePct: '', amrap: false, rpe: '', ...extra }
}

describe('parseScheme', () => {
  it('parses dash-separated ladders', () => {
    expect(parseScheme('21-15-9')).toEqual([21, 15, 9])
  })
  it('parses comma- and slash-separated ladders', () => {
    expect(parseScheme('5, 5, 5, 5')).toEqual([5, 5, 5, 5])
    expect(parseScheme('10/8/6')).toEqual([10, 8, 6])
  })
  it('returns null for non-numeric or zero tokens', () => {
    expect(parseScheme('21-a-9')).toBeNull()
    expect(parseScheme('21-0-9')).toBeNull()
    expect(parseScheme('')).toBeNull()
  })
})

describe('switchType', () => {
  it('clears capMin when switching to AMRAP and seeds a default duration', () => {
    const base = { ...emptyComposerState(), capMin: '8', wodType: 'for_time' as const }
    const next = switchType(base, 'amrap')
    expect(next.wodType).toBe('amrap')
    expect(next.capMin).toBe('')
    expect(next.durationMin).toBe('20')
  })
  it('clears durationMin when switching away from AMRAP', () => {
    const base = { ...emptyComposerState(), wodType: 'amrap' as const, durationMin: '20' }
    const next = switchType(base, 'for_time')
    expect(next.durationMin).toBe('')
  })
  it('preserves shared fields (name, movements, notes)', () => {
    const base = {
      ...emptyComposerState(),
      name: 'My WOD',
      notes: 'go hard',
      movements: [row({ name: 'thruster', reps: '21', loadKg: '43' })],
    }
    const next = switchType(base, 'amrap')
    expect(next.name).toBe('My WOD')
    expect(next.notes).toBe('go hard')
    expect(next.movements).toHaveLength(1)
  })
  it('seeds EMOM defaults and clears them when switching away', () => {
    const emom = switchType({ ...emptyComposerState(), intervalS: '' }, 'emom')
    expect(emom.intervalS).toBe('60')
    expect(emom.totalIntervals).toBe('10')
    const back = switchType({ ...emom, intervalS: '90' }, 'for_time')
    expect(back.intervalS).toBe('60')
  })
  it('clears for_time-only modifiers (ladder, buy-in) when leaving for_time', () => {
    const ft = {
      ...emptyComposerState(),
      ladderCumulative: true,
      buyInName: 'burpee',
      buyInExerciseId: 'fx_seed_burpee',
      buyInReps: '5',
    }
    const next = switchType(ft, 'emom')
    expect(next.ladderCumulative).toBe(false)
    expect(next.buyInName).toBe('')
    expect(next.buyInExerciseId).toBeNull()
    expect(next.buyInReps).toBe('')
  })
  it('carries rounds into interval / max_reps_rounds', () => {
    const base = { ...emptyComposerState(), wodType: 'rounds_for_time' as const, rounds: '5' }
    expect(switchType(base, 'interval').rounds).toBe('5')
    expect(switchType(base, 'max_reps_rounds').rounds).toBe('5')
  })
  it('is a no-op when called with the same type', () => {
    const s = emptyComposerState()
    expect(switchType(s, s.wodType)).toBe(s)
  })
})

describe('work units (calories / distance / time prescriptions)', () => {
  it('normalizeMovement emits reps by default', () => {
    const m = normalizeMovement(row({ name: 'Thruster', reps: '21' }))
    expect(m).toMatchObject({ reps: 21 })
    expect(m?.calories).toBeUndefined()
  })
  it('normalizeMovement emits calories for workUnit=calories', () => {
    const m = normalizeMovement(row({ name: 'Assault Bike', workUnit: 'calories', reps: '20' }))
    expect(m).toMatchObject({ calories: 20 })
    expect(m?.reps).toBeUndefined()
  })
  it('normalizeMovement emits distanceM for workUnit=distance', () => {
    const m = normalizeMovement(row({ name: 'Run', workUnit: 'distance', reps: '400' }))
    expect(m).toMatchObject({ distanceM: 400 })
    expect(m?.reps).toBeUndefined()
  })
  it('normalizeMovement emits timeS for workUnit=time', () => {
    const m = normalizeMovement(row({ name: 'Plank', workUnit: 'time', reps: '60' }))
    expect(m).toMatchObject({ timeS: 60 })
    expect(m?.reps).toBeUndefined()
  })
  it('normalizeMovement rounds calories to a whole number', () => {
    const m = normalizeMovement(row({ name: 'Row', workUnit: 'calories', reps: '15.7' }))
    expect(m?.calories).toBe(16)
  })
  it('normalizeMovement drops a non-positive amount regardless of unit', () => {
    const m = normalizeMovement(row({ name: 'Bike', workUnit: 'calories', reps: '-5' }))
    expect(m?.calories).toBeUndefined()
  })
  it('normalizeMovement drops a stale load on calorie/time rows', () => {
    const cal = normalizeMovement(
      row({ name: 'Assault Bike', workUnit: 'calories', reps: '20', loadKg: '40' }),
    )
    expect(cal?.loadKg).toBeUndefined()
    const timed = normalizeMovement(
      row({ name: 'Plank', workUnit: 'time', reps: '60', loadMode: 'bw', loadBwMultiple: '1' }),
    )
    expect(timed?.loadBwMultiple).toBeUndefined()
    const carry = normalizeMovement(
      row({ name: 'Farmer Carry', workUnit: 'distance', reps: '200', loadKg: '32' }),
    )
    expect(carry?.loadKg).toBe(32)
  })

  it('workUnitForMovement recovers the unit from a stored movement', () => {
    expect(workUnitForMovement({ exerciseId: 'x', reps: 21 })).toBe('reps')
    expect(workUnitForMovement({ exerciseId: 'x', calories: 20 })).toBe('calories')
    expect(workUnitForMovement({ exerciseId: 'x', distanceM: 400 })).toBe('distance')
    expect(workUnitForMovement({ exerciseId: 'x', timeS: 60 })).toBe('time')
    expect(workUnitForMovement({ exerciseId: 'x' })).toBe('reps')
  })
  it('workUnitForMovement prefers reps when fields coexist', () => {
    expect(workUnitForMovement({ exerciseId: 'x', reps: 10, distanceM: 400 })).toBe('reps')
  })
  it('workValueForMovement returns the stored amount as a string', () => {
    expect(workValueForMovement({ exerciseId: 'x', calories: 20 })).toBe('20')
    expect(workValueForMovement({ exerciseId: 'x', distanceM: 400 })).toBe('400')
    expect(workValueForMovement({ exerciseId: 'x', timeS: 60 })).toBe('60')
    expect(workValueForMovement({ exerciseId: 'x' })).toBe('')
  })

  it('defaultWorkUnitForShape maps catalog shapes to units', () => {
    expect(defaultWorkUnitForShape('distance_time')).toBe('distance')
    expect(defaultWorkUnitForShape('duration')).toBe('time')
    expect(defaultWorkUnitForShape('load_reps')).toBe('reps')
    expect(defaultWorkUnitForShape('rounds_reps')).toBe('reps')
  })

  it('defaultSetsForExercise gives cardio and timed work a single entry', () => {
    // Cardio machines and locomotion — one continuous effort.
    expect(defaultSetsForExercise({
      discipline: 'cardio', movementPattern: 'gait', metricShape: 'distance_time',
    })).toBe(1) // Run / Treadmill Run / Assault Bike
    expect(defaultSetsForExercise({
      discipline: 'cardio', movementPattern: 'horizontal_pull', metricShape: 'distance_time',
    })).toBe(1) // Rowing (Erg) / Swim
    expect(defaultSetsForExercise({
      discipline: 'cardio', movementPattern: 'gait', metricShape: 'duration',
    })).toBe(1) // Jump Rope
    // Timed non-cardio work: classes, yoga, mobility, a stair stepper.
    expect(defaultSetsForExercise({
      discipline: 'bodyweight', movementPattern: 'other', metricShape: 'duration',
    })).toBe(1) // Yoga / Mobility Session
    expect(defaultSetsForExercise({
      discipline: 'machine', movementPattern: 'gait', metricShape: 'duration',
    })).toBe(1) // a custom Stair Stepper
  })

  it('defaultSetsForExercise keeps the 3-set default for set-based work', () => {
    expect(defaultSetsForExercise({
      discipline: 'barbell', movementPattern: 'squat', metricShape: 'load_reps',
    })).toBe(DEFAULT_SETS) // Back Squat and every other lift
    // Timed CORE holds are the carve-out — really prescribed in sets.
    expect(defaultSetsForExercise({
      discipline: 'bodyweight', movementPattern: 'core', metricShape: 'duration',
    })).toBe(DEFAULT_SETS) // Plank / Side Plank / Hollow Body Hold
    expect(defaultSetsForExercise({
      discipline: 'gymnastics', movementPattern: 'core', metricShape: 'duration',
    })).toBe(DEFAULT_SETS) // L-Sit
    // distance_time alone is NOT a trigger: carries and sled work are
    // set-based (a Farmer's Carry is 4 × 40 m, not one entry).
    expect(defaultSetsForExercise({
      discipline: 'kettlebell', movementPattern: 'carry', metricShape: 'distance_time',
    })).toBe(DEFAULT_SETS) // Farmer's Carry / Overhead Carry
    expect(defaultSetsForExercise({
      discipline: 'bodyweight', movementPattern: 'carry', metricShape: 'distance_time',
    })).toBe(DEFAULT_SETS) // Sled Push / Sled Pull
    expect(defaultSetsForExercise({
      discipline: 'gymnastics', movementPattern: 'other', metricShape: 'distance_time',
    })).toBe(DEFAULT_SETS) // Handstand Walk
  })

  it('normalizeStrengthBlock emits per-unit set targets', () => {
    const base = { name: 'Assault Bike', exerciseId: 'fx_seed_assault_bike', restS: '' }
    const cal = normalizeStrengthBlock({
      ...base,
      workUnit: 'calories',
      sets: [sset('15', '40')],
    })
    expect(cal?.sets[0]).toEqual({ calories: 15 }) // stale load dropped
    const dist = normalizeStrengthBlock({
      ...base,
      workUnit: 'distance',
      sets: [sset('200', '32')],
    })
    expect(dist?.sets[0]).toEqual({ distanceM: 200, loadKg: 32 }) // loaded carry keeps load
    const timed = normalizeStrengthBlock({
      ...base,
      workUnit: 'time',
      sets: [sset('60')],
    })
    expect(timed?.sets[0]).toEqual({ timeS: 60 })
  })

  it('stateFromStrengthTemplate recovers the block unit and amount', () => {
    const state = stateFromStrengthTemplate({
      name: 'Engine',
      description: null,
      body: {
        kind: 'strength',
        blocks: [
          {
            exerciseId: 'fx_seed_assault_bike',
            name: 'Assault Bike',
            sets: [{ calories: 15 }, { calories: 20 }],
          },
          {
            exerciseId: 'fx_seed_back_squat',
            name: 'Back Squat',
            sets: [{ reps: 5, loadKg: 100 }],
          },
        ],
      },
    })
    expect(state.blocks[0]).toMatchObject({ workUnit: 'calories' })
    expect(state.blocks[0]?.sets.map((s) => s.reps)).toEqual(['15', '20'])
    expect(state.blocks[1]).toMatchObject({ workUnit: 'reps' })
    expect(state.blocks[1]?.sets[0]).toMatchObject({ reps: '5', loadKg: '100' })
  })

  it('workUnitForStrengthSet recovers the unit per set', () => {
    expect(workUnitForStrengthSet({ reps: 5 })).toBe('reps')
    expect(workUnitForStrengthSet({ calories: 15 })).toBe('calories')
    expect(workUnitForStrengthSet({ distanceM: 500 })).toBe('distance')
    expect(workUnitForStrengthSet({ timeS: 60 })).toBe('time')
  })

  it('unitSwitchable gates on catalog shape or an already-non-rep unit', () => {
    const catalog = [
      { id: 'fx_bike', metricShape: 'distance_time' as const },
      { id: 'fx_squat', metricShape: 'load_reps' as const },
    ]
    expect(unitSwitchable({ exerciseId: 'fx_bike', workUnit: 'reps' }, catalog)).toBe(true)
    expect(unitSwitchable({ exerciseId: 'fx_squat', workUnit: 'reps' }, catalog)).toBe(false)
    expect(unitSwitchable({ exerciseId: null, workUnit: 'reps' }, catalog)).toBe(false)
    expect(unitSwitchable({ exerciseId: null, workUnit: 'calories' }, catalog)).toBe(true)
  })

  it('validateForSave round-trips a calorie movement into the body', () => {
    const state = {
      ...emptyComposerState(),
      name: 'Bike Intervals',
      scheme: '3',
      movements: [row({ name: 'Assault Bike', workUnit: 'calories', reps: '20' })],
    }
    const v = validateForSave(state)
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.payload.body.movements[0]).toMatchObject({ calories: 20 })
    }
  })
})

describe('validateForSave', () => {
  it('rejects empty name with a field error', () => {
    const s = { ...emptyComposerState(), name: '' }
    const v = validateForSave(s)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.field).toBe('name')
  })
  it('rejects when no movement has a name', () => {
    const s = emptyComposerState()
    s.name = 'X'
    s.movements = [row({ name: '', reps: '21' })]
    const v = validateForSave(s)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.field).toBe('movements')
  })
  it('builds a for_time payload with the parsed scheme + cap', () => {
    const s = emptyComposerState()
    s.name = 'Fran-ish'
    s.wodType = 'for_time'
    s.scheme = '21-15-9'
    s.capMin = '8'
    s.movements = [
      row({ name: 'thruster', loadKg: '43' }),
      row({ name: 'pull-up' }),
    ]
    const v = validateForSave(s)
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.payload.wodType).toBe('for_time')
      expect(v.payload.timeCapS).toBe(8 * 60)
      const body = v.payload.body
      expect(body.wodType).toBe('for_time')
      if (body.wodType === 'for_time') {
        expect(body.schemeRounds).toEqual([21, 15, 9])
        expect(body.rounds).toBe(3)
        expect(body.movements).toHaveLength(2)
      }
    }
  })
  it('builds an amrap payload converting minutes to seconds', () => {
    const s = emptyComposerState()
    s.name = 'Cindy'
    s.wodType = 'amrap'
    s.durationMin = '20'
    s.movements = [
      row({ name: 'pull-up', reps: '5' }),
      row({ name: 'push-up', reps: '10' }),
      row({ name: 'air squat', reps: '15' }),
    ]
    const v = validateForSave(s)
    expect(v.ok).toBe(true)
    if (v.ok && v.payload.body.wodType === 'amrap') {
      expect(v.payload.body.durationS).toBe(1200)
      expect(v.payload.body.movements).toHaveLength(3)
    }
  })
  it('rejects amrap with a sub-1-minute duration', () => {
    const s = emptyComposerState()
    s.name = 'Short'
    s.wodType = 'amrap'
    s.durationMin = '0'
    s.movements = [row({ name: 'pull-up', reps: '5' })]
    const v = validateForSave(s)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.field).toBe('durationMin')
  })
  it('includes the description when notes are non-empty', () => {
    const s = emptyComposerState()
    s.name = 'Note WOD'
    s.notes = '  go hard  '
    s.movements = [row({ name: 'pull-up', reps: '5' })]
    const v = validateForSave(s)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.payload.description).toBe('go hard')
  })
  // Code-review F4: previously an empty capMin omitted timeCapS from the
  // payload, so the edit-mode PATCH path couldn't distinguish "the user
  // cleared the cap" from "the user didn't touch the field" — the cap
  // silently survived the save. Emit explicit null so PATCH can write it.
  it('emits explicit null timeCapS when capMin is cleared on for_time', () => {
    const s = emptyComposerState()
    s.name = 'Capless'
    s.wodType = 'for_time'
    s.scheme = '21-15-9'
    s.capMin = ''
    s.movements = [row({ name: 'pull-up', reps: '5' })]
    const v = validateForSave(s)
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect('timeCapS' in v.payload).toBe(true)
      expect(v.payload.timeCapS).toBeNull()
    }
  })
  it('emits explicit null timeCapS when capMin is cleared on rounds_for_time', () => {
    const s = emptyComposerState()
    s.name = 'Capless RFT'
    s.wodType = 'rounds_for_time'
    s.rounds = '5'
    s.capMin = ''
    s.movements = [row({ name: 'pull-up', reps: '5' })]
    const v = validateForSave(s)
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect('timeCapS' in v.payload).toBe(true)
      expect(v.payload.timeCapS).toBeNull()
    }
  })
  // AMRAP carries its duration inside the body, not at the top level — a
  // top-level timeCapS on an amrap payload would fail the bodyMatchesWodType
  // superRefine. Confirm we never emit one.
  it('omits timeCapS entirely on amrap payloads', () => {
    const s = emptyComposerState()
    s.name = 'Cindy clear'
    s.wodType = 'amrap'
    s.durationMin = '20'
    s.capMin = ''
    s.movements = [row({ name: 'pull-up', reps: '5' })]
    const v = validateForSave(s)
    expect(v.ok).toBe(true)
    if (v.ok) expect('timeCapS' in v.payload).toBe(false)
  })

  // ── New authorable types + modifiers ──────────────────────────────────

  it('builds an EMOM body (Chelsea-style)', () => {
    const s = emptyComposerState()
    s.name = 'Chelsea-ish'
    s.wodType = 'emom'
    s.intervalS = '60'
    s.totalIntervals = '30'
    s.movements = [
      row({ name: 'pull-up', reps: '5' }),
      row({ name: 'push-up', reps: '10' }),
    ]
    const v = validateForSave(s)
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect('timeCapS' in v.payload).toBe(false)
      const body = v.payload.body
      if (body.wodType === 'emom') {
        expect(body.intervalS).toBe(60)
        expect(body.totalIntervals).toBe(30)
      } else {
        expect.unreachable('expected an emom body')
      }
    }
  })
  it('rejects an EMOM with a sub-5s interval or missing interval count', () => {
    const s = emptyComposerState()
    s.name = 'Bad EMOM'
    s.wodType = 'emom'
    s.movements = [row({ name: 'pull-up', reps: '5' })]
    s.intervalS = '3'
    let v = validateForSave(s)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.field).toBe('intervalS')
    s.intervalS = '60'
    s.totalIntervals = ''
    v = validateForSave(s)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.field).toBe('totalIntervals')
  })

  it('builds an interval body with rest and a calorie-scored station (FGB-style)', () => {
    const s = emptyComposerState()
    s.name = 'FGB-ish'
    s.wodType = 'interval'
    s.rounds = '3'
    s.workS = '60'
    s.restS = '60'
    s.movements = [
      row({ name: 'wall ball', loadKg: '9' }),
      row({ name: 'rowing erg', scoreUnit: 'calories' }),
    ]
    const v = validateForSave(s)
    expect(v.ok).toBe(true)
    if (v.ok && v.payload.body.wodType === 'interval') {
      expect(v.payload.body.rounds).toBe(3)
      expect(v.payload.body.workS).toBe(60)
      expect(v.payload.body.restBetweenRoundsS).toBe(60)
      expect(v.payload.body.movements[0]!.scoreUnit).toBeUndefined()
      expect(v.payload.body.movements[1]!.scoreUnit).toBe('calories')
    }
  })
  // The composer must reject values above the shared schema's ceilings so
  // a "valid here, 400 at save" gap can't open (schema caps: intervalS /
  // workS / restBetweenRoundsS at 1800s, max_reps durationS at 90min).
  it('rejects EMOM / interval / max-reps values above the schema ceilings', () => {
    const emom = emptyComposerState()
    emom.name = 'Big EMOM'
    emom.wodType = 'emom'
    emom.intervalS = '5000'
    emom.movements = [row({ name: 'pull-up', reps: '5' })]
    expect(validateForSave(emom).ok).toBe(false)

    const interval = emptyComposerState()
    interval.name = 'Big intervals'
    interval.wodType = 'interval'
    interval.workS = '5000'
    interval.movements = [row({ name: 'wall ball' })]
    expect(validateForSave(interval).ok).toBe(false)

    const restHeavy = emptyComposerState()
    restHeavy.name = 'Big rest'
    restHeavy.wodType = 'rounds_for_time'
    restHeavy.rounds = '3'
    restHeavy.restS = '5000'
    restHeavy.movements = [row({ name: 'pull-up', reps: '5' })]
    const rv = validateForSave(restHeavy)
    expect(rv.ok).toBe(false)
    if (!rv.ok) expect(rv.field).toBe('restS')

    const maxReps = emptyComposerState()
    maxReps.name = 'Long max reps'
    maxReps.wodType = 'max_reps_rounds'
    maxReps.durationMin = '150'
    maxReps.movements = [row({ name: 'pull-up', reps: '5', scored: true })]
    const mv = validateForSave(maxReps)
    expect(mv.ok).toBe(false)
    if (!mv.ok) expect(mv.field).toBe('durationMin')
  })

  it('rejects an interval body without a work duration', () => {
    const s = emptyComposerState()
    s.name = 'Bad intervals'
    s.wodType = 'interval'
    s.workS = ''
    s.movements = [row({ name: 'wall ball' })]
    const v = validateForSave(s)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.field).toBe('workS')
  })

  it('builds a max_reps_rounds body with scored flags and an optional clock', () => {
    const s = emptyComposerState()
    s.name = 'Nicole-ish'
    s.wodType = 'max_reps_rounds'
    s.rounds = '5'
    s.durationMin = '20'
    s.movements = [
      row({ name: 'run', scored: false }),
      row({ name: 'pull-up', scored: true }),
    ]
    const v = validateForSave(s)
    expect(v.ok).toBe(true)
    if (v.ok && v.payload.body.wodType === 'max_reps_rounds') {
      expect(v.payload.body.durationS).toBe(1200)
      expect(v.payload.body.movements.map((m) => m.scored)).toEqual([false, true])
    }
  })
  it('rejects max_reps_rounds when nothing is scored', () => {
    const s = emptyComposerState()
    s.name = 'Unscored'
    s.wodType = 'max_reps_rounds'
    s.movements = [row({ name: 'run', scored: false })]
    const v = validateForSave(s)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.field).toBe('movements')
  })

  it('derives rounds from the movement count for a cumulative ladder', () => {
    const s = emptyComposerState()
    s.name = '12 Days-ish'
    s.wodType = 'for_time'
    s.ladderCumulative = true
    s.scheme = '' // ignored for cumulative ladders
    s.movements = [
      row({ name: 'deadlift', reps: '1' }),
      row({ name: 'thruster', reps: '2' }),
      row({ name: 'push press', reps: '3' }),
    ]
    const v = validateForSave(s)
    expect(v.ok).toBe(true)
    if (v.ok && v.payload.body.wodType === 'for_time') {
      expect(v.payload.body.ladder).toBe('cumulative')
      expect(v.payload.body.rounds).toBe(3)
      expect(v.payload.body.schemeRounds).toBeUndefined()
    }
  })

  it('emits a per-minute buy-in and rejects a half-filled one', () => {
    const s = emptyComposerState()
    s.name = 'Kalsu-ish'
    s.wodType = 'for_time'
    s.scheme = '100'
    s.movements = [row({ name: 'thruster', loadKg: '61' })]
    s.buyInName = 'burpee'
    s.buyInExerciseId = 'fx_seed_burpee'
    s.buyInReps = '5'
    let v = validateForSave(s)
    expect(v.ok).toBe(true)
    if (v.ok && v.payload.body.wodType === 'for_time') {
      expect(v.payload.body.perMinuteBuyIn).toEqual({
        exerciseId: 'fx_seed_burpee',
        reps: 5,
      })
    }
    s.buyInReps = ''
    v = validateForSave(s)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.field).toBe('buyInReps')
  })

  it('emits restBetweenRoundsS on rounds_for_time (Barbara-style)', () => {
    const s = emptyComposerState()
    s.name = 'Barbara-ish'
    s.wodType = 'rounds_for_time'
    s.rounds = '5'
    s.restS = '180'
    s.movements = [row({ name: 'pull-up', reps: '20' })]
    const v = validateForSave(s)
    expect(v.ok).toBe(true)
    if (v.ok && v.payload.body.wodType === 'rounds_for_time') {
      expect(v.payload.body.restBetweenRoundsS).toBe(180)
    }
  })
})

describe('normalizeMovement', () => {
  it('uses the picked catalog exerciseId when present', () => {
    const m = normalizeMovement(row({ name: 'Thruster', exerciseId: 'fx_01ABC', reps: '21', loadKg: '43' }))
    expect(m).toEqual({ exerciseId: 'fx_01ABC', reps: 21, loadKg: 43 })
  })
  it('falls back to a slug id for free-text rows', () => {
    const m = normalizeMovement(row({ name: 'Double Unders', reps: '50' }))
    expect(m).toEqual({ exerciseId: 'fx_seed_double_unders', reps: 50 })
  })
  it('returns null for empty names regardless of exerciseId', () => {
    expect(normalizeMovement(row({ name: '  ', exerciseId: 'fx_01ABC', reps: '5' }))).toBeNull()
  })
  it('emits loadBwMultiple instead of loadKg in bw mode (Linda-style)', () => {
    const m = normalizeMovement(
      row({ name: 'Deadlift', loadMode: 'bw', loadBwMultiple: '1.5', loadKg: '100' }),
    )
    expect(m).toEqual({ exerciseId: 'fx_seed_deadlift', loadBwMultiple: 1.5 })
  })
  it('only emits scoreUnit for interval bodies and scored for max_reps bodies', () => {
    const cal = row({ name: 'Rowing Erg', scoreUnit: 'calories' })
    expect(normalizeMovement(cal, 'interval')).toEqual({
      exerciseId: 'fx_seed_rowing_erg',
      scoreUnit: 'calories',
    })
    expect(normalizeMovement(cal, 'for_time')).toEqual({ exerciseId: 'fx_seed_rowing_erg' })
    const unscored = row({ name: 'Run', scored: false })
    expect(normalizeMovement(unscored, 'max_reps_rounds')).toEqual({
      exerciseId: 'fx_seed_run',
      scored: false,
    })
    expect(normalizeMovement(unscored, 'amrap')).toEqual({ exerciseId: 'fx_seed_run' })
  })
})

describe('strength template editing', () => {
  it('round-trips a strength body through state and back', () => {
    const body = {
      kind: 'strength' as const,
      blocks: [
        {
          exerciseId: 'fx_seed_back_squat',
          name: 'Back Squat',
          sets: [{ reps: 5, loadKg: 100 }, { reps: 5, loadKg: 110 }],
        },
      ],
    }
    const state = stateFromStrengthTemplate({ name: 'Lower A', body, description: 'note' })
    expect(state.name).toBe('Lower A')
    expect(state.notes).toBe('note')
    expect(state.blocks[0]!.sets).toEqual([sset('5', '100'), sset('5', '110')])
    const v = validateStrengthForSave(state)
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.payload.body).toEqual(body)
      expect(v.payload.description).toBe('note')
    }
  })

  it('normalizeStrengthBlock drops empty names and rep-less sets', () => {
    expect(
      normalizeStrengthBlock({
        name: ' ',
        exerciseId: 'fx_x',
        workUnit: 'reps',
        sets: [sset('5')],
        restS: '',
      }),
    ).toBeNull()
    expect(
      normalizeStrengthBlock({
        name: 'Plank',
        exerciseId: null,
        workUnit: 'reps',
        sets: [sset('', '20')],
        restS: '',
      }),
    ).toBeNull()
    const b = normalizeStrengthBlock({
      name: 'Push Press',
      exerciseId: null,
      workUnit: 'reps',
      sets: [sset('3', '60'), sset('', '70')],
      restS: '',
    })
    expect(b).toEqual({
      exerciseId: 'fx_seed_push_press',
      name: 'Push Press',
      sets: [{ reps: 3, loadKg: 60 }],
    })
  })

  it('normalizeStrengthBlock parses, clamps, and silently drops restS', () => {
    const row = {
      name: 'Bench Press',
      exerciseId: 'fx_seed_bench_press',
      workUnit: 'reps' as const,
      sets: [sset('5', '80')],
    }
    // Plain value round-trips (whole seconds).
    expect(normalizeStrengthBlock({ ...row, restS: '120' })!.restS).toBe(120)
    // Empty means "no prescription" — the key is omitted entirely.
    expect('restS' in normalizeStrengthBlock({ ...row, restS: '' })!).toBe(false)
    // Zero is meaningful (no rest) and survives.
    expect(normalizeStrengthBlock({ ...row, restS: '0' })!.restS).toBe(0)
    // Over-cap clamps to the schema's 600s ceiling.
    expect(normalizeStrengthBlock({ ...row, restS: '999' })!.restS).toBe(600)
    // mm:ss text parses (the field is authored as mm:ss now); decimal
    // seconds round like the old raw number field accepted them.
    expect(normalizeStrengthBlock({ ...row, restS: '1:30' })!.restS).toBe(90)
    expect(normalizeStrengthBlock({ ...row, restS: ':45' })!.restS).toBe(45)
    expect(normalizeStrengthBlock({ ...row, restS: '90.6' })!.restS).toBe(91)
    // Garbage / negative drop silently, same convention as loadKg.
    expect('restS' in normalizeStrengthBlock({ ...row, restS: 'abc' })!).toBe(false)
    expect('restS' in normalizeStrengthBlock({ ...row, restS: '-5' })!).toBe(false)
  })

  it('stateFromStrengthTemplate hydrates restS and round-trips it', () => {
    const body = {
      kind: 'strength' as const,
      blocks: [
        {
          exerciseId: 'fx_seed_deadlift',
          name: 'Deadlift',
          sets: [{ reps: 5, loadKg: 140 }],
          restS: 180,
        },
        {
          exerciseId: 'fx_seed_pull_up',
          name: 'Pull Up',
          sets: [{ reps: 8 }],
        },
      ],
    }
    const state = stateFromStrengthTemplate({ name: 'Pull day', body, description: null })
    expect(state.blocks[0]!.restS).toBe('3:00')
    expect(state.blocks[1]!.restS).toBe('')
    const v = validateStrengthForSave(state)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.payload.body).toEqual(body)
  })

  it('validateStrengthForSave rejects empty name and zero valid blocks', () => {
    const state = stateFromStrengthTemplate({
      name: 'X',
      body: {
        kind: 'strength',
        blocks: [{ exerciseId: 'fx_a', name: 'A', sets: [{ reps: 5 }] }],
      },
      description: null,
    })
    expect(validateStrengthForSave({ ...state, name: ' ' }).ok).toBe(false)
    expect(
      validateStrengthForSave({
        ...state,
        blocks: [
          { name: '', exerciseId: null, workUnit: 'reps', sets: [sset('')], restS: '' },
        ],
      }).ok,
    ).toBe(false)
  })

  it('amrap sets survive an empty rep field and round-trip', () => {
    const b = normalizeStrengthBlock({
      name: 'Bench Press',
      exerciseId: 'fx_seed_bench_press',
      workUnit: 'reps',
      sets: [sset('5', '80'), sset('', '80', { amrap: true })],
      restS: '',
    })
    expect(b!.sets).toEqual([
      { reps: 5, loadKg: 80 },
      { amrap: true, loadKg: 80 },
    ])
    // With a rep hint the hint is preserved.
    const withHint = normalizeStrengthBlock({
      name: 'Bench Press',
      exerciseId: 'fx_seed_bench_press',
      workUnit: 'reps',
      sets: [sset('12', '', { amrap: true })],
      restS: '',
    })
    expect(withHint!.sets).toEqual([{ amrap: true, reps: 12 }])
    // Hydration flips the flag back on.
    const state = stateFromStrengthTemplate({
      name: 'B',
      description: null,
      body: { kind: 'strength', blocks: [b!] },
    })
    expect(state.blocks[0]!.sets[1]).toMatchObject({ amrap: true, reps: '' })
  })

  it('amrap is ignored on non-rep units', () => {
    const b = normalizeStrengthBlock({
      name: 'Assault Bike',
      exerciseId: 'fx_seed_assault_bike',
      workUnit: 'calories',
      sets: [sset('', '', { amrap: true })],
      restS: '',
    })
    expect(b).toBeNull() // no amount, no rep-unit amrap → pruned
  })

  it('target rpe snaps to half steps, clamps 1–10, drops garbage', () => {
    const mk = (rpe: string) =>
      normalizeStrengthBlock({
        name: 'Squat',
        exerciseId: 'fx_seed_back_squat',
        workUnit: 'reps',
        sets: [sset('5', '', { rpe })],
        restS: '',
      })!.sets[0]!
    expect(mk('8').rpe).toBe(8)
    expect(mk('8.3').rpe).toBe(8.5)
    expect(mk('11').rpe).toBeUndefined()
    expect(mk('0.4').rpe).toBeUndefined()
    expect(mk('abc').rpe).toBeUndefined()
    // Hydration round-trip.
    const state = stateFromStrengthTemplate({
      name: 'S',
      description: null,
      body: {
        kind: 'strength',
        blocks: [{ exerciseId: 'fx_a', name: 'A', sets: [{ reps: 5, rpe: 8.5 }] }],
      },
    })
    expect(state.blocks[0]!.sets[0]!.rpe).toBe('8.5')
  })

  it('restAfterS and group pass through hydrate → normalize untouched', () => {
    const body = {
      kind: 'strength' as const,
      blocks: [
        {
          exerciseId: 'fx_seed_back_squat',
          name: 'Back Squat',
          sets: [{ reps: 5, loadKg: 100 }],
          restS: 90,
          restAfterS: 180,
          group: 'A',
        },
        {
          exerciseId: 'fx_seed_pull_up',
          name: 'Pull Up',
          sets: [{ reps: 8 }],
          group: 'A',
        },
      ],
    }
    const state = stateFromStrengthTemplate({ name: 'SS', body, description: null })
    const v = validateStrengthForSave(state)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.payload.body).toEqual(body)
  })

  it('applyFirstSetToAll copies set 1 over the block', () => {
    const block = {
      name: 'Squat',
      exerciseId: 'fx_seed_back_squat',
      workUnit: 'reps' as const,
      sets: [sset('5', '100', { rpe: '8' }), sset('3', '120'), sset('', '')],
      restS: '',
    }
    const applied = applyFirstSetToAll(block)
    expect(applied.sets).toEqual([
      sset('5', '100', { rpe: '8' }),
      sset('5', '100', { rpe: '8' }),
      sset('5', '100', { rpe: '8' }),
    ])
    // Copies, not shared references.
    expect(applied.sets[0]).not.toBe(applied.sets[1])
    // One-set blocks are a no-op.
    const single = { ...block, sets: [sset('5')] }
    expect(applyFirstSetToAll(single)).toBe(single)
  })

  it('applyRestToAllBlocks stamps the rest text on every rep block but skips distance', () => {
    const state = {
      name: 'X',
      notes: '',
      blocks: [
        { name: 'A', exerciseId: null, workUnit: 'reps' as const, sets: [sset('5')], restS: '1:30' },
        { name: 'B', exerciseId: null, workUnit: 'reps' as const, sets: [sset('5')], restS: '' },
        // Distance (running) blocks don't show a rest field — a stamped
        // rest there would be invisible + unclearable, so it's skipped.
        {
          name: 'Run',
          exerciseId: 'fx_seed_run',
          workUnit: 'distance' as const,
          sets: [sset('5000')],
          restS: '',
        },
      ],
    }
    const applied = applyRestToAllBlocks(state, '2:00')
    expect(applied.blocks.map((b) => b.restS)).toEqual(['2:00', '2:00', ''])
  })

  it('showRestForBlock hides rest only for distance work', () => {
    expect(showRestForBlock('reps')).toBe(true)
    expect(showRestForBlock('calories')).toBe(true)
    expect(showRestForBlock('time')).toBe(true)
    expect(showRestForBlock('distance')).toBe(false)
  })

  it('validateStrengthForStart defaults the name and skips the name gate', () => {
    const state = {
      name: ' ',
      notes: '',
      blocks: [
        {
          name: 'Back Squat',
          exerciseId: 'fx_seed_back_squat',
          workUnit: 'reps' as const,
          sets: [sset('5', '100')],
          restS: '',
        },
      ],
    }
    const v = validateStrengthForStart(state)
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.name).toBe('Free strength')
      expect(v.body.blocks).toHaveLength(1)
    }
    expect(validateStrengthForStart({ ...state, name: 'Lower A' })).toMatchObject({
      ok: true,
      name: 'Lower A',
    })
    // Still needs at least one usable set.
    const empty = { ...state, blocks: [{ ...state.blocks[0]!, sets: [sset('')] }] }
    expect(validateStrengthForStart(empty).ok).toBe(false)
  })

  it('slugify strips leading/trailing underscores (shared with AddBlockSheet ids)', () => {
    expect(slugify('Pause Squat!')).toBe('pause_squat')
    expect(slugify('- T-Bar Row -')).toBe('t_bar_row')
    expect(slugify('  Back Squat  ')).toBe('back_squat')
  })
})

describe('running blocks (distance + time + incline, m/mi)', () => {
  const runBase = { name: 'Run', exerciseId: 'fx_seed_run', restS: '' }

  it('normalizes a miles-entered run to storage metres with time + incline', () => {
    const b = normalizeStrengthBlock({
      ...runBase,
      workUnit: 'distance',
      distanceUnit: 'mi',
      sets: [sset('5', '', { timeS: '40:00', inclinePct: '1.5', rpe: '7' })],
    })
    expect(b?.sets[0]).toEqual({ distanceM: 8046.72, timeS: 2400, inclinePct: 1.5, rpe: 7 })
  })

  it('metre-entered runs pass through unconverted', () => {
    const b = normalizeStrengthBlock({
      ...runBase,
      workUnit: 'distance',
      distanceUnit: 'm',
      sets: [sset('5000', '', { timeS: '1800' })],
    })
    expect(b?.sets[0]).toEqual({ distanceM: 5000, timeS: 1800 })
  })

  it('drops out-of-range incline and unparseable time silently', () => {
    const b = normalizeStrengthBlock({
      ...runBase,
      workUnit: 'distance',
      sets: [sset('5000', '', { timeS: 'abc', inclinePct: '101' })],
    })
    expect(b?.sets[0]).toEqual({ distanceM: 5000 })
  })

  it('drops a stale rest typed before the block was flipped to distance', () => {
    // A rest value survives on the row after MEASURED IN flips to
    // distance (the toggle only changes workUnit); it's hidden in the UI
    // and must not reach the saved payload.
    const b = normalizeStrengthBlock({
      ...runBase,
      restS: '2:00',
      workUnit: 'distance',
      sets: [sset('5000', '', { timeS: '25:00' })],
    })
    expect(b?.restS).toBeUndefined()
  })

  it('time/incline never leak onto non-distance blocks', () => {
    const b = normalizeStrengthBlock({
      name: 'Back Squat',
      exerciseId: 'fx_seed_back_squat',
      restS: '',
      workUnit: 'reps',
      sets: [sset('5', '100', { timeS: '1:00', inclinePct: '2' })],
    })
    expect(b?.sets[0]).toEqual({ reps: 5, loadKg: 100 })
  })

  it('stateFromStrengthTemplate hydrates a run back into miles + mm:ss', () => {
    const state = stateFromStrengthTemplate({
      name: 'Tempo run',
      description: null,
      body: {
        kind: 'strength',
        blocks: [
          {
            exerciseId: 'fx_seed_run',
            name: 'Run',
            sets: [{ distanceM: 8046.72, timeS: 2400, inclinePct: 1.5, rpe: 7 }],
          },
        ],
      },
    })
    const b = state.blocks[0]!
    expect(b.workUnit).toBe('distance')
    expect(b.distanceUnit).toBe('mi')
    expect(b.sets[0]).toMatchObject({ reps: '5', timeS: '40:00', inclinePct: '1.5', rpe: '7' })
  })

  it('hydrates odd metre distances in metres', () => {
    const state = stateFromStrengthTemplate({
      name: 'Intervals',
      description: null,
      body: {
        kind: 'strength',
        blocks: [
          { exerciseId: 'fx_seed_run', name: 'Run', sets: [{ distanceM: 400 }] },
        ],
      },
    })
    expect(state.blocks[0]!.distanceUnit).toBe('m')
    expect(state.blocks[0]!.sets[0]!.reps).toBe('400')
  })
})

describe('switchDistanceUnit', () => {
  const block = (unit: 'm' | 'mi', amounts: string[]) => ({
    name: 'Run',
    exerciseId: 'fx_seed_run',
    restS: '',
    workUnit: 'distance' as const,
    distanceUnit: unit,
    sets: amounts.map((a) => sset(a)),
  })

  it('converts typed amounts so the stored distance is unchanged', () => {
    const toMi = switchDistanceUnit(block('m', ['8046.72', '']), 'mi')
    expect(toMi.distanceUnit).toBe('mi')
    expect(toMi.sets.map((s) => s.reps)).toEqual(['5', ''])
    const backToM = switchDistanceUnit(toMi, 'm')
    expect(backToM.sets[0]!.reps).toBe('8046.72')
  })

  it('leaves unparseable amounts alone and no-ops on same unit', () => {
    const b = block('m', ['abc'])
    expect(switchDistanceUnit(b, 'mi').sets[0]!.reps).toBe('abc')
    expect(switchDistanceUnit(b, 'm')).toEqual(b)
  })

  it('does not touch amounts on non-distance blocks', () => {
    const reps = { ...block('m', ['5000']), workUnit: 'reps' as const }
    expect(switchDistanceUnit(reps, 'mi').sets[0]!.reps).toBe('5000')
  })
})

// Strength block-row helper for superset tests.
function sblock(
  name: string,
  extra: Partial<ComposerStrengthBlockRow> = {},
): ComposerStrengthBlockRow {
  return {
    name,
    exerciseId: null,
    workUnit: 'reps',
    sets: [sset('5', '100')],
    restS: '',
    ...extra,
  }
}

describe('superset authoring helpers', () => {
  it('nextComposerGroupKey picks the first unused letter', () => {
    expect(nextComposerGroupKey([sblock('a')])).toBe('A')
    expect(
      nextComposerGroupKey([sblock('a', { group: 'A' }), sblock('b', { group: 'C' })]),
    ).toBe('B')
  })

  it('toggle links two ungrouped blocks under a fresh letter', () => {
    const state = { name: '', notes: '', blocks: [sblock('Squat'), sblock('Row')] }
    const next = toggleSupersetWithPrevious(state, 1)
    expect(next.blocks.map((b) => b.group)).toEqual(['A', 'A'])
  })

  it('toggle joins an existing bracket when the previous block is grouped', () => {
    const state = {
      name: '',
      notes: '',
      blocks: [sblock('Squat', { group: 'A' }), sblock('Row', { group: 'A' }), sblock('Curl')],
    }
    const next = toggleSupersetWithPrevious(state, 2)
    expect(next.blocks.map((b) => b.group)).toEqual(['A', 'A', 'A'])
  })

  it('toggle unlinks and dissolves a bracket left with one member, clearing intraRestS', () => {
    const state = {
      name: '',
      notes: '',
      blocks: [
        sblock('Squat', { group: 'A', intraRestS: '0:30' }),
        sblock('Row', { group: 'A', intraRestS: '0:20' }),
      ],
    }
    const next = toggleSupersetWithPrevious(state, 1)
    expect(next.blocks.map((b) => b.group ?? null)).toEqual([null, null])
    expect(next.blocks.map((b) => b.intraRestS)).toEqual(['', ''])
  })

  it('toggle unlink keeps a 3-member bracket alive for the remaining two', () => {
    const state = {
      name: '',
      notes: '',
      blocks: [
        sblock('Squat', { group: 'A' }),
        sblock('Row', { group: 'A' }),
        sblock('Curl', { group: 'A' }),
      ],
    }
    const next = toggleSupersetWithPrevious(state, 2)
    expect(next.blocks.map((b) => b.group ?? null)).toEqual(['A', 'A', null])
  })

  it('toggle no-ops on the first block and out-of-range indices', () => {
    const state = { name: '', notes: '', blocks: [sblock('Squat'), sblock('Row')] }
    expect(toggleSupersetWithPrevious(state, 0)).toBe(state)
    expect(toggleSupersetWithPrevious(state, 9)).toBe(state)
  })

  it('renumberGroups dissolves singleton runs after a delete and re-letters in order', () => {
    // Deleting the middle A split nothing here, but a stale letter order
    // (C before A) and a singleton (B) both normalize.
    const blocks = [
      sblock('a', { group: 'C' }),
      sblock('b', { group: 'C' }),
      sblock('c', { group: 'B', intraRestS: '0:30' }),
      sblock('d'),
      sblock('e', { group: 'A' }),
      sblock('f', { group: 'A' }),
    ]
    const out = renumberGroups(blocks)
    expect(out.map((b) => b.group ?? null)).toEqual(['A', 'A', null, null, 'B', 'B'])
    expect(out[2]!.intraRestS).toBe('')
  })

  it('renumberGroups splits non-consecutive same-letter runs into separate brackets', () => {
    const blocks = [
      sblock('a', { group: 'A' }),
      sblock('b', { group: 'A' }),
      sblock('c'),
      sblock('d', { group: 'A' }),
      sblock('e', { group: 'A' }),
    ]
    const out = renumberGroups(blocks)
    expect(out.map((b) => b.group ?? null)).toEqual(['A', 'A', null, 'B', 'B'])
  })

  it('hydrate -> normalize round-trips group, restAfterS and intraRestS', () => {
    const body = {
      kind: 'strength' as const,
      blocks: [
        {
          exerciseId: 'fx_seed_back_squat',
          name: 'Back Squat',
          sets: [{ reps: 5, loadKg: 100 }],
          restS: 90,
          group: 'A',
          intraRestS: 45,
        },
        {
          exerciseId: 'fx_seed_pull_up',
          name: 'Pull Up',
          sets: [{ reps: 8 }],
          restAfterS: 180,
          group: 'A',
        },
      ],
    }
    const state = stateFromStrengthTemplate({ name: 'SS', body, description: null })
    expect(state.blocks[0]!.intraRestS).toBe('0:45')
    expect(state.blocks[1]!.restAfterS).toBe('3:00')
    const v = validateStrengthForSave(state)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.payload.body).toEqual(body)
  })

  it('normalize drops intraRestS on ungrouped blocks (stale value after unlink)', () => {
    const b = normalizeStrengthBlock(sblock('Squat', { intraRestS: '0:30' }))
    expect(b!.intraRestS).toBeUndefined()
  })
})

describe('moveStrengthBlock', () => {
  const mk = (blocks: ComposerStrengthBlockRow[]) => ({ name: '', notes: '', blocks })

  it('moves a block up and down', () => {
    const state = mk([sblock('Squat'), sblock('Press'), sblock('Curl')])
    const up = moveStrengthBlock(state, 2, -1)
    expect(up.blocks.map((b) => b.name)).toEqual(['Squat', 'Curl', 'Press'])
    const down = moveStrengthBlock(state, 0, 1)
    expect(down.blocks.map((b) => b.name)).toEqual(['Press', 'Squat', 'Curl'])
  })

  it('no-ops at the edges and out of range', () => {
    const state = mk([sblock('Squat'), sblock('Press')])
    expect(moveStrengthBlock(state, 0, -1)).toBe(state)
    expect(moveStrengthBlock(state, 1, 1)).toBe(state)
    expect(moveStrengthBlock(state, 5, -1)).toBe(state)
  })

  it('dissolves a bracket left with one member when a block moves out', () => {
    const state = mk([
      sblock('Squat', { group: 'A', intraRestS: '0:20' }),
      sblock('Row', { group: 'A', intraRestS: '0:20' }),
      sblock('Curl'),
    ])
    const next = moveStrengthBlock(state, 1, 1)
    expect(next.blocks.map((b) => b.name)).toEqual(['Squat', 'Curl', 'Row'])
    // Both former members ungroup (a bracket of one is no bracket).
    expect(next.blocks.map((b) => b.group ?? null)).toEqual([null, null, null])
  })

  it('re-letters brackets in document order after a move', () => {
    const state = mk([
      sblock('A1', { group: 'A' }),
      sblock('A2', { group: 'A' }),
      sblock('B1', { group: 'B' }),
      sblock('B2', { group: 'B' }),
      sblock('Solo'),
    ])
    // Move Solo between the brackets: letters stay consecutive A, B.
    const next = moveStrengthBlock(state, 4, -1)
    expect(next.blocks.map((b) => b.name)).toEqual(['A1', 'A2', 'B1', 'Solo', 'B2'])
    // B's run is split by Solo — the singleton runs dissolve.
    expect(next.blocks.map((b) => b.group ?? null)).toEqual(['A', 'A', null, null, null])
  })

  it('moving a bracket member within its bracket keeps the bracket', () => {
    const state = mk([
      sblock('A1', { group: 'A' }),
      sblock('A2', { group: 'A' }),
      sblock('A3', { group: 'A' }),
    ])
    const next = moveStrengthBlock(state, 2, -1)
    expect(next.blocks.map((b) => b.name)).toEqual(['A1', 'A3', 'A2'])
    expect(next.blocks.map((b) => b.group)).toEqual(['A', 'A', 'A'])
  })
})
