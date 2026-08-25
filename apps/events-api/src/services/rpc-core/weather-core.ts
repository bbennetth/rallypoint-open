import { eventTimezoneField } from '@rallypoint/events-shared'
import type {
  AirQualityDto,
  WeatherForecastDto,
  WeatherProviderInput,
} from '../weather/types.js'
import type { EventsRpcDeps } from './deps.js'

// Coordinate forecast core for the /api/v1/sdk/weather endpoint
// (Planner's "Weather on My Day" by lat/lng). HTTP route validates the
// query params; the RPC method takes them as typed parameters. Both
// call this fn.

export interface CoordinateWeatherInput {
  lat: number
  lng: number
  tz?: string
  date?: string | null
}

export interface CoordinateWeatherData {
  forecast: WeatherForecastDto | null
  airQuality: AirQualityDto | null
}

// Result union. The HTTP route maps each non-ok branch to the matching
// `errors.validation(...)` 422; the RPC consumer branches on `kind` and
// reads `data` on success.
export type CoordinateWeatherResult =
  | { kind: 'bad_latlng' }
  | { kind: 'bad_tz' }
  | { kind: 'bad_date' }
  | { kind: 'ok'; data: CoordinateWeatherData }

export async function getCoordinateWeatherCore(
  input: CoordinateWeatherInput,
  deps: EventsRpcDeps,
): Promise<CoordinateWeatherResult> {
  if (
    !Number.isFinite(input.lat) ||
    !Number.isFinite(input.lng) ||
    input.lat < -90 ||
    input.lat > 90 ||
    input.lng < -180 ||
    input.lng > 180
  ) {
    return { kind: 'bad_latlng' }
  }
  const tzParsed = eventTimezoneField.safeParse(input.tz ?? 'UTC')
  if (!tzParsed.success) return { kind: 'bad_tz' }
  const date = input.date ?? null
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { kind: 'bad_date' }
  }
  const provider: WeatherProviderInput = {
    lat: input.lat,
    lng: input.lng,
    startDate: date,
    endDate: date,
    timezone: tzParsed.data,
    // My Day's strip renders an hourly breakdown; the coordinate
    // surface is the only one that needs it (event weather stays daily).
    includeHourly: true,
  }
  const result = await deps.services.weather.getEventWeather(provider)
  return { kind: 'ok', data: { forecast: result.forecast, airQuality: result.airQuality } }
}
