// Best-effort weather snapshot for running/outdoor sessions. At save
// time, a session that contains distance work triggers one geolocation
// + forecast round-trip (the same Open-Meteo pipeline Planner's My Day
// uses, proxied by fitness-api) and the snapshot rides the workout
// payload. EVERY failure path resolves to null — declined permission,
// offline save, slow GPS — so weather can never block or delay a save
// beyond the bounded timeout.

import type { StrengthSessionState, WorkoutWeather } from '@rallypoint/fitness-shared'
import { getWeather } from './api.js'

/** Does the finished session contain any completed distance (running /
 *  carry / erg-for-distance) work? Pure — drives whether the save flow
 *  bothers asking for a location at all. */
export function sessionHasDistanceWork(state: StrengthSessionState): boolean {
  return state.blocks.some((b) => b.sets.some((s) => s.done && s.distanceM != null))
}

/** Map the forecast envelope's `current` block to the payload snapshot.
 *  Null when the provider had no current conditions. Pure. */
export function weatherFromForecast(
  forecast: { current: {
    temperature: number
    apparentTemperature?: number | null
    windSpeed?: number | null
    weatherCode?: number | null
    isDay?: boolean | null
  } | null } | null,
  fetchedAtIso: string,
): WorkoutWeather | null {
  const cur = forecast?.current
  if (!cur || typeof cur.temperature !== 'number' || !Number.isFinite(cur.temperature)) {
    return null
  }
  return {
    temperatureC: cur.temperature,
    apparentTemperatureC: cur.apparentTemperature ?? null,
    windSpeedKmh: cur.windSpeed ?? null,
    weatherCode: cur.weatherCode ?? null,
    isDay: cur.isDay ?? null,
    fetchedAt: fetchedAtIso,
  }
}

const GEO_TIMEOUT_MS = 8_000

function currentPosition(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null)
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { timeout: GEO_TIMEOUT_MS, maximumAge: 600_000 },
    )
  })
}

/** One-shot capture: geolocate → fetch forecast → snapshot. Resolves
 *  null on any failure (never throws). */
export async function captureRunWeather(): Promise<WorkoutWeather | null> {
  try {
    const loc = await currentPosition()
    if (!loc) return null
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const res = await getWeather(loc.lat, loc.lng, tz)
    return weatherFromForecast(res.forecast, new Date().toISOString())
  } catch {
    return null
  }
}
