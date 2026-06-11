// Pure decision helpers for the WeatherPanel — UV severity bands
// (WHO) and US AQI categorical labels (EPA AirNow). Extracted from
// the component so the band thresholds are unit-testable without RTL.
//
// Sources:
// - WHO UV index: https://www.who.int/news-room/questions-and-answers/item/radiation-the-ultraviolet-(uv)-index
// - EPA AirNow AQI breakpoints: https://www.airnow.gov/aqi/aqi-basics/

export type UvSeverity = 'low' | 'moderate' | 'high' | 'very-high' | 'extreme'

export const UV_COLOR: Record<UvSeverity, string> = {
  low: 'var(--ok, #22c55e)',
  moderate: 'var(--accent, #f59e0b)',
  high: '#fb923c',
  'very-high': 'var(--hot, #ef4444)',
  extreme: '#a855f7',
}

export function uvSeverity(uv: number | null): UvSeverity {
  if (uv == null) return 'low'
  if (uv >= 11) return 'extreme'
  if (uv >= 8) return 'very-high'
  if (uv >= 6) return 'high'
  if (uv >= 3) return 'moderate'
  return 'low'
}

// "very-high" → "VERY HIGH"
export function uvWord(s: UvSeverity): string {
  return s.replace('-', ' ').toUpperCase()
}

export type AqiCategory =
  | 'GOOD'
  | 'MODERATE'
  | 'USG'
  | 'UNHEALTHY'
  | 'VERY UNHEALTHY'
  | 'HAZARDOUS'

// US AQI breakpoints per EPA AirNow.
//   0-50    GOOD
//   51-100  MODERATE
//   101-150 USG  (Unhealthy for Sensitive Groups)
//   151-200 UNHEALTHY
//   201-300 VERY UNHEALTHY
//   301+    HAZARDOUS
export function aqiSeverityLabel(aqi: number | null): AqiCategory | null {
  if (aqi == null) return null
  if (aqi >= 301) return 'HAZARDOUS'
  if (aqi >= 201) return 'VERY UNHEALTHY'
  if (aqi >= 151) return 'UNHEALTHY'
  if (aqi >= 101) return 'USG'
  if (aqi >= 51) return 'MODERATE'
  return 'GOOD'
}

// Celsius temperature label. `null` → em-dash. Used by WeatherPanel
// and any future surface that mirrors the metric Open-Meteo data.
export function tempLabel(c: number | null): string {
  if (c == null) return '—'
  return `${Math.round(c)}°C`
}
