import { describe, expect, it } from 'vitest'
import type { WorkoutWeather } from '@rallypoint/fitness-shared'
import {
  RUN_EXERCISE_ID,
  buildRunWorkoutPayload,
  initialRunLogForm,
  switchRunDistanceUnit,
  validateRunLog,
  type RunLogForm,
} from './run-log-state.js'

const AT = '2026-07-14T07:30:00.000Z'

function form(over: Partial<RunLogForm> = {}): RunLogForm {
  return { ...initialRunLogForm(), ...over }
}

describe('initialRunLogForm', () => {
  it('defaults to metres and empty fields', () => {
    expect(initialRunLogForm()).toEqual({
      distance: '',
      distanceUnit: 'm',
      timeText: '',
      inclinePct: '',
      rpe: null,
      notes: '',
    })
  })

  it('prefills a trimmed note', () => {
    expect(initialRunLogForm('  5k easy  ').notes).toBe('5k easy')
    expect(initialRunLogForm('   ').notes).toBe('')
    expect(initialRunLogForm(null).notes).toBe('')
  })
})

describe('validateRunLog', () => {
  it('requires a distance or a time', () => {
    expect(validateRunLog(form())).toBe('Enter a distance or a time.')
    expect(validateRunLog(form({ distance: '5000' }))).toBeNull()
    expect(validateRunLog(form({ timeText: '30:00' }))).toBeNull()
  })

  it('rejects an out-of-range incline', () => {
    expect(validateRunLog(form({ distance: '5000', inclinePct: '101' }))).toMatch(/Incline/)
    expect(validateRunLog(form({ distance: '5000', inclinePct: '-1' }))).toMatch(/Incline/)
    expect(validateRunLog(form({ distance: '5000', inclinePct: '6' }))).toBeNull()
  })

  it('treats a zero distance/time as not entered', () => {
    expect(validateRunLog(form({ distance: '0', timeText: '0:00' }))).toBe(
      'Enter a distance or a time.',
    )
  })
})

describe('buildRunWorkoutPayload', () => {
  it('maps a metres run to an endurance workout with one run set', () => {
    const p = buildRunWorkoutPayload(
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
    const p = buildRunWorkoutPayload(form({ distance: '5', distanceUnit: 'mi' }), AT)
    // 5 mi × 1609.344 = 8046.72 m
    expect(p.sets[0]!.distanceM).toBe(8046.72)
  })

  it('drops blank/zero amounts and omits weather when absent', () => {
    const p = buildRunWorkoutPayload(form({ timeText: '25:00' }), AT)
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
    const p = buildRunWorkoutPayload(form({ distance: '3000' }), AT, weather)
    expect(p.payload).toEqual({ weather })
  })

  it('forwards a trimmed note', () => {
    const p = buildRunWorkoutPayload(form({ distance: '3000', notes: '  tempo  ' }), AT)
    expect(p.notes).toBe('tempo')
  })
})

describe('switchRunDistanceUnit', () => {
  it('converts the typed amount m → mi and back', () => {
    const m = form({ distance: '8046.72', distanceUnit: 'm' })
    const mi = switchRunDistanceUnit(m, 'mi')
    expect(mi.distanceUnit).toBe('mi')
    expect(mi.distance).toBe('5')
    const back = switchRunDistanceUnit(mi, 'm')
    expect(back.distanceUnit).toBe('m')
    expect(back.distance).toBe('8046.72')
  })

  it('is a no-op for the same unit', () => {
    const f = form({ distance: '5000' })
    expect(switchRunDistanceUnit(f, 'm')).toBe(f)
  })

  it('passes a blank amount through, only flipping the unit', () => {
    const f = form({ distance: '' })
    expect(switchRunDistanceUnit(f, 'mi')).toEqual({ ...f, distanceUnit: 'mi' })
  })
})
