// Pure, display-only helpers for the My Day weather strip. No React/DOM, so
// the WMO-code mapping and the forecast→strip reduction are unit-testable.

import type { WeatherForecast } from './api.js'
import { WEATHER_UNIT_KEY } from './api.js'

// Temperature unit for display. The provider returns Celsius; we convert for
// display. Default is Fahrenheit (only an explicit 'celsius' setting switches).
export type WeatherUnit = 'fahrenheit' | 'celsius'

// Pure read of the weather-unit setting from a planner settings blob.
// Absent / anything other than 'celsius' → 'fahrenheit' (the default).
export function weatherUnitFromSettings(settings: Record<string, unknown>): WeatherUnit {
  return settings[WEATHER_UNIT_KEY] === 'celsius' ? 'celsius' : 'fahrenheit'
}

export interface WeatherLabel {
  label: string
  emoji: string
}

// Map an Open-Meteo WMO weather code to a short label + emoji. `isDay`
// switches the clear-sky glyph between sun and moon.
// Ref: https://open-meteo.com/en/docs (WMO Weather interpretation codes).
export function describeWeatherCode(code: number | null, isDay = true): WeatherLabel {
  if (code == null) return { label: 'Unknown', emoji: '🌡️' }
  if (code === 0) return { label: 'Clear', emoji: isDay ? '☀️' : '🌙' }
  if (code === 1 || code === 2) return { label: 'Partly cloudy', emoji: isDay ? '🌤️' : '☁️' }
  if (code === 3) return { label: 'Overcast', emoji: '☁️' }
  if (code === 45 || code === 48) return { label: 'Fog', emoji: '🌫️' }
  if (code >= 51 && code <= 57) return { label: 'Drizzle', emoji: '🌦️' }
  if (code >= 61 && code <= 67) return { label: 'Rain', emoji: '🌧️' }
  if (code >= 71 && code <= 77) return { label: 'Snow', emoji: '🌨️' }
  if (code >= 80 && code <= 82) return { label: 'Rain showers', emoji: '🌦️' }
  if (code === 85 || code === 86) return { label: 'Snow showers', emoji: '🌨️' }
  if (code >= 95 && code <= 99) return { label: 'Thunderstorm', emoji: '⛈️' }
  return { label: 'Unknown', emoji: '🌡️' }
}

// A Celsius temperature converted to `unit` and formatted, or '—' when absent.
// `withUnit` appends the unit letter (e.g. "72°F") — used on the headline temp;
// high/low stay bare ("75°") to avoid clutter.
export function formatTemp(
  tempC: number | null | undefined,
  unit: WeatherUnit,
  withUnit = false,
): string {
  if (tempC == null) return '—'
  const v = Math.round(unit === 'fahrenheit' ? (tempC * 9) / 5 + 32 : tempC)
  return withUnit ? `${v}°${unit === 'fahrenheit' ? 'F' : 'C'}` : `${v}°`
}

export interface WeatherStrip {
  emoji: string
  label: string
  temp: string
  high: string
  low: string
  /** Today's max precipitation probability (0–100), or null. */
  precipPct: number | null
  /** Today's max UV index (dimensionless), or null. */
  uvIndex: number | null
}

// Reduce a forecast to the handful of values the strip renders. Prefers the
// `current` block for the headline temp/condition, falling back to today's
// daily entry. Returns null when there's no forecast to show.
export function summarizeWeather(
  forecast: WeatherForecast | null | undefined,
  unit: WeatherUnit,
): WeatherStrip | null {
  if (!forecast) return null
  const current = forecast.current
  const today = forecast.daily[0] ?? null
  if (!current && !today) return null
  const code = current?.weatherCode ?? today?.weatherCode ?? null
  const { label, emoji } = describeWeatherCode(code, current?.isDay ?? true)
  return {
    emoji,
    label,
    temp: formatTemp(current?.temperature ?? null, unit, true),
    high: formatTemp(today?.temperatureMax ?? null, unit),
    low: formatTemp(today?.temperatureMin ?? null, unit),
    precipPct: today?.precipitationProbabilityMax ?? null,
    uvIndex: today?.uvIndexMax ?? null,
  }
}

// EPA UV-index exposure bands. `level` is a stable key for styling (a tint
// per band); `label` is the human text shown beside the number.
export type UvLevel = 'low' | 'moderate' | 'high' | 'very-high' | 'extreme'

export interface UvCategory {
  level: UvLevel
  label: string
}

export function uvCategory(uv: number | null | undefined): UvCategory | null {
  if (uv == null || !Number.isFinite(uv)) return null
  const v = Math.round(uv)
  if (v <= 2) return { level: 'low', label: 'Low' }
  if (v <= 5) return { level: 'moderate', label: 'Moderate' }
  if (v <= 7) return { level: 'high', label: 'High' }
  if (v <= 10) return { level: 'very-high', label: 'Very high' }
  return { level: 'extreme', label: 'Extreme' }
}

// What an hourly cell renders. `temp` is preformatted in the active unit;
// `uv` is the rounded index (null when absent); `emoji` reflects the code.
export interface HourlyCell {
  iso: string
  hourLabel: string // e.g. "3 PM"
  temp: string
  uv: number | null
  emoji: string
  label: string // condition text, e.g. "Rain"
}

// Format an ISO-local hour ("2026-06-17T15:00") as a compact "3 PM". Reads
// the hour straight off the string (the provider already aligned to the
// requested timezone) so it's deterministic and DST-safe.
export function formatHourLabel(iso: string): string {
  const m = /T(\d{2}):/.exec(iso)
  if (!m) return ''
  const h = Number(m[1])
  const period = h < 12 ? 'AM' : 'PM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12} ${period}`
}

// Reduce a forecast's hourly series to the cells the strip renders: hours at
// or after `fromIso` (lexicographic compare works on ISO-local strings),
// capped at `max`. Returns [] when there's no hourly data.
export function summarizeHourly(
  forecast: WeatherForecast | null | undefined,
  unit: WeatherUnit,
  opts: { fromIso?: string | null; max?: number } = {},
): HourlyCell[] {
  const hours = forecast?.hourly
  if (!hours || hours.length === 0) return []
  const from = opts.fromIso ?? null
  const max = opts.max ?? 12
  const out: HourlyCell[] = []
  for (const h of hours) {
    if (from && h.time < from) continue
    const { label, emoji } = describeWeatherCode(h.weatherCode, h.isDay ?? true)
    out.push({
      iso: h.time,
      hourLabel: formatHourLabel(h.time),
      temp: formatTemp(h.temperature, unit),
      uv: h.uvIndex == null ? null : Math.round(h.uvIndex),
      emoji,
      label,
    })
    if (out.length >= max) break
  }
  return out
}

// Classify a manual location query: a bare 5-digit string is a US ZIP,
// anything else is treated as a place name. Keeps the routing decision pure
// and unit-testable; the actual geocoding fetch stays in the component.
export type LocationQuery = { kind: 'zip'; value: string } | { kind: 'city'; value: string }

export function classifyLocationQuery(raw: string): LocationQuery {
  const q = raw.trim()
  return /^\d{5}$/.test(q) ? { kind: 'zip', value: q } : { kind: 'city', value: q }
}
