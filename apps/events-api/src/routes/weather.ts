import { Hono } from 'hono'
import type { Context } from 'hono'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import {
  PublicPageConfigSchema,
  type PublicPageConfig,
} from '@rallypoint/events-shared'
import type { EventRecord, EventWeatherRecord } from '../repos/types.js'
import type {
  AirQualityDto,
  WeatherForecastDto,
  WeatherProviderInput,
} from '../services/weather/types.js'
import { loadForAction } from './_access.js'

// Weather endpoints (slice 12). Two surfaces:
//   - GET /api/v1/ui/events/:id/weather (member+) for the authenticated
//     detail page.
//   - GET /api/v1/sdk/events/:slug/weather (public, cookieless) for
//     the public event page. Same gating as routes/sdk-events.ts:
//     enabled === true AND privacy_mode !== 'private'.
//
// Both paths use the shared `getOrRefreshWeather` helper: it reads
// the cached row, kicks a synchronous fetch when the row is missing
// or stale, and on a fresh-but-not-too-fresh read fires a background
// refresh so the next viewer gets fresh data without waiting.

const TENANT = 'rallypoint'

const CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300'

interface WeatherDto {
  forecast: WeatherForecastDto | null
  airQuality: AirQualityDto | null
  fetchedAt: string
  // True when we tried to refresh and failed; the response still
  // carries the last good cached values.
  errorCode: string | null
  isStale: boolean
}

// How far in the past or future an event can be and still qualify for
// auto-refresh. Outside this window we don't waste an API call —
// weather forecasts beyond ~14 days are noise.
const FORECAST_WINDOW_PAST_MS = 7 * 24 * 60 * 60 * 1000
const FORECAST_WINDOW_FUTURE_MS = 14 * 24 * 60 * 60 * 1000

// True if `event` has coordinates AND its start/end date range
// overlaps the refresh window relative to `now`.
export function isWeatherEligible(event: EventRecord, now: Date = new Date()): boolean {
  if (event.locationLat === null || event.locationLng === null) return false
  const nowMs = now.getTime()
  const startMs = event.startDate ? new Date(event.startDate).getTime() : nowMs
  const endMs = event.endDate ? new Date(event.endDate).getTime() : startMs
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return false
  // End is in the past beyond the past window?
  if (endMs < nowMs - FORECAST_WINDOW_PAST_MS) return false
  // Start is too far in the future?
  if (startMs > nowMs + FORECAST_WINDOW_FUTURE_MS) return false
  return true
}

function eventToProviderInput(event: EventRecord, freshness: number): {
  input: WeatherProviderInput
  windowStart: string
  windowEnd: string
} | null {
  if (event.locationLat === null || event.locationLng === null) return null
  void freshness
  const today = new Date()
  const isoDay = (d: Date) => d.toISOString().slice(0, 10)
  const start = event.startDate ?? isoDay(today)
  const end =
    event.endDate ??
    (event.startDate
      ? event.startDate
      : isoDay(new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000)))
  return {
    input: {
      lat: Number(event.locationLat),
      lng: Number(event.locationLng),
      startDate: start,
      endDate: end,
      timezone: event.timezone,
    },
    windowStart: start,
    windowEnd: end,
  }
}

// Core read-and-refresh. Returns the cached row + a boolean indicating
// whether the response was a stale read. Schedules a background
// refresh on stale reads via setImmediate so the request completes
// without waiting; the next request picks up the fresh value.
export async function getOrRefreshWeather(
  c: Context<HonoApp>,
  event: EventRecord,
): Promise<WeatherDto | null> {
  if (!isWeatherEligible(event)) return null
  const freshnessMs = c.var.env.EVENTS_WEATHER_FRESHNESS_MS
  const existing = await c.var.repos.eventWeather.findByEventId(event.id)
  const now = Date.now()
  const isFresh =
    existing !== null && now - existing.fetchedAt.getTime() < freshnessMs
  if (isFresh) {
    return rowToDto(existing, /* isStale */ false)
  }
  // Cache miss or stale. If there's a stale row, return it now and
  // refresh in the background. If there's nothing, do a synchronous
  // refresh so the caller has something to render.
  if (existing) {
    scheduleBackgroundRefresh(c, event)
    return rowToDto(existing, /* isStale */ true)
  }
  await refreshWeatherForEvent(c, event).catch((err: unknown) => {
    c.var.logger.warn(
      { err: err instanceof Error ? err.message : String(err), event_id: event.id },
      'weather: synchronous refresh failed',
    )
  })
  const after = await c.var.repos.eventWeather.findByEventId(event.id)
  return after ? rowToDto(after, /* isStale */ after.errorCode !== null) : null
}

function rowToDto(row: EventWeatherRecord, isStale: boolean): WeatherDto {
  return {
    forecast: (row.forecast as WeatherForecastDto | null) ?? null,
    airQuality: (row.airQuality as AirQualityDto | null) ?? null,
    fetchedAt: row.fetchedAt.toISOString(),
    errorCode: row.errorCode,
    isStale,
  }
}

function scheduleBackgroundRefresh(c: Context<HonoApp>, event: EventRecord): void {
  setImmediate(() => {
    void refreshWeatherForEvent(c, event).catch((err: unknown) => {
      c.var.logger.warn(
        { err: err instanceof Error ? err.message : String(err), event_id: event.id },
        'weather: background refresh failed',
      )
    })
  })
}

// Calls the provider, persists the result. Exposed for the refresher
// (apps/events-api/src/weather-refresher.ts) too.
export async function refreshWeatherForEvent(
  c: Context<HonoApp>,
  event: EventRecord,
): Promise<void> {
  const params = eventToProviderInput(event, c.var.env.EVENTS_WEATHER_FRESHNESS_MS)
  if (!params) return
  try {
    const result = await c.var.services.weather.getEventWeather(params.input)
    await c.var.repos.eventWeather.upsert({
      eventId: event.id,
      forecast: result.forecast,
      airQuality: result.airQuality,
      fetchedLat: String(params.input.lat),
      fetchedLng: String(params.input.lng),
    })
  } catch (err) {
    c.var.logger.warn(
      { err: err instanceof Error ? err.message : String(err), event_id: event.id },
      'weather: provider call failed; cache last error',
    )
    await c.var.repos.eventWeather.markError(
      event.id,
      err instanceof Error ? err.name : 'unknown_error',
      new Date(),
    )
  }
}

// Same gate as routes/sdk-events.ts. Inlined to keep the public route
// self-contained and avoid pulling helpers across modules.
function gatePublic(event: EventRecord | null): PublicPageConfig {
  if (!event || event.deletedAt) throw errors.eventNotFound()
  if (event.privacyMode === 'private') throw errors.eventNotFound()
  const parsed = PublicPageConfigSchema.safeParse(event.publicPageConfig)
  if (!parsed.success || !parsed.data.enabled) throw errors.eventNotFound()
  return parsed.data
}

export const weatherRoutes = new Hono<HonoApp>()
  // --- internal UI: member+ on the authenticated detail page --------
  .get('/api/v1/ui/events/:id/weather', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'viewer')
    const dto = await getOrRefreshWeather(c, event)
    if (!dto) {
      // The event has no usable coordinates or sits outside the
      // refresh window. Return 200 with an empty payload so the
      // client renders nothing instead of an error.
      return c.json({ forecast: null, airQuality: null, fetchedAt: null, errorCode: null, isStale: false })
    }
    return c.json(dto)
  })

  // --- public SDK: cookieless, gated by enabled + privacy_mode ------
  .get('/api/v1/sdk/events/:slug/weather', async (c) => {
    const event = await c.var.repos.events.findBySlug(TENANT, c.req.param('slug'))
    gatePublic(event)
    const dto = await getOrRefreshWeather(c, event!)
    c.header('Cache-Control', CACHE_CONTROL)
    if (!dto) {
      return c.json({ forecast: null, airQuality: null, fetchedAt: null, errorCode: null, isStale: false })
    }
    return c.json(dto)
  })
