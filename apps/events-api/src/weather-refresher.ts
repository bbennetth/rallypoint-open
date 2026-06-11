import type { Logger } from './logger.js'
import type { Repos } from './repos/types.js'
import type { Services } from './services/types.js'
import type { EventRecord } from './repos/types.js'

// Weather pre-warmer (slice 12). Mirrors the pruner shape
// (apps/events-api/src/pruner.ts): inflight dedupe + on-demand tick. On
// Workers there is no timer — the Cron Trigger drives the cadence by
// calling `tickOnce()` from the Worker's `scheduled` handler. Walks
// events in the (-7d, +14d) window, refreshing any with stale
// `event_weather.fetched_at`.
//
// Free-tier Open-Meteo limits are generous (~10k req/day), so even
// 100 concurrent active events at a 3h refresh cadence stays well
// inside. The per-tick `maxBatch` caps the worst case if a deploy
// suddenly has 10k events in the window — better to spread the
// refresh across multiple ticks than rate-limit the provider.

export const WEATHER_REFRESH_PAST_DAYS = 7
export const WEATHER_REFRESH_FUTURE_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_BATCH_LIMIT = 50

export interface WeatherRefresherTickResult {
  inspected: number
  refreshed: number
  errored: number
  durationMs: number
}

export interface WeatherRefresherHandle {
  stop(): Promise<void>
  tickOnce(now?: Date): Promise<WeatherRefresherTickResult>
}

export interface StartWeatherRefresherArgs {
  repos: Repos
  services: Services
  logger: Logger
  freshnessMs: number
  maxBatch?: number
  now?: () => Date
}

export function startWeatherRefresher(args: StartWeatherRefresherArgs): WeatherRefresherHandle {
  const { repos, services, logger, freshnessMs } = args
  const maxBatch = args.maxBatch ?? DEFAULT_BATCH_LIMIT
  const now = args.now ?? (() => new Date())
  let stopped = false
  let inflight: Promise<WeatherRefresherTickResult> | null = null

  async function tickOnce(at?: Date): Promise<WeatherRefresherTickResult> {
    if (inflight) return inflight
    const start = Date.now()
    inflight = (async () => {
      const result: WeatherRefresherTickResult = {
        inspected: 0,
        refreshed: 0,
        errored: 0,
        durationMs: 0,
      }
      try {
        const reference = at ?? now()
        const windowStart = new Date(reference.getTime() - WEATHER_REFRESH_PAST_DAYS * DAY_MS)
        const windowEnd = new Date(reference.getTime() + WEATHER_REFRESH_FUTURE_DAYS * DAY_MS)
        const candidates = await repos.events.listForWeatherRefresh({
          windowStart,
          windowEnd,
          limit: maxBatch,
        })
        result.inspected = candidates.length
        for (const event of candidates) {
          if (stopped) break
          const cached = await repos.eventWeather.findByEventId(event.id)
          if (
            cached !== null &&
            reference.getTime() - cached.fetchedAt.getTime() < freshnessMs
          ) {
            continue
          }
          try {
            await refreshOne(event, repos, services)
            result.refreshed++
          } catch (err) {
            result.errored++
            logger.warn(
              { err: err instanceof Error ? err.message : String(err), event_id: event.id },
              'weather-refresher: provider call failed',
            )
            await repos.eventWeather.markError(
              event.id,
              err instanceof Error ? err.name : 'unknown_error',
              new Date(),
            )
          }
        }
      } finally {
        result.durationMs = Date.now() - start
        inflight = null
      }
      return result
    })()
    return inflight
  }

  return {
    // No timer to clear — the cron handler drives ticks. stop() flips the
    // in-loop guard and drains any in-flight tick.
    async stop(): Promise<void> {
      stopped = true
      if (inflight) {
        try {
          await inflight
        } catch {
          /* swallow: tick errors are logged above */
        }
      }
    },
    tickOnce,
  }
}

async function refreshOne(
  event: EventRecord,
  repos: Repos,
  services: Services,
): Promise<void> {
  if (event.locationLat === null || event.locationLng === null) return
  const today = new Date().toISOString().slice(0, 10)
  const startDate = event.startDate ?? today
  const endDate = event.endDate ?? startDate
  const result = await services.weather.getEventWeather({
    lat: Number(event.locationLat),
    lng: Number(event.locationLng),
    startDate,
    endDate,
    timezone: event.timezone,
  })
  await repos.eventWeather.upsert({
    eventId: event.id,
    forecast: result.forecast,
    airQuality: result.airQuality,
    fetchedLat: event.locationLat,
    fetchedLng: event.locationLng,
  })
}
