import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  ApiError,
  getPublicEvent,
  getPublicEventLineup,
  getPublicEventSessions,
  getPublicEventWeather,
  type PublicEventDto,
  type PublicEventSection,
  type PublicLineupDto,
  type PublicSessionDto,
  type WeatherDto,
} from '../lib/api.js'

// Read-only public event landing page (design §11). Cookieless fetch;
// the section list comes from the SDK response and each section
// renders its own sub-fetch, so a lineup outage doesn't break the
// sessions section and vice versa. Theme applies as a CSS variable
// override on the page root.

type PageState =
  | { status: 'loading' }
  | { status: 'ready'; event: PublicEventDto }
  | { status: 'hidden' }
  | { status: 'error'; message: string }

export function PublicEventPage() {
  const { slug } = useParams<{ slug: string }>()
  const [state, setState] = useState<PageState>({ status: 'loading' })

  useEffect(() => {
    if (!slug) {
      setState({ status: 'hidden' })
      return
    }
    let active = true
    setState({ status: 'loading' })
    getPublicEvent(slug)
      .then((event) => {
        if (active) setState({ status: 'ready', event })
      })
      .catch((err: unknown) => {
        if (!active) return
        if (err instanceof ApiError && err.status === 404) {
          setState({ status: 'hidden' })
          return
        }
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Unknown error.',
        })
      })
    return () => {
      active = false
    }
  }, [slug])

  if (state.status === 'loading') {
    return (
      <main className="page-pad flex items-center justify-center">
        <p className="text-white/60 text-sm">Loading…</p>
      </main>
    )
  }

  if (state.status === 'hidden') {
    return (
      <main className="page-pad flex items-center justify-center">
        <div className="max-w-md w-full text-center space-y-2">
          <p className="text-xs font-medium text-[color:var(--ink-mute)]">404</p>
          <h1 className="display text-2xl">This page isn't available</h1>
          <p className="text-sm text-white/60">
            The event may be private, the link may be wrong, or the owner may have
            turned the public page off.
          </p>
        </div>
      </main>
    )
  }

  if (state.status === 'error') {
    return (
      <main className="page-pad flex items-center justify-center">
        <div className="max-w-md w-full text-center space-y-2">
          <h1 className="display text-2xl">Something went wrong</h1>
          <p className="text-sm text-white/60">{state.message}</p>
        </div>
      </main>
    )
  }

  return <PublicEventBody event={state.event} />
}

function PublicEventBody({ event }: { event: PublicEventDto }) {
  const accent = event.theme.accentColor ?? '#0a0a0a'
  const bg = event.theme.backgroundImageUrl

  return (
    <main
      className="page-pad relative isolate"
      style={
        {
          ['--accent' as unknown as 'color']: accent,
        } as React.CSSProperties
      }
    >
      {bg && (
        <div
          aria-hidden
          className="fixed inset-0 -z-10 pointer-events-none"
          style={{
            backgroundImage: `url('${bg}')`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            opacity: 0.12,
          }}
        />
      )}

      <div className="max-w-2xl mx-auto space-y-8">
        <header className="space-y-2">
          <p className="text-xs font-medium" style={{ color: accent }}>
            Public event
          </p>
          <h1 className="display text-3xl">{event.name}</h1>
          {(event.startDate || event.endDate) && (
            <p className="text-sm text-white/70">
              {formatDateRange(event.startDate, event.endDate, event.timezone)}
            </p>
          )}
          {event.locationLabel && (
            <p className="text-sm text-white/70">{event.locationLabel}</p>
          )}
        </header>

        {event.sections.length === 0 && event.description && (
          <DescriptionSection text={event.description} />
        )}

        <div className="space-y-6">
          {event.sections.map((section, idx) => (
            <SectionRenderer
              key={`${section.kind}-${idx}`}
              section={section}
              event={event}
            />
          ))}

          {/* Slice 12: auto-show weather + air quality when the event
              has coordinates and falls inside the refresh window. The
              section fetches its own data; an empty/null response
              renders nothing. */}
          <WeatherSection fetcher={() => getPublicEventWeather(event.slug)} />
        </div>

        <footer className="pt-6 border-t border-white/10 text-xs text-white/40">
          Powered by Rallypoint Events ·{' '}
          <a className="underline hover:text-white/60" href="/">
            Create your own event
          </a>
        </footer>
      </div>
    </main>
  )
}

function SectionRenderer({
  section,
  event,
}: {
  section: PublicEventSection
  event: PublicEventDto
}) {
  switch (section.kind) {
    case 'description':
      return event.description ? <DescriptionSection text={event.description} /> : null
    case 'lineup':
      return <LineupSection slug={event.slug} limitToTier={section.limitToTier ?? null} />
    case 'sessions':
      return <SessionsSection slug={event.slug} dayId={section.dayId ?? null} />
    case 'map':
      return <MapSection imageUrl={section.imageUrl ?? null} layer={section.layer ?? null} />
    case 'rsvp_link':
      return <RsvpLinkSection url={section.url ?? '#'} />
    default:
      return null
  }
}

function DescriptionSection({ text }: { text: string }) {
  return (
    <section className="p-4" style={{ border: '1.5px solid var(--line)' }}>
      <h2 className="text-xs font-medium mb-2" style={{ color: 'var(--accent)' }}>
        About
      </h2>
      <p className="text-sm text-white/80 whitespace-pre-line leading-relaxed">{text}</p>
    </section>
  )
}

type LineupState =
  | { status: 'loading' }
  | { status: 'ready'; data: PublicLineupDto }
  | { status: 'error' }

function LineupSection({
  slug,
  limitToTier,
}: {
  slug: string
  limitToTier: 'headliner' | 'support' | null
}) {
  const [state, setState] = useState<LineupState>({ status: 'loading' })

  useEffect(() => {
    let active = true
    setState({ status: 'loading' })
    getPublicEventLineup(slug)
      .then((data) => {
        if (active) setState({ status: 'ready', data })
      })
      .catch(() => {
        if (active) setState({ status: 'error' })
      })
    return () => {
      active = false
    }
  }, [slug])

  return (
    <section className="p-4 space-y-3" style={{ border: '1.5px solid var(--line)' }}>
      <h2 className="text-xs font-medium" style={{ color: 'var(--accent)' }}>
        Lineup
      </h2>
      {state.status === 'loading' && <p className="text-sm text-white/60">Loading lineup…</p>}
      {state.status === 'error' && (
        <p className="text-sm text-white/60">Lineup is unavailable right now.</p>
      )}
      {state.status === 'ready' && (
        <LineupBody data={state.data} limitToTier={limitToTier} />
      )}
    </section>
  )
}

function LineupBody({
  data,
  limitToTier,
}: {
  data: PublicLineupDto
  limitToTier: 'headliner' | 'support' | null
}) {
  const artistById = new Map(data.artists.map((a) => [a.id, a]))
  const filtered = limitToTier
    ? data.eventArtists.filter((ea) => ea.tier === limitToTier)
    : data.eventArtists
  if (filtered.length === 0) {
    return <p className="text-sm text-white/60">No artists announced yet.</p>
  }
  // Group by day for readability.
  const byDay = new Map<string, typeof filtered>()
  for (const ea of filtered) {
    const list = byDay.get(ea.dayId) ?? []
    list.push(ea)
    byDay.set(ea.dayId, list)
  }
  const orderedDays = data.days.slice().sort((a, b) => a.sortOrder - b.sortOrder)
  return (
    <div className="space-y-3">
      {orderedDays.map((day) => {
        const rows = byDay.get(day.id) ?? []
        if (rows.length === 0) return null
        return (
          <div key={day.id}>
            <p className="text-[10px] font-medium text-[color:var(--ink-mute)]">
              {day.dayLabel} · {day.date}
            </p>
            <ul className="mt-1 grid gap-1">
              {rows
                .slice()
                .sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''))
                .map((ea) => {
                  const a = artistById.get(ea.artistId)
                  return (
                    <li
                      key={`${ea.artistId}-${ea.dayId}`}
                      className="flex items-baseline justify-between gap-3 text-sm"
                    >
                      <span className="text-white/85">{ea.displayName ?? a?.name ?? '—'}</span>
                      {ea.startTime && (
                        <span className="text-[10px] font-medium text-[color:var(--ink-mute)]">
                          {ea.startTime.slice(0, 5)}
                        </span>
                      )}
                    </li>
                  )
                })}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

type SessionsState =
  | { status: 'loading' }
  | { status: 'ready'; items: PublicSessionDto[] }
  | { status: 'error' }

function SessionsSection({ slug, dayId }: { slug: string; dayId: string | null }) {
  const [state, setState] = useState<SessionsState>({ status: 'loading' })

  useEffect(() => {
    let active = true
    setState({ status: 'loading' })
    getPublicEventSessions(slug, dayId ? { dayId } : undefined)
      .then((items) => {
        if (active) setState({ status: 'ready', items })
      })
      .catch(() => {
        if (active) setState({ status: 'error' })
      })
    return () => {
      active = false
    }
  }, [slug, dayId])

  return (
    <section className="p-4 space-y-2" style={{ border: '1.5px solid var(--line)' }}>
      <h2 className="text-xs font-medium" style={{ color: 'var(--accent)' }}>
        Sessions
      </h2>
      {state.status === 'loading' && <p className="text-sm text-white/60">Loading sessions…</p>}
      {state.status === 'error' && (
        <p className="text-sm text-white/60">Sessions are unavailable right now.</p>
      )}
      {state.status === 'ready' && state.items.length === 0 && (
        <p className="text-sm text-white/60">No sessions announced yet.</p>
      )}
      {state.status === 'ready' && state.items.length > 0 && (
        <ul className="divide-y divide-white/10">
          {state.items.map((s) => (
            <li key={s.id} className="py-2 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-white/85">{s.title}</span>
                {s.startTime && (
                  <span className="text-[10px] font-medium text-[color:var(--ink-mute)]">
                    {s.startTime.slice(0, 5)}
                  </span>
                )}
              </div>
              {(s.location || s.host) && (
                <p className="text-xs text-white/50">
                  {[s.location, s.host].filter(Boolean).join(' · ')}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function MapSection({ imageUrl, layer }: { imageUrl: string | null; layer: string | null }) {
  return (
    <section className="p-4 space-y-2" style={{ border: '1.5px solid var(--line)' }}>
      <h2 className="text-xs font-medium" style={{ color: 'var(--accent)' }}>
        Map {layer ? `· ${layer}` : ''}
      </h2>
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={`Event map${layer ? ` (${layer})` : ''}`}
          className="w-full h-auto"
          style={{ border: '1px solid var(--line)' }}
        />
      ) : (
        <p className="text-sm text-white/60">Map is unavailable right now.</p>
      )}
    </section>
  )
}

function RsvpLinkSection({ url }: { url: string }) {
  return (
    <section className="p-4" style={{ border: '1.5px solid var(--line)' }}>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="btn-brutal inline-block"
        style={{ borderColor: 'var(--accent)' }}
      >
        RSVP / register →
      </a>
    </section>
  )
}

function formatDateRange(start: string | null, end: string | null, _tz: string): string {
  if (start && end && start !== end) {
    return `${start} → ${end}`
  }
  if (start) return start
  if (end) return end
  return ''
}

// --- weather + air quality (slice 12) -----------------------------
// Shared component used by both PublicEventPage and (re-exported)
// EventDetailPage. The fetcher closure lets the same component drive
// either /api/v1/ui/events/:id/weather (authed) or
// /api/v1/sdk/events/:slug/weather (public).

type WeatherState =
  | { status: 'loading' }
  | { status: 'ready'; weather: WeatherDto }
  | { status: 'hidden' }

export function WeatherSection({ fetcher }: { fetcher: () => Promise<WeatherDto> }) {
  const [state, setState] = useState<WeatherState>({ status: 'loading' })

  useEffect(() => {
    let active = true
    setState({ status: 'loading' })
    fetcher()
      .then((weather) => {
        if (!active) return
        // The route returns 200 with null fields when the event has
        // no coordinates / is outside the window. Suppress the
        // whole section in that case.
        if (!weather.forecast && !weather.airQuality) {
          setState({ status: 'hidden' })
          return
        }
        setState({ status: 'ready', weather })
      })
      .catch(() => {
        if (active) setState({ status: 'hidden' })
      })
    return () => {
      active = false
    }
  }, [fetcher])

  if (state.status === 'loading') {
    return (
      <section className="p-4" style={{ border: '1.5px solid var(--line)' }}>
        <h2
          className="text-xs font-medium"
          style={{ color: 'var(--accent)' }}
        >
          Weather
        </h2>
        <p className="text-sm text-white/60 mt-2">Loading forecast…</p>
      </section>
    )
  }

  if (state.status === 'hidden') return null

  const { forecast, airQuality } = state.weather
  return (
    <section className="p-4 space-y-4" style={{ border: '1.5px solid var(--line)' }}>
      <div className="flex items-baseline justify-between gap-3">
        <h2
          className="text-xs font-medium"
          style={{ color: 'var(--accent)' }}
        >
          Weather
        </h2>
        {state.weather.isStale && (
          <span className="text-[10px] font-medium text-[color:var(--ink-mute)]">
            updating…
          </span>
        )}
      </div>

      {forecast?.current && (
        <p className="text-sm text-white/80">
          {formatTemp(forecast.current.temperature)}{' '}
          {forecast.current.apparentTemperature !== null && (
            <span className="text-white/50">
              (feels {formatTemp(forecast.current.apparentTemperature)})
            </span>
          )}
          {forecast.current.windSpeed !== null && (
            <span className="text-white/50">
              {' '}
              · wind {Math.round(forecast.current.windSpeed)} km/h
            </span>
          )}
        </p>
      )}

      {forecast && forecast.daily.length > 0 && (
        <ul className="grid gap-1 text-sm">
          {forecast.daily.slice(0, 7).map((day) => (
            <li
              key={day.date}
              className="grid grid-cols-[80px_1fr_auto] items-baseline gap-3"
            >
              <span className="text-[10px] font-medium text-[color:var(--ink-mute)]">
                {day.date}
              </span>
              <span className="text-white/80">
                {day.temperatureMin !== null && day.temperatureMax !== null
                  ? `${Math.round(day.temperatureMin)}° / ${Math.round(day.temperatureMax)}°`
                  : '—'}
                {day.precipitationProbabilityMax !== null && (
                  <span className="text-white/50">
                    {' '}
                    · {Math.round(day.precipitationProbabilityMax)}% precip
                  </span>
                )}
                {day.uvIndexMax !== null && (
                  <span className="text-white/50"> · UV {Math.round(day.uvIndexMax)}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {airQuality?.current && (
        <p className="text-xs text-white/70">
          Air quality:{' '}
          {airQuality.current.usAqi !== null
            ? `US AQI ${airQuality.current.usAqi} (${describeAqi(airQuality.current.usAqi)})`
            : 'unknown'}
          {airQuality.current.dust !== null && airQuality.current.dust > 50 && (
            <span className="text-white/50"> · dust elevated</span>
          )}
        </p>
      )}

      <p className="text-[10px] font-medium text-[color:var(--ink-mute)]">
        Forecast by Open-Meteo
      </p>
    </section>
  )
}

function formatTemp(c: number | null): string {
  if (c === null) return '—'
  return `${Math.round(c)} °C`
}

function describeAqi(aqi: number): string {
  if (aqi <= 50) return 'good'
  if (aqi <= 100) return 'moderate'
  if (aqi <= 150) return 'unhealthy for sensitive groups'
  if (aqi <= 200) return 'unhealthy'
  if (aqi <= 300) return 'very unhealthy'
  return 'hazardous'
}
