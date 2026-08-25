import { describe, it, expect } from 'vitest'
import {
  applyScanToState,
  emptyComposerState,
  validateForSave,
  type ScannedWod,
} from './composer-state.js'

// The whiteboard photo from the bug report:
//   B. METCON — 10 Rounds
//   3 Shoulder to Overhead @ 155/105 lbs / 5 Toes to Bar / 7 Burpees Over Bar
const METCON: ScannedWod = {
  type: 'rounds_for_time',
  rounds: 10,
  movements: [
    { name: 'Shoulder to Overhead', reps: 3, loadKg: 70.31 },
    { name: 'Toes to Bar', reps: 5 },
    { name: 'Burpees Over Bar', reps: 7 },
  ],
}

describe('applyScanToState round counts', () => {
  it('takes the round count from the scan, not the composer default', () => {
    const next = applyScanToState(emptyComposerState(), METCON, 'lb')
    expect(next.wodType).toBe('rounds_for_time')
    expect(next.rounds).toBe('10')
    expect(next.movements.map((m) => m.reps)).toEqual(['3', '5', '7'])
  })

  it('blanks the round count when the scan could not read it', () => {
    // Never inherit emptyComposerState's '3'. A blank box is a question;
    // a defaulted 3 is a wrong answer that saves without complaint.
    const { rounds: _omitted, ...noRounds } = METCON
    const next = applyScanToState(emptyComposerState(), noRounds, 'lb')
    expect(next.rounds).toBe('')
  })

  it('stops the save when the round count is missing', () => {
    const { rounds: _omitted, ...noRounds } = METCON
    const next = applyScanToState(emptyComposerState(), noRounds, 'lb')
    const result = validateForSave({ ...next, name: 'B. Metcon' }, 'lb')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.field).toBe('rounds')
  })

  it('saves the scanned round count through to the body', () => {
    const next = applyScanToState(emptyComposerState(), METCON, 'lb')
    const result = validateForSave({ ...next, name: 'B. Metcon' }, 'lb')
    expect(result.ok).toBe(true)
    expect(result.ok === true && result.payload.body).toMatchObject({
      wodType: 'rounds_for_time',
      rounds: 10,
    })
  })
})

describe('applyScanToState type switching', () => {
  it('clears the for_time rep scheme when the scan is a rounds board', () => {
    // emptyComposerState is for_time with scheme '21-15-9'. Assigning
    // wodType directly (what the component used to do) left that stale
    // ladder behind on every rounds_for_time scan.
    expect(emptyComposerState().scheme).toBe('21-15-9')
    const next = applyScanToState(emptyComposerState(), METCON, 'lb')
    expect(next.scheme).toBe('')
  })

  it('blanks a stale scheme even when the type does not change', () => {
    // switchType early-returns on an unchanged type, so the blanking has
    // to be explicit rather than a side effect of the switch.
    const start = { ...emptyComposerState(), scheme: '21-15-9' }
    const next = applyScanToState(start, { type: 'for_time', movements: [{ name: 'thruster' }] }, 'lb')
    expect(next.wodType).toBe('for_time')
    expect(next.scheme).toBe('')
  })

  it('clears the cumulative-ladder toggle so it cannot outrank a scanned scheme', () => {
    // switchType PRESERVES ladderCumulative whenever the new type is
    // for_time, and early-returns entirely when the type is unchanged — so
    // without an explicit reset a 12-Days template rescanned over a
    // "21-15-9" board saves as a cumulative ladder and silently discards
    // the scanned scheme (validateForSave's cumulative branch never reads
    // it, and the scheme input is hidden while the toggle is on).
    const twelveDays = { ...emptyComposerState(), ladderCumulative: true, name: '12 Days' }
    const next = applyScanToState(
      twelveDays,
      { type: 'for_time', scheme: '21-15-9', movements: [{ name: 'Thruster', reps: 21 }] },
      'lb',
    )
    expect(next.ladderCumulative).toBe(false)
    expect(next.scheme).toBe('21-15-9')
    const result = validateForSave({ ...next, name: 'Fran' }, 'lb')
    expect(result.ok === true && result.payload.body).toMatchObject({
      wodType: 'for_time',
      schemeRounds: [21, 15, 9],
    })
  })

  it('clears a stale Kalsu buy-in that the scan never reported', () => {
    const kalsu = {
      ...emptyComposerState(),
      buyInName: 'Burpee',
      buyInExerciseId: 'fx_burpee',
      buyInReps: '5',
    }
    const next = applyScanToState(
      kalsu,
      { type: 'for_time', scheme: '21-15-9', movements: [{ name: 'Thruster', reps: 21 }] },
      'lb',
    )
    expect([next.buyInName, next.buyInExerciseId, next.buyInReps]).toEqual(['', null, ''])
  })

  it('carries capMin and notes through from the scan', () => {
    const next = applyScanToState(
      emptyComposerState(),
      {
        type: 'rounds_for_time',
        rounds: 5,
        capMin: 12,
        notes: 'scale to knee raises',
        movements: [{ name: 'pull-up', reps: 5 }],
      },
      'lb',
    )
    expect(next.capMin).toBe('12')
    expect(next.notes).toBe('scale to knee raises')
  })

  it('carries the per-type fields for each of the six WOD types', () => {
    const emom = applyScanToState(
      emptyComposerState(),
      { type: 'emom', intervalS: 90, totalIntervals: 30, movements: [{ name: 'row' }] },
      'lb',
    )
    expect([emom.wodType, emom.intervalS, emom.totalIntervals]).toEqual(['emom', '90', '30'])

    const fgb = applyScanToState(
      emptyComposerState(),
      { type: 'interval', rounds: 3, workS: 60, restS: 60, movements: [{ name: 'row' }] },
      'lb',
    )
    expect([fgb.wodType, fgb.rounds, fgb.workS, fgb.restS]).toEqual(['interval', '3', '60', '60'])

    const lynne = applyScanToState(
      emptyComposerState(),
      { type: 'max_reps_rounds', rounds: 5, movements: [{ name: 'bench press' }] },
      'lb',
    )
    expect([lynne.wodType, lynne.rounds, lynne.durationMin]).toEqual(['max_reps_rounds', '5', ''])

    const cindy = applyScanToState(
      emptyComposerState(),
      { type: 'amrap', durationMin: 20, movements: [{ name: 'pull-up' }] },
      'lb',
    )
    expect([cindy.wodType, cindy.durationMin]).toEqual(['amrap', '20'])
  })

  it('blanks the AMRAP window when the scan could not read it', () => {
    // switchType would substitute '20'; the scan path must not.
    const next = applyScanToState(
      emptyComposerState(),
      { type: 'amrap', movements: [{ name: 'pull-up' }] },
      'lb',
    )
    expect(next.durationMin).toBe('')
  })
})

describe('applyScanToState load units', () => {
  it('seeds the row in pounds for a pounds user', () => {
    const next = applyScanToState(emptyComposerState(), METCON, 'lb')
    expect(next.movements[0]!.loadKg).toBe('155')
  })

  it('seeds the same scan in kg for a kg user', () => {
    const next = applyScanToState(emptyComposerState(), METCON, 'kg')
    expect(next.movements[0]!.loadKg).toBe('70.31')
  })

  it('round-trips the display value back to the scanned kg on save', () => {
    const next = applyScanToState(emptyComposerState(), METCON, 'lb')
    const result = validateForSave({ ...next, name: 'B. Metcon' }, 'lb')
    expect(result.ok === true && result.payload.body.movements[0]!.loadKg).toBe(70.31)
  })

  it('leaves the load blank when the board did not prescribe one', () => {
    const next = applyScanToState(emptyComposerState(), METCON, 'lb')
    expect(next.movements[1]!.loadKg).toBe('')
  })
})

describe('applyScanToState unreadable boards', () => {
  it('leaves an in-progress draft untouched when nothing was legible', () => {
    // The route reports a total miss as a 200 with {type: null,
    // movements: []}; wiping the user's draft over that would be worse
    // than doing nothing.
    const draft = { ...emptyComposerState(), name: 'Half-written', rounds: '7' }
    expect(applyScanToState(draft, { type: null, movements: [] }, 'lb')).toBe(draft)
  })

  it('keeps existing movement rows when the scan read a type but no movements', () => {
    const draft = emptyComposerState()
    const next = applyScanToState(draft, { type: 'rounds_for_time', rounds: 4, movements: [] }, 'lb')
    expect(next.rounds).toBe('4')
    expect(next.movements).toEqual(draft.movements)
  })

  it('keeps the user note when the scan did not read one', () => {
    const draft = { ...emptyComposerState(), notes: 'partner wod' }
    const next = applyScanToState(draft, METCON, 'lb')
    expect(next.notes).toBe('partner wod')
  })
})
