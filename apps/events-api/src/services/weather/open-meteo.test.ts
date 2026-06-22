import { describe, it, expect, vi } from 'vitest'
import { createOpenMeteoProvider } from './open-meteo.js'

// Unit tests for the Open-Meteo provider mapper. Fakes the global
// fetch to return canned responses and asserts the request URLs +
// the WeatherProviderResult shape the route persists.

function makeFakeFetch(handler: (req: Request) => Promise<Response> | Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const req = new Request(url, init)
    return handler(req)
  })
}

describe('createOpenMeteoProvider', () => {
  it('builds the forecast + air-quality URLs with the right query params', async () => {
    const urls: string[] = []
    const fetchImpl = makeFakeFetch((req) => {
      urls.push(req.url)
      if (req.url.includes('air-quality')) {
        return new Response(
          JSON.stringify({ current: { us_aqi: 42 }, hourly: { time: [], us_aqi: [], pm2_5: [], pm10: [] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({ current: {}, daily: { time: [] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const provider = createOpenMeteoProvider({
      forecastUrl: 'https://api.open-meteo.com/v1/forecast',
      airQualityUrl: 'https://air-quality-api.open-meteo.com/v1/air-quality',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await provider.getEventWeather({
      lat: 51.5,
      lng: -0.12,
      startDate: '2026-06-01',
      endDate: '2026-06-03',
      timezone: 'Europe/London',
    })

    expect(urls).toHaveLength(2)
    const forecast = urls.find((u) => u.includes('/v1/forecast'))!
    expect(forecast).toContain('latitude=51.5')
    expect(forecast).toContain('longitude=-0.12')
    expect(forecast).toContain('timezone=Europe%2FLondon')
    expect(forecast).toContain('start_date=2026-06-01')
    expect(forecast).toContain('end_date=2026-06-03')
    expect(forecast).toContain('uv_index_max')
    // No hourly series unless explicitly requested (keeps the event-weather
    // path's persisted blob compact).
    expect(forecast).not.toContain('hourly=')

    const aq = urls.find((u) => u.includes('air-quality'))!
    expect(aq).toContain('us_aqi')
    expect(aq).toContain('pm2_5')

    expect(result.airQuality?.current?.usAqi).toBe(42)
    expect(result.forecast?.hourly).toBeUndefined()
  })

  it('requests + maps the hourly series only when includeHourly is set', async () => {
    let forecastUrl = ''
    const fetchImpl = makeFakeFetch((req) => {
      if (req.url.includes('air-quality')) {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }
      forecastUrl = req.url
      return new Response(
        JSON.stringify({
          current: { temperature_2m: 18 },
          daily: { time: ['2026-06-01'], uv_index_max: [6] },
          hourly: {
            time: ['2026-06-01T00:00', '2026-06-01T01:00'],
            temperature_2m: [15, 16],
            uv_index: [0, 1],
            weather_code: [1, 61],
            is_day: [0, 1],
            precipitation_probability: [10, 80],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const provider = createOpenMeteoProvider({
      forecastUrl: 'https://api.open-meteo.com/v1/forecast',
      airQualityUrl: 'https://air-quality-api.open-meteo.com/v1/air-quality',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const r = await provider.getEventWeather({
      lat: 0,
      lng: 0,
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      timezone: 'UTC',
      includeHourly: true,
    })

    expect(forecastUrl).toContain('hourly=')
    expect(forecastUrl).toContain('uv_index')
    expect(forecastUrl).toContain('precipitation_probability')
    expect(r.forecast?.hourly).toHaveLength(2)
    expect(r.forecast?.hourly?.[0]).toEqual({
      time: '2026-06-01T00:00',
      temperature: 15,
      uvIndex: 0,
      weatherCode: 1,
      isDay: false,
      precipitationProbability: 10,
    })
    expect(r.forecast?.hourly?.[1]!.isDay).toBe(true)
    expect(r.forecast?.hourly?.[1]!.precipitationProbability).toBe(80)
  })

  it('returns partial results when one of the two upstream calls fails', async () => {
    const fetchImpl = makeFakeFetch((req) => {
      if (req.url.includes('air-quality')) return new Response('boom', { status: 500 })
      return new Response(
        JSON.stringify({
          current: { temperature_2m: 18.5, wind_speed_10m: 12 },
          daily: {
            time: ['2026-06-01', '2026-06-02'],
            temperature_2m_max: [22, 24],
            temperature_2m_min: [12, 14],
            uv_index_max: [6, 7],
            weather_code: [1, 2],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const provider = createOpenMeteoProvider({
      forecastUrl: 'https://api.open-meteo.com/v1/forecast',
      airQualityUrl: 'https://air-quality-api.open-meteo.com/v1/air-quality',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await provider.getEventWeather({
      lat: 0,
      lng: 0,
      startDate: null,
      endDate: null,
      timezone: 'UTC',
    })
    expect(result.forecast?.daily).toHaveLength(2)
    expect(result.forecast?.daily[0]!.uvIndexMax).toBe(6)
    expect(result.airQuality).toBeNull()
  })

  it('forwards the commercial API key as the `apikey` query param when configured', async () => {
    let observedUrl = ''
    const fetchImpl = makeFakeFetch((req) => {
      if (!req.url.includes('air-quality')) observedUrl = req.url
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const provider = createOpenMeteoProvider({
      forecastUrl: 'https://api.open-meteo.com/v1/forecast',
      airQualityUrl: 'https://air-quality-api.open-meteo.com/v1/air-quality',
      commercialApiKey: 'secret-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await provider.getEventWeather({
      lat: 1,
      lng: 2,
      startDate: null,
      endDate: null,
      timezone: 'UTC',
    })
    expect(observedUrl).toContain('apikey=secret-key')
  })

  it('buckets hourly AQI into per-day max', async () => {
    const fetchImpl = makeFakeFetch((req) => {
      if (req.url.includes('air-quality')) {
        return new Response(
          JSON.stringify({
            current: { us_aqi: 80 },
            hourly: {
              time: ['2026-06-01T00:00', '2026-06-01T12:00', '2026-06-02T00:00'],
              us_aqi: [40, 90, 55],
              pm2_5: [10, 20, 15],
              pm10: [20, 30, 25],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const provider = createOpenMeteoProvider({
      forecastUrl: 'https://api.open-meteo.com/v1/forecast',
      airQualityUrl: 'https://air-quality-api.open-meteo.com/v1/air-quality',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const r = await provider.getEventWeather({
      lat: 0,
      lng: 0,
      startDate: null,
      endDate: null,
      timezone: 'UTC',
    })
    expect(r.airQuality?.daily).toHaveLength(2)
    expect(r.airQuality?.daily[0]!.date).toBe('2026-06-01')
    expect(r.airQuality?.daily[0]!.usAqiMax).toBe(90)
    expect(r.airQuality?.daily[1]!.date).toBe('2026-06-02')
    expect(r.airQuality?.daily[1]!.usAqiMax).toBe(55)
  })
})
