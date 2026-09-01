import { describe, expect, it } from 'vitest'
import type { WorkoutWeather } from '@rallypoint/fitness-shared'
import {
  CARDIO_ACTIVITIES,
  RUN_EXERCISE_ID,
  buildCardioWorkoutPayload,
  initialCardioLogForm,
  switchCardioDistanceUnit,
  validateCardioLog,
  type CardioLogForm,
} from './cardio-log-state.js'

const AT = '2026-07-14T07:30:00.000Z'

function form(over: Partial<CardioLogForm> = {}): CardioLogForm {
  return { ...initialCardioLogForm(), ...over }
}

describe('initialCardioLogForm', () => {
  it('defaults to the Run activity, metres, and empty fields', () => {
    expect(initialCardioLogForm()).toEqual({
      exerciseId: RUN_EXERCISE_ID,
      distance: '',
      distanceUnit: 'm',
      timeText: '',
      inclinePct: '',
      rpe: null,
      notes: '',
    })
  })

  it('prefills a trimmed note', () => {
    expect(initialCardioLogForm('  5k easy  ').notes).toBe('5k easy')
    expect(initialCardioLogForm('   ').notes).toBe('')
    expect(initialCardioLogForm(null).notes).toBe('')
  })
})

describe('validateCardioLog', () => {
  it('requires a distance or a time', () => {
    expect(validateCardioLog(form())).toBe('Enter a distance or a time.')
    expect(validateCardioLog(form({ distance: '5000' }))).toBeNull()
    expect(validateCardioLog(form({ timeText: '30:00' }))).toBeNull()
  })

  it('rejects an out-of-range incline', () => {
    expect(validateCardioLog(form({ distance: '5000', inclinePct: '101' }))).toMatch(/Incline/)
    expect(validateCardioLog(form({ distance: '5000', inclinePct: '-1' }))).toMatch(/Incline/)
    expect(validateCardioLog(form({ distance: '5000', inclinePct: '6' }))).toBeNull()
  })

  it('treats a zero distance/time as not entered', () => {
    expect(validateCardioLog(form({ distance: '0', timeText: '0:00' }))).toBe(
      'Enter a distance or a time.',
    )
  })
})

describe('buildCardioWorkoutPayload', () => {
  it('maps a metres run to an endurance workout with one run set', () => {
    const p = buildCardioWorkoutPayload(
      form({ distance: '5000', timeText: '30:00', inclinePct: '2', rpe: 7 }),
      AT,
    )
    expect(p.modality).toBe('endurance')
    expect(p.title).toBe('Run')
    expect(p.performedAt).toBe(AT)
    expect(p.durationS).toBe(1800)
    expect(p.rpe).toBe(7)
    expect(p.sets).toEqual([
      {
        exerciseId: RUN_EXERCISE_ID,
        setIndex: 0,
        distanceM: 5000,
        timeS: 1800,
        inclinePct: 2,
        rpe: 7,
      },
    ])
  })

  it('converts miles to stored metres', () => {
    const p = buildCardioWorkoutPayload(form({ distance: '5', distanceUnit: 'mi' }), AT)
    // 5 mi × 1609.344 = 8046.72 m
    expect(p.sets[0]!.distanceM).toBe(8046.72)
  })

  it('drops blank/zero amounts and omits weather when absent', () => {
    const p = buildCardioWorkoutPayload(form({ timeText: '25:00' }), AT)
    expect(p.sets[0]!.distanceM).toBeUndefined()
    expect(p.sets[0]!.inclinePct).toBeUndefined()
    expect(p.sets[0]!.rpe).toBeUndefined()
    expect(p.rpe).toBeUndefined()
    expect(p.notes).toBeUndefined()
    expect(p.payload).toEqual({})
  })

  it('spreads a captured weather snapshot into the payload', () => {
    const weather: WorkoutWeather = {
      temperatureC: 18.2,
      apparentTemperatureC: 17.5,
      windSpeedKmh: 9,
      weatherCode: 1,
      isDay: true,
      fetchedAt: AT,
    }
    const p = buildCardioWorkoutPayload(form({ distance: '3000' }), AT, weather)
    expect(p.payload).toEqual({ weather })
  })

  it('forwards a trimmed note', () => {
    const p = buildCardioWorkoutPayload(form({ distance: '3000', notes: '  tempo  ' }), AT)
    expect(p.notes).toBe('tempo')
  })

  it('uses the selected activity for exerciseId and title', () => {
    const rowing = CARDIO_ACTIVITIES.find((a) => a.exerciseId === 'fx_seed_rowing_erg')!
    const p = buildCardioWorkoutPayload(
      form({ exerciseId: rowing.exerciseId, distance: '2000' }),
      AT,
    )
    expect(p.title).toBe('Rowing (Erg)')
    expect(p.sets[0]!.exerciseId).toBe('fx_seed_rowing_erg')
  })

  it('falls back to Cardio for an unrecognized exercise id', () => {
    const p = buildCardioWorkoutPayload(
      form({ exerciseId: 'fx_seed_unknown', distance: '1000' }),
      AT,
    )
    expect(p.title).toBe('Cardio')
  })
})

describe('switchCardioDistanceUnit', () => {
  it('converts the typed amount m → mi and back', () => {
    const m = form({ distance: '8046.72', distanceUnit: 'm' })
    const mi = switchCardioDistanceUnit(m, 'mi')
    expect(mi.distanceUnit).toBe('mi')
    expect(mi.distance).toBe('5')
    const back = switchCardioDistanceUnit(mi, 'm')
    expect(back.distanceUnit).toBe('m')
    expect(back.distance).toBe('8046.72')
  })

  it('is a no-op for the same unit', () => {
    const f = form({ distance: '5000' })
    expect(switchCardioDistanceUnit(f, 'm')).toBe(f)
  })

  it('passes a blank amount through, only flipping the unit', () => {
    const f = form({ distance: '' })
    expect(switchCardioDistanceUnit(f, 'mi')).toEqual({ ...f, distanceUnit: 'mi' })
  })
})
