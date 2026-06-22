import { describe, expect, it } from 'vitest'
import {
  classifyLocationQuery,
  describeWeatherCode,
  formatHourLabel,
  formatTemp,
  summarizeHourly,
  summarizeWeather,
  uvCategory,
  weatherUnitFromSettings,
} from './weather-helpers.js'
import type { WeatherForecast } from './api.js'

describe('describeWeatherCode', () => {
  it('maps clear sky with a day/night glyph', () => {
    expect(describeWeatherCode(0, true)).toEqual({ label: 'Clear', emoji: '☀️' })
    expect(describeWeatherCode(0, false).emoji).toBe('🌙')
  })

  it('maps rain, snow, fog, thunderstorm ranges to labels', () => {
    expect(describeWeatherCode(63).label).toBe('Rain')
    expect(describeWeatherCode(75).label).toBe('Snow')
    expect(describeWeatherCode(48).label).toBe('Fog')
    expect(describeWeatherCode(95).label).toBe('Thunderstorm')
    expect(describeWeatherCode(81).label).toBe('Rain showers')
  })

  it('handles a null/unknown code', () => {
    expect(describeWeatherCode(null).label).toBe('Unknown')
    expect(describeWeatherCode(999).label).toBe('Unknown')
  })
})

describe('weatherUnitFromSettings', () => {
  it('defaults to fahrenheit when absent or unrecognized', () => {
    expect(weatherUnitFromSettings({})).toBe('fahrenheit')
    expect(weatherUnitFromSettings({ weatherUnit: 'bogus' })).toBe('fahrenheit')
    expect(weatherUnitFromSettings({ weatherUnit: 'fahrenheit' })).toBe('fahrenheit')
  })

  it('switches to celsius only on an explicit setting', () => {
    expect(weatherUnitFromSettings({ weatherUnit: 'celsius' })).toBe('celsius')
  })
})

describe('formatTemp', () => {
  it('keeps Celsius values in celsius', () => {
    expect(formatTemp(21.6, 'celsius')).toBe('22°')
    expect(formatTemp(-0.4, 'celsius')).toBe('0°')
  })

  it('converts Celsius to Fahrenheit', () => {
    expect(formatTemp(20, 'fahrenheit')).toBe('68°') // 20*9/5+32
    expect(formatTemp(0, 'fahrenheit')).toBe('32°')
  })

  it('appends the unit letter when withUnit', () => {
    expect(formatTemp(20, 'fahrenheit', true)).toBe('68°F')
    expect(formatTemp(20, 'celsius', true)).toBe('20°C')
  })

  it('renders an em-dash for null/undefined', () => {
    expect(formatTemp(null, 'fahrenheit')).toBe('—')
    expect(formatTemp(undefined, 'celsius')).toBe('—')
  })
})

function forecast(over: Partial<WeatherForecast> = {}): WeatherForecast {
  return {
    units: { temperature: 'C', precipitation: 'mm', windSpeed: 'km/h' },
    current: {
      temperature: 18.2,
      apparentTemperature: 17,
      windSpeed: 9,
      weatherCode: 2,
      isDay: true,
    },
    daily: [
      {
        date: '2026-06-13',
        temperatureMax: 24,
        temperatureMin: 12,
        precipitationProbabilityMax: 40,
        uvIndexMax: 7,
        weatherCode: 61,
      },
    ],
    ...over,
  }
}

describe('summarizeWeather', () => {
  it('returns null without a forecast', () => {
    expect(summarizeWeather(null, 'fahrenheit')).toBeNull()
    expect(summarizeWeather(undefined, 'celsius')).toBeNull()
  })

  it('formats in Fahrenheit (the default), unit-suffixing the headline', () => {
    const s = summarizeWeather(forecast(), 'fahrenheit')!
    expect(s.temp).toBe('65°F') // 18.2°C → 64.76 → 65
    expect(s.high).toBe('75°') // 24°C → 75.2 → 75
    expect(s.low).toBe('54°') // 12°C → 53.6 → 54
    expect(s.label).toBe('Partly cloudy') // current.weatherCode = 2
    expect(s.precipPct).toBe(40)
    expect(s.uvIndex).toBe(7) // daily[0].uvIndexMax
  })

  it('formats in Celsius when requested', () => {
    const s = summarizeWeather(forecast(), 'celsius')!
    expect(s.temp).toBe('18°C')
    expect(s.high).toBe('24°')
    expect(s.low).toBe('12°')
  })

  it('falls back to today’s daily code when current is absent', () => {
    const s = summarizeWeather(forecast({ current: null }), 'fahrenheit')!
    expect(s.label).toBe('Rain') // daily[0].weatherCode = 61
    expect(s.temp).toBe('—')
    expect(s.high).toBe('75°')
  })

  it('returns null when both current and daily are empty', () => {
    expect(summarizeWeather(forecast({ current: null, daily: [] }), 'fahrenheit')).toBeNull()
  })
})

describe('uvCategory', () => {
  it('maps the EPA bands by rounded value', () => {
    expect(uvCategory(0)?.level).toBe('low')
    expect(uvCategory(2.4)?.label).toBe('Low') // rounds to 2
    expect(uvCategory(2.5)?.level).toBe('moderate') // rounds to 3
    expect(uvCategory(5)?.label).toBe('Moderate')
    expect(uvCategory(6)?.label).toBe('High')
    expect(uvCategory(8)?.label).toBe('Very high')
    expect(uvCategory(11)?.label).toBe('Extreme')
    expect(uvCategory(14)?.level).toBe('extreme')
  })

  it('returns null for absent / non-finite input', () => {
    expect(uvCategory(null)).toBeNull()
    expect(uvCategory(undefined)).toBeNull()
    expect(uvCategory(Number.NaN)).toBeNull()
  })
})

describe('classifyLocationQuery', () => {
  it('treats a bare 5-digit string as a US ZIP', () => {
    expect(classifyLocationQuery('90210')).toEqual({ kind: 'zip', value: '90210' })
    expect(classifyLocationQuery('  10001 ')).toEqual({ kind: 'zip', value: '10001' })
  })

  it('treats everything else as a city name', () => {
    expect(classifyLocationQuery('Austin').kind).toBe('city')
    expect(classifyLocationQuery('1234').kind).toBe('city') // 4 digits
    expect(classifyLocationQuery('123456').kind).toBe('city') // 6 digits
    expect(classifyLocationQuery('London, UK').kind).toBe('city')
  })
})

describe('formatHourLabel', () => {
  it('formats an ISO-local hour as a 12-hour clock', () => {
    expect(formatHourLabel('2026-06-17T00:00')).toBe('12 AM')
    expect(formatHourLabel('2026-06-17T09:00')).toBe('9 AM')
    expect(formatHourLabel('2026-06-17T12:00')).toBe('12 PM')
    expect(formatHourLabel('2026-06-17T15:00')).toBe('3 PM')
    expect(formatHourLabel('2026-06-17T23:00')).toBe('11 PM')
  })

  it('returns empty string for an unparseable value', () => {
    expect(formatHourLabel('nonsense')).toBe('')
  })
})

describe('summarizeHourly', () => {
  const hourly: NonNullable<WeatherForecast['hourly']> = [
    { time: '2026-06-17T08:00', temperature: 18, uvIndex: 1.6, weatherCode: 0, isDay: true, precipitationProbability: 0 },
    { time: '2026-06-17T12:00', temperature: 24, uvIndex: 7.2, weatherCode: 2, isDay: true, precipitationProbability: 10 },
    { time: '2026-06-17T20:00', temperature: 16, uvIndex: 0, weatherCode: 61, isDay: false, precipitationProbability: 80 },
  ]

  it('returns [] without hourly data', () => {
    expect(summarizeHourly(forecast(), 'fahrenheit')).toEqual([])
    expect(summarizeHourly(forecast({ hourly: [] }), 'fahrenheit')).toEqual([])
  })

  it('formats, converts temp, and rounds UV', () => {
    const cells = summarizeHourly(forecast({ hourly }), 'celsius')
    expect(cells).toHaveLength(3)
    expect(cells[0]).toMatchObject({ hourLabel: '8 AM', temp: '18°', uv: 2, label: 'Clear' })
    expect(cells[2]).toMatchObject({ hourLabel: '8 PM', uv: 0, label: 'Rain', emoji: '🌧️' })
    // Fahrenheit conversion flows through formatTemp.
    expect(summarizeHourly(forecast({ hourly }), 'fahrenheit')[1]!.temp).toBe('75°') // 24°C
  })

  it('filters to hours at/after fromIso and caps at max', () => {
    const fromNoon = summarizeHourly(forecast({ hourly }), 'celsius', { fromIso: '2026-06-17T12:00' })
    expect(fromNoon.map((c) => c.hourLabel)).toEqual(['12 PM', '8 PM'])
    const capped = summarizeHourly(forecast({ hourly }), 'celsius', { max: 2 })
    expect(capped).toHaveLength(2)
  })

  it('tolerates null fields within an hour entry', () => {
    const withNulls: NonNullable<WeatherForecast['hourly']> = [
      { time: '2026-06-17T10:00', temperature: null, uvIndex: null, weatherCode: null, isDay: null, precipitationProbability: null },
    ]
    const [cell] = summarizeHourly(forecast({ hourly: withNulls }), 'fahrenheit')
    expect(cell).toMatchObject({ hourLabel: '10 AM', temp: '—', uv: null, label: 'Unknown' })
  })
})
