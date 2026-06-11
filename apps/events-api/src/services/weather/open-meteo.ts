import type {
  AirQualityDto,
  WeatherForecastDto,
  WeatherProvider,
  WeatherProviderInput,
  WeatherProviderResult,
} from './types.js'

// Open-Meteo implementation of the WeatherProvider contract (slice 12).
//
// Two endpoints fan out in parallel: the main /v1/forecast for weather
// + UV and /v1/air-quality for PM/AQI. Either may succeed independently
// — we return whatever did. No API key required (Open-Meteo's free
// tier is unauthenticated). Commercial deployments may swap in a paid
// key via `commercialApiKey`; the provider forwards it as a query
// param per Open-Meteo's docs.

export interface OpenMeteoConfig {
  forecastUrl: string // default https://api.open-meteo.com/v1/forecast
  airQualityUrl: string // default https://air-quality-api.open-meteo.com/v1/air-quality
  // Optional. When set, Open-Meteo Commercial forwards via the same
  // base URL with `?apikey=...`. Free tier leaves this undefined.
  commercialApiKey?: string | undefined
  // Injected for tests.
  fetchImpl?: typeof fetch
}

const FORECAST_DAILY_VARS = [
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_sum',
  'precipitation_probability_max',
  'wind_speed_10m_max',
  'uv_index_max',
  'weather_code',
  'sunrise',
  'sunset',
].join(',')

const FORECAST_CURRENT_VARS = [
  'temperature_2m',
  'apparent_temperature',
  'wind_speed_10m',
  'weather_code',
  'is_day',
].join(',')

const AIR_QUALITY_CURRENT_VARS = [
  'us_aqi',
  'european_aqi',
  'pm2_5',
  'pm10',
  'ozone',
  'dust',
].join(',')

const AIR_QUALITY_HOURLY_VARS = ['us_aqi', 'pm2_5', 'pm10'].join(',')

export function createOpenMeteoProvider(config: OpenMeteoConfig): WeatherProvider {
  const doFetch = config.fetchImpl ?? globalThis.fetch

  async function fetchForecast(input: WeatherProviderInput): Promise<WeatherForecastDto | null> {
    const qs = new URLSearchParams({
      latitude: String(input.lat),
      longitude: String(input.lng),
      timezone: input.timezone,
      daily: FORECAST_DAILY_VARS,
      current: FORECAST_CURRENT_VARS,
      wind_speed_unit: 'kmh',
      temperature_unit: 'celsius',
      precipitation_unit: 'mm',
    })
    if (input.startDate) qs.set('start_date', input.startDate)
    if (input.endDate) qs.set('end_date', input.endDate)
    if (config.commercialApiKey) qs.set('apikey', config.commercialApiKey)

    const res = await doFetch(`${config.forecastUrl}?${qs.toString()}`)
    if (!res.ok) return null
    const json = (await res.json()) as OpenMeteoForecastResponse
    return mapForecast(json)
  }

  async function fetchAirQuality(input: WeatherProviderInput): Promise<AirQualityDto | null> {
    const qs = new URLSearchParams({
      latitude: String(input.lat),
      longitude: String(input.lng),
      timezone: input.timezone,
      current: AIR_QUALITY_CURRENT_VARS,
      hourly: AIR_QUALITY_HOURLY_VARS,
      domains: 'cams_global',
    })
    if (input.startDate) qs.set('start_date', input.startDate)
    if (input.endDate) qs.set('end_date', input.endDate)
    if (config.commercialApiKey) qs.set('apikey', config.commercialApiKey)

    const res = await doFetch(`${config.airQualityUrl}?${qs.toString()}`)
    if (!res.ok) return null
    const json = (await res.json()) as OpenMeteoAirQualityResponse
    return mapAirQuality(json)
  }

  return {
    async getEventWeather(input: WeatherProviderInput): Promise<WeatherProviderResult> {
      const [forecast, airQuality] = await Promise.allSettled([
        fetchForecast(input),
        fetchAirQuality(input),
      ])
      return {
        forecast: forecast.status === 'fulfilled' ? forecast.value : null,
        airQuality: airQuality.status === 'fulfilled' ? airQuality.value : null,
        issuedAt: new Date().toISOString(),
      }
    },
  }
}

// --- Native Open-Meteo response shapes (subset) ----------------------

interface OpenMeteoForecastResponse {
  current?: {
    time?: string
    temperature_2m?: number
    apparent_temperature?: number
    wind_speed_10m?: number
    weather_code?: number
    is_day?: number
  }
  daily?: {
    time?: string[]
    temperature_2m_max?: number[]
    temperature_2m_min?: number[]
    precipitation_sum?: number[]
    precipitation_probability_max?: number[]
    wind_speed_10m_max?: number[]
    uv_index_max?: number[]
    weather_code?: number[]
    sunrise?: string[]
    sunset?: string[]
  }
}

interface OpenMeteoAirQualityResponse {
  current?: {
    us_aqi?: number
    european_aqi?: number
    pm2_5?: number
    pm10?: number
    ozone?: number
    dust?: number
  }
  hourly?: {
    time?: string[]
    us_aqi?: number[]
    pm2_5?: number[]
    pm10?: number[]
  }
}

function mapForecast(r: OpenMeteoForecastResponse): WeatherForecastDto {
  const c = r.current
  const d = r.daily
  return {
    units: { temperature: 'C', precipitation: 'mm', windSpeed: 'km/h' },
    current: c
      ? {
          temperature: c.temperature_2m ?? null,
          apparentTemperature: c.apparent_temperature ?? null,
          windSpeed: c.wind_speed_10m ?? null,
          weatherCode: c.weather_code ?? null,
          isDay: c.is_day === undefined ? null : c.is_day === 1,
        }
      : null,
    daily: (d?.time ?? []).map((date, i) => ({
      date,
      temperatureMax: d?.temperature_2m_max?.[i] ?? null,
      temperatureMin: d?.temperature_2m_min?.[i] ?? null,
      precipitationSum: d?.precipitation_sum?.[i] ?? null,
      precipitationProbabilityMax: d?.precipitation_probability_max?.[i] ?? null,
      windSpeedMax: d?.wind_speed_10m_max?.[i] ?? null,
      uvIndexMax: d?.uv_index_max?.[i] ?? null,
      weatherCode: d?.weather_code?.[i] ?? null,
      sunrise: d?.sunrise?.[i] ?? null,
      sunset: d?.sunset?.[i] ?? null,
    })),
  }
}

function mapAirQuality(r: OpenMeteoAirQualityResponse): AirQualityDto {
  const c = r.current
  const h = r.hourly
  // Bucket hourly into per-day max/mean for the daily summary.
  const buckets: Record<string, { aqis: number[]; pm25s: number[]; pm10s: number[] }> = {}
  const times = h?.time ?? []
  for (let i = 0; i < times.length; i++) {
    const iso = times[i]!
    const date = iso.slice(0, 10)
    const b = (buckets[date] ??= { aqis: [], pm25s: [], pm10s: [] })
    const a = h?.us_aqi?.[i]
    const p2 = h?.pm2_5?.[i]
    const p10 = h?.pm10?.[i]
    if (typeof a === 'number') b.aqis.push(a)
    if (typeof p2 === 'number') b.pm25s.push(p2)
    if (typeof p10 === 'number') b.pm10s.push(p10)
  }
  const daily = Object.entries(buckets).map(([date, b]) => ({
    date,
    usAqiMax: b.aqis.length > 0 ? Math.max(...b.aqis) : null,
    pm2_5Mean:
      b.pm25s.length > 0 ? Number((b.pm25s.reduce((a, b) => a + b, 0) / b.pm25s.length).toFixed(1)) : null,
    pm10Mean:
      b.pm10s.length > 0 ? Number((b.pm10s.reduce((a, b) => a + b, 0) / b.pm10s.length).toFixed(1)) : null,
  }))
  daily.sort((a, b) => a.date.localeCompare(b.date))
  return {
    current: c
      ? {
          usAqi: c.us_aqi ?? null,
          europeanAqi: c.european_aqi ?? null,
          pm2_5: c.pm2_5 ?? null,
          pm10: c.pm10 ?? null,
          ozone: c.ozone ?? null,
          dust: c.dust ?? null,
        }
      : null,
    daily,
  }
}
