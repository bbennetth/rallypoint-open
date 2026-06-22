import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError, getMyDayWeather, getSettings, type WeatherForecast } from '../lib/api.js'
import {
  classifyLocationQuery,
  summarizeHourly,
  summarizeWeather,
  uvCategory,
  weatherUnitFromSettings,
  type UvLevel,
  type WeatherUnit,
} from '../lib/weather-helpers.js'
import { localToday } from '../lib/planner-helpers.js'
import { Icon } from './icons.js'

// My Day weather strip. Asks the browser for the user's location and shows
// today's conditions via the planner-api → events-api (Open-Meteo) proxy.
// The chosen location is remembered in localStorage so a reload doesn't
// re-prompt geolocation (and a typed ZIP sticks). If nothing is stored and
// geolocation is denied/unavailable, a manual City/ZIP search is the fallback:
// city names geocode against Open-Meteo's free, keyless, CORS-enabled
// geocoding API; bare 5-digit ZIPs resolve via zippopotam.us (US, keyless).

type Phase = 'loading' | 'ready' | 'manual'
type HourlyMetric = 'temp' | 'uv' | 'conditions'

interface GeocodeResult {
  lat: number
  lng: number
  label: string
}

// --- remembered location + metric (localStorage) --------------------
const WX_LOC_KEY = 'rallypt-planner-weather-loc'
const WX_METRIC_KEY = 'rallypt-planner-weather-metric'

interface StoredLoc {
  lat: number
  lng: number
  label: string | null
}

function readStoredLoc(): StoredLoc | null {
  try {
    const raw = localStorage.getItem(WX_LOC_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<StoredLoc>
    if (typeof v?.lat === 'number' && typeof v?.lng === 'number') {
      return { lat: v.lat, lng: v.lng, label: typeof v.label === 'string' ? v.label : null }
    }
  } catch {
    // ignore parse / access errors — fall back to geolocation
  }
  return null
}

function writeStoredLoc(loc: StoredLoc): void {
  try {
    localStorage.setItem(WX_LOC_KEY, JSON.stringify(loc))
  } catch {
    // ignore (private mode / quota) — persistence is best-effort
  }
}

function readStoredMetric(): HourlyMetric {
  try {
    const v = localStorage.getItem(WX_METRIC_KEY)
    if (v === 'temp' || v === 'uv' || v === 'conditions') return v
  } catch {
    // ignore
  }
  return 'temp'
}

function writeStoredMetric(m: HourlyMetric): void {
  try {
    localStorage.setItem(WX_METRIC_KEY, m)
  } catch {
    // ignore
  }
}

// --- geocoders (browser-direct, keyless) ----------------------------
async function geocodeCity(q: string): Promise<GeocodeResult | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1`
  const res = await fetch(url)
  if (!res.ok) return null
  const data = (await res.json()) as {
    results?: Array<{
      latitude: number
      longitude: number
      name: string
      country?: string
      admin1?: string
    }>
  }
  const r = data.results?.[0]
  if (!r) return null
  return {
    lat: r.latitude,
    lng: r.longitude,
    label: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
  }
}

// US ZIP → coordinates via zippopotam.us (free, keyless, CORS-enabled).
async function geocodeZip(zip: string): Promise<GeocodeResult | null> {
  const res = await fetch(`https://api.zippopotam.us/us/${zip}`)
  if (!res.ok) return null
  const data = (await res.json()) as {
    places?: Array<{
      latitude: string
      longitude: string
      'place name': string
      'state abbreviation'?: string
    }>
  }
  const p = data.places?.[0]
  if (!p) return null
  const lat = Number(p.latitude)
  const lng = Number(p.longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return {
    lat,
    lng,
    label: [p['place name'], p['state abbreviation']].filter(Boolean).join(', '),
  }
}

// UV band → a tint for the hourly cell + summary chip.
const UV_TINT: Record<UvLevel, string> = {
  low: 'var(--ok, #2e9e5b)',
  moderate: 'var(--warn, #c9a227)',
  high: 'var(--hot, #d8742f)',
  'very-high': 'var(--hot, #d8742f)',
  extreme: 'var(--hot, #b3261e)',
}

export function WeatherStrip() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [forecast, setForecast] = useState<WeatherForecast | null>(null)
  const [unit, setUnit] = useState<WeatherUnit>('fahrenheit')
  const [place, setPlace] = useState<string | null>(null)
  const [city, setCity] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [metric, setMetric] = useState<HourlyMetric>(() => readStoredMetric())

  // The displayed strip re-derives whenever the forecast or the unit changes,
  // so flipping the Settings toggle reformats without a refetch.
  const strip = useMemo(() => summarizeWeather(forecast, unit), [forecast, unit])
  const uv = strip ? uvCategory(strip.uvIndex) : null

  // Upcoming hours of today (from the current local hour), capped to a dozen.
  const hours = useMemo(() => {
    const { date } = localToday()
    const now = new Date()
    const fromIso = `${date}T${String(now.getHours()).padStart(2, '0')}:00`
    return summarizeHourly(forecast, unit, { fromIso, max: 12 })
  }, [forecast, unit])

  const fetchFor = useCallback(async (lat: number, lng: number, label: string | null) => {
    setPhase('loading')
    setError(null)
    try {
      const { tz, date } = localToday()
      const res = await getMyDayWeather(lat, lng, tz, date)
      const f = res.forecast
      const hasData = f != null && (f.current != null || f.daily.length > 0)
      setForecast(res.forecast)
      setPlace(label)
      if (hasData) {
        // A fresh location starts collapsed; don't carry the previous
        // place's expanded hourly panel over.
        setExpanded(false)
        setPhase('ready')
        writeStoredLoc({ lat, lng, label })
      } else {
        setError('No weather available for that location.')
        setPhase('manual')
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t load weather.')
      setPhase('manual')
    }
  }, [])

  const locate = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setPhase('manual')
      return
    }
    setPhase('loading')
    navigator.geolocation.getCurrentPosition(
      (pos) => void fetchFor(pos.coords.latitude, pos.coords.longitude, null),
      () => setPhase('manual'),
      { timeout: 10_000, maximumAge: 600_000 },
    )
  }, [fetchFor])

  // On mount: prefer a remembered location (no geolocation prompt); otherwise
  // ask the browser.
  useEffect(() => {
    const stored = readStoredLoc()
    if (stored) {
      void fetchFor(stored.lat, stored.lng, stored.label)
    } else {
      locate()
    }
  }, [fetchFor, locate])

  // Load the temperature-unit preference (default Fahrenheit). The strip
  // re-derives via summarizeWeather when this resolves.
  useEffect(() => {
    let cancelled = false
    void getSettings('planner')
      .then((s) => {
        if (!cancelled) setUnit(weatherUnitFromSettings(s))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  function selectMetric(m: HourlyMetric) {
    setMetric(m)
    writeStoredMetric(m)
  }

  async function onManualSubmit(e: React.FormEvent) {
    e.preventDefault()
    const parsed = classifyLocationQuery(city)
    if (!parsed.value) return
    setPhase('loading')
    setError(null)
    try {
      const geo = parsed.kind === 'zip' ? await geocodeZip(parsed.value) : await geocodeCity(parsed.value)
      if (!geo) {
        setError(parsed.kind === 'zip' ? 'Couldn’t find that ZIP code.' : 'Couldn’t find that place.')
        setPhase('manual')
        return
      }
      await fetchFor(geo.lat, geo.lng, geo.label)
    } catch {
      setError('Couldn’t look up that location.')
      setPhase('manual')
    }
  }

  // All three phases share one fixed-height card (`.wx-card`) so the strip
  // never resizes between setup / loading / ready; it only grows when the
  // hourly breakdown is expanded.
  if (phase === 'loading') {
    return (
      <div className="pl-card wx-card">
        <div className="wx-summary">
          <span className="meta" style={{ color: 'var(--ink-mute)' }}>Loading weather…</span>
        </div>
      </div>
    )
  }

  if (phase === 'manual') {
    // The manual card grows only to surface an error line; with no error it
    // stays the same one row (56px) as the loading/ready states.
    return (
      <div className="pl-card wx-card wx-card-manual">
        <form className="wx-summary wx-form" onSubmit={onManualSubmit}>
          <span className="meta" style={{ color: 'var(--ink-dim)', whiteSpace: 'nowrap' }}>Weather for</span>
          <input
            className="pl-input"
            aria-label="City or ZIP for weather"
            placeholder="City or ZIP…"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            style={{ width: 'auto', flex: 1, minWidth: 0 }}
          />
          <button className="pl-btn" type="submit">Show</button>
          <button
            type="button"
            className="pl-iconbtn"
            onClick={() => locate()}
            aria-label="Use my location"
            title="Use my location"
          >
            <Icon name="pin" size={13} />
          </button>
        </form>
        {error && (
          <div className="wx-error" role="alert">{error}</div>
        )}
      </div>
    )
  }

  // ready — a single compact summary row (emoji + temp + a flexible text
  // column that absorbs slack), then the expand + change-location buttons
  // pinned right. Expanding reveals the hourly strip below, growing the card.
  return (
    <div className={`pl-card wx-card${expanded ? ' expanded' : ''}`}>
      <div className="wx-summary">
        <span style={{ fontSize: 26, lineHeight: 1 }} aria-hidden>{strip!.emoji}</span>
        <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--ink)' }}>{strip!.temp}</span>
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 13.5, color: 'var(--ink)' }}>{strip!.label}</span>
          <span
            className="meta"
            style={{ color: 'var(--ink-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            H {strip!.high} · L {strip!.low}
            {strip!.precipPct != null && strip!.precipPct > 0 ? ` · ${strip!.precipPct}% precip` : ''}
            {uv ? (
              <>
                {' · '}
                <span style={{ color: UV_TINT[uv.level] }}>UV {strip!.uvIndex} {uv.label}</span>
              </>
            ) : ''}
            {place ? ` · ${place}` : ''}
          </span>
        </span>
        {hours.length > 0 && (
          <button
            type="button"
            className="pl-iconbtn"
            style={{ marginLeft: 'auto', transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? 'Hide hourly forecast' : 'Show hourly forecast'}
            aria-expanded={expanded}
            aria-controls="wx-hourly-panel"
            title={expanded ? 'Hide hourly' : 'Show hourly'}
          >
            <Icon name="chevron" size={14} />
          </button>
        )}
        <button
          type="button"
          className="pl-iconbtn"
          style={hours.length > 0 ? undefined : { marginLeft: 'auto' }}
          onClick={() => setPhase('manual')}
          aria-label="Change weather location"
          title="Change location"
        >
          <Icon name="pin" size={13} />
        </button>
      </div>

      {expanded && hours.length > 0 && (
        <div className="wx-hourly-wrap" id="wx-hourly-panel">
          <div className="seg" role="group" aria-label="Hourly metric">
            <button type="button" className={metric === 'temp' ? 'on' : ''} aria-pressed={metric === 'temp'} onClick={() => selectMetric('temp')}>
              Temp
            </button>
            <button type="button" className={metric === 'uv' ? 'on' : ''} aria-pressed={metric === 'uv'} onClick={() => selectMetric('uv')}>
              UV
            </button>
            <button type="button" className={metric === 'conditions' ? 'on' : ''} aria-pressed={metric === 'conditions'} onClick={() => selectMetric('conditions')}>
              Conditions
            </button>
          </div>
          <div className="wx-hourly">
            {hours.map((h) => {
              const cat = metric === 'uv' ? uvCategory(h.uv) : null
              return (
                <div className="wx-hour" key={h.iso}>
                  <span className="h">{h.hourLabel}</span>
                  {metric === 'temp' && <span className="v">{h.temp}</span>}
                  {metric === 'uv' && (
                    <span className="v" style={cat ? { color: UV_TINT[cat.level] } : undefined}>
                      {h.uv ?? '—'}
                    </span>
                  )}
                  {metric === 'conditions' && (
                    <span className="v" aria-label={h.label} title={h.label} style={{ fontSize: 18 }}>
                      {h.emoji}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
