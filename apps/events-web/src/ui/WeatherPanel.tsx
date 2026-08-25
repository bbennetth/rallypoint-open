import { useAsync } from '@rallypoint/web-kit'
import {
  getEventWeather,
  type AirQualityDailyDto,
  type WeatherDto,
  type WeatherForecastDailyDto,
} from '../lib/api.js'
import {
  UV_COLOR,
  aqiSeverityLabel,
  tempLabel,
  uvSeverity,
  uvWord,
} from '../lib/weather-severity.js'

// Compact festival-planner-style weather panel rendered on MyDay
// below the day picker. Two rows: temps + condition + UV chip, then
// secondary stats (humidity-free since Open-Meteo current doesn't
// surface it the same way — replaced with rain%/wind/sunrise/sunset
// + AQI).
//
// Source: rallypoint's `getEventWeather()` (Open-Meteo via
// events-api scheduler + lazy fallback, slice 12). Falls back to a
// terse "weather unavailable" line when the event has no
// coordinates or the upstream call failed.

function hm(time: string | null | undefined): string {
  if (!time) return ''
  const m = /^(\d{2}):(\d{2})/.exec(time)
  return m ? `${m[1]}:${m[2]}` : time
}

function pickDay<T extends { date: string }>(items: readonly T[] | undefined, dayIso: string): T | null {
  if (!items) return null
  return items.find((d) => d.date === dayIso) ?? null
}

export function WeatherPanel({ eventId, dayIso }: { eventId: string; dayIso: string | null }) {
  // Empty forecast/airQuality (no coords / outside window) and fetch
  // failure both resolve to `data === null`, hiding the panel.
  const { data: weather } = useAsync<WeatherDto | null>(async () => {
    try {
      const w = await getEventWeather(eventId)
      if (!w.forecast && !w.airQuality) return null
      return w
    } catch {
      return null
    }
  }, [eventId])

  if (!weather || !dayIso) return null
  const forecast: WeatherForecastDailyDto | null = pickDay(weather.forecast?.daily, dayIso)
  const aq: AirQualityDailyDto | null = pickDay(weather.airQuality?.daily, dayIso)
  if (!forecast) return null

  const severity = uvSeverity(forecast.uvIndexMax)
  const uvColor = UV_COLOR[severity]
  const isToday = (() => {
    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}` === dayIso
  })()
  const aqiLabel = aqiSeverityLabel(aq?.usAqiMax ?? null)

  return (
    <div
      className="mono pl-card"
      style={{
        padding: '8px 12px',
      }}
    >
      {/* Row 1: temps + UV + condition */}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          flexWrap: 'wrap',
          rowGap: 4,
          marginBottom: 4,
        }}
      >
        {isToday && weather.forecast?.current?.temperature != null && (
          <>
            <span style={{ fontSize: 22, color: 'var(--ink)', fontWeight: 700, lineHeight: 1 }}>
              {tempLabel(weather.forecast.current.temperature)}
            </span>
            {weather.forecast.current.apparentTemperature != null && (
              <span style={{ fontSize: 9, color: 'var(--ink-mute)', letterSpacing: '0.06em' }}>
                FEELS {tempLabel(weather.forecast.current.apparentTemperature)}
              </span>
            )}
          </>
        )}
        <span style={{ fontSize: 11, color: 'var(--ink-dim)', letterSpacing: '0.04em' }}>
          HI{' '}
          <span style={{ color: 'var(--ink)', fontWeight: 700 }}>
            {tempLabel(forecast.temperatureMax)}
          </span>
          {'  '}
          LO{' '}
          <span style={{ color: 'var(--ink)', fontWeight: 700 }}>
            {tempLabel(forecast.temperatureMin)}
          </span>
        </span>
        {forecast.uvIndexMax != null && (
          <span
            role="status"
            aria-label={`UV index ${Math.round(forecast.uvIndexMax)} peak (${severity})`}
            style={{
              marginLeft: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '1px 5px',
              background: `color-mix(in srgb, ${uvColor} 16%, transparent)`,
              borderRadius: 'var(--radius-round)',
              color: uvColor,
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.06em',
              lineHeight: 1,
            }}
          >
            UV {Math.round(forecast.uvIndexMax)} {uvWord(severity)}
          </span>
        )}
      </div>

      {/* Row 2: rain / wind / sunrise/sunset / aqi */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
          rowGap: 2,
          fontSize: 9,
          color: 'var(--ink-mute)',
          letterSpacing: '0.06em',
        }}
      >
        {forecast.precipitationProbabilityMax != null && (
          <Stat label="RAIN" value={`${forecast.precipitationProbabilityMax}%`} />
        )}
        {forecast.windSpeedMax != null && (
          <Stat label="WIND" value={`${Math.round(forecast.windSpeedMax)} km/h`} />
        )}
        {forecast.sunrise && forecast.sunset && (
          <span>
            ☼{' '}
            <span style={{ color: 'var(--ink-dim)', fontWeight: 700 }}>
              {hm(forecast.sunrise.slice(11))}–{hm(forecast.sunset.slice(11))}
            </span>
          </span>
        )}
        {aqiLabel && (
          <Stat label="AQI" value={`${Math.round(aq!.usAqiMax!)} ${aqiLabel}`} />
        )}
        {weather.isStale && (
          <span
            style={{
              marginLeft: 'auto',
              padding: '0 4px',
              background: 'var(--hot-soft)',
              borderRadius: 'var(--radius-round)',
              color: 'var(--hot-text)',
              fontWeight: 700,
            }}
          >
            STALE
          </span>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span>
      {label} <span style={{ color: 'var(--ink-dim)', fontWeight: 700 }}>{value}</span>
    </span>
  )
}
