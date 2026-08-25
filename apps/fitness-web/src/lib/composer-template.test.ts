import { describe, it, expect } from 'vitest'
import {
  composerBracket,
  scheduleToDayKey,
  showLoadForUnit,
  stateFromTemplate,
  todayDayKey,
} from './composer-template.js'
import type { WodBody } from '@rallypoint/fitness-shared'

describe('stateFromTemplate', () => {
  it('hydrates an amrap body', () => {
    const body: WodBody = {
      wodType: 'amrap',
      durationS: 1200,
      movements: [
        { exerciseId: 'fx_seed_burpee', reps: 10 },
        { exerciseId: 'fx_seed_pullup', reps: 5, loadKg: 20 },
      ],
    }
    const state = stateFromTemplate({
      name: 'Cindy-ish',
      body,
      description: 'a note',
      timeCapS: null,
    })
    expect(state.wodType).toBe('amrap')
    expect(state.durationMin).toBe('20')
    expect(state.capMin).toBe('')
    expect(state.notes).toBe('a note')
    expect(state.movements).toHaveLength(2)
    expect(state.movements[1]).toMatchObject({ loadKg: '20', loadMode: 'kg' })
  })

  it('hydrates a for_time body with a ladder and buy-in', () => {
    const body: WodBody = {
      wodType: 'for_time',
      rounds: 1,
      schemeRounds: [21, 15, 9],
      ladder: 'cumulative',
      perMinuteBuyIn: { exerciseId: 'fx_seed_burpee', reps: 5 },
      movements: [{ exerciseId: 'fx_seed_thruster', reps: 21 }],
    }
    const state = stateFromTemplate({
      name: 'Kalsu-ish',
      body,
      description: null,
      timeCapS: 600,
    })
    expect(state.wodType).toBe('for_time')
    expect(state.scheme).toBe('21-15-9')
    expect(state.ladderCumulative).toBe(true)
    expect(state.buyInReps).toBe('5')
    expect(state.buyInExerciseId).toBe('fx_seed_burpee')
    expect(state.capMin).toBe('10')
    expect(state.notes).toBe('')
  })

  it('hydrates a max_reps_rounds body honoring the scored default per movement', () => {
    const body: WodBody = {
      wodType: 'max_reps_rounds',
      rounds: 5,
      movements: [
        { exerciseId: 'fx_seed_pullup', reps: 0 },
        { exerciseId: 'fx_seed_situp', reps: 0, scored: false },
      ],
    }
    const state = stateFromTemplate({
      name: 'Max effort',
      body,
      description: null,
      timeCapS: null,
    })
    expect(state.wodType).toBe('max_reps_rounds')
    expect(state.durationMin).toBe('')
    // Absent `scored` on a max_reps body means unscored fixed work.
    expect(state.movements[0]?.scored).toBe(false)
    expect(state.movements[1]?.scored).toBe(false)
  })
})

describe('showLoadForUnit', () => {
  it('shows load only for reps and distance', () => {
    expect(showLoadForUnit('reps')).toBe(true)
    expect(showLoadForUnit('distance')).toBe(true)
    expect(showLoadForUnit('calories')).toBe(false)
    expect(showLoadForUnit('time')).toBe(false)
  })
})

describe('composerBracket', () => {
  it('returns a single-row bracket outside any group', () => {
    const blocks = [{ group: null }, { group: null }]
    expect(composerBracket(blocks, 1)).toEqual({ start: 1, end: 1 })
  })

  it('spans consecutive same-group rows only', () => {
    const blocks = [{ group: 'A' }, { group: 'A' }, { group: null }, { group: 'A' }]
    expect(composerBracket(blocks, 0)).toEqual({ start: 0, end: 1 })
    expect(composerBracket(blocks, 1)).toEqual({ start: 0, end: 1 })
    // The trailing group: 'A' row is not consecutive with the first
    // bracket (separated by a null), so it forms its own bracket.
    expect(composerBracket(blocks, 3)).toEqual({ start: 3, end: 3 })
  })
})

describe('scheduleToDayKey', () => {
  it('maps none to null and today to todayDayKey()', () => {
    expect(scheduleToDayKey('none')).toBeNull()
    expect(scheduleToDayKey('today')).toBe(todayDayKey())
  })

  it('passes an explicit day key through', () => {
    expect(scheduleToDayKey('wed')).toBe('wed')
  })
})
