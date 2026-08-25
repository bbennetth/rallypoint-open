import { describe, expect, it } from 'vitest'
import { buildStrengthSession, strengthSessionReducer } from '@rallypoint/fitness-shared'
import { sessionHasDistanceWork, weatherFromForecast } from './run-weather.js'

function runSession(distanceM: number | null, done: boolean) {
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
            distanceM,
            timeS: 1800,
            inclinePct: null,
            loadKg: null,
            done: false,
            doneAtMs: null,
            setType: 'working' as const,
          },
        ],
      },
    ],
  })
  s = strengthSessionReducer(s, { kind: 'START', nowMs: 0 })
  if (done) s = strengthSessionReducer(s, { kind: 'COMPLETE_SET', blockIdx: 0, setIdx: 0, nowMs: 1 })
  return s
}

describe('sessionHasDistanceWork', () => {
  it('true only for COMPLETED distance sets', () => {
    expect(sessionHasDistanceWork(runSession(5000, true))).toBe(true)
    expect(sessionHasDistanceWork(runSession(5000, false))).toBe(false)
    expect(sessionHasDistanceWork(runSession(null, true))).toBe(false)
  })
})

describe('weatherFromForecast', () => {
  const AT = '2026-07-14T07:30:00.000Z'

  it('maps current conditions to the payload snapshot', () => {
    expect(
      weatherFromForecast(
        {
          current: {
            temperature: 18.2,
            apparentTemperature: 17.5,
            windSpeed: 9,
            weatherCode: 1,
            isDay: true,
          },
        },
        AT,
      ),
    ).toEqual({
      temperatureC: 18.2,
      apparentTemperatureC: 17.5,
      windSpeedKmh: 9,
      weatherCode: 1,
      isDay: true,
      fetchedAt: AT,
    })
  })

  it('fills nullish optionals and requires a finite temperature', () => {
    expect(weatherFromForecast({ current: { temperature: 21 } }, AT)).toEqual({
      temperatureC: 21,
      apparentTemperatureC: null,
      windSpeedKmh: null,
      weatherCode: null,
      isDay: null,
      fetchedAt: AT,
    })
    expect(weatherFromForecast(null, AT)).toBeNull()
    expect(weatherFromForecast({ current: null }, AT)).toBeNull()
    expect(
      weatherFromForecast({ current: { temperature: Number.NaN } }, AT),
    ).toBeNull()
  })
})
