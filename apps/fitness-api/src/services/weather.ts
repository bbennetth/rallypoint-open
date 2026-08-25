import type { Service } from '@cloudflare/workers-types'
import type { EventsRPC } from '@rallypoint/events-api'
import type { WeatherService, WeatherForecastResult } from './types.js'

// fitness-api → events-api coordinate forecast (Open-Meteo), over the
// typed `Service<EventsRPC>` binding — the SAME pipeline Planner's
// My Day weather uses. The workout logger snapshots the result onto an
// outdoor/running workout at save time; nothing is stored server-side
// here. The RPC's discriminated result is passed through raw so the
// route layer owns the HTTP mapping.

export function createWeatherService(binding: Service<EventsRPC>): WeatherService {
  return {
    async getForecast(opts): Promise<WeatherForecastResult> {
      return (await binding.getCoordinateWeather({
        lat: opts.lat,
        lng: opts.lng,
        ...(opts.tz !== undefined ? { tz: opts.tz } : {}),
        ...(opts.date !== undefined ? { date: opts.date } : {}),
      })) as WeatherForecastResult
    },
  }
}
