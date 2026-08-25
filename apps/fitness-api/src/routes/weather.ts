import { Hono } from 'hono'
import { TENANT_DEFAULT } from '@rallypoint/shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'

// Coordinate weather forecast for the workout logger (running weather
// snapshots). Mirrors planner-api's My Day weather proxy: the browser
// supplies its geolocation per request, the events-api Open-Meteo
// pipeline answers, nothing is persisted here — the CLIENT stamps the
// snapshot onto the workout payload it saves. Session-gated (mounted
// behind build-app's session wall) + per-user rate limited since every
// call ultimately hits an external provider.

const RATE_LIMIT = { limit: 30, windowSeconds: 60 }

export const weatherRoutes = new Hono<HonoApp>().get('/api/v1/ui/weather', async (c) => {
  const userId = c.var.session!.userId

  const bucketKey = `user:${userId}:weather`
  const decision = await c.var.repos.rateLimit.takeToken({
    tenantId: TENANT_DEFAULT,
    bucketKey,
    limit: RATE_LIMIT.limit,
    windowSeconds: RATE_LIMIT.windowSeconds,
  })
  if (!decision.allowed) {
    c.header('Retry-After', String(decision.retryAfterSeconds))
    throw errors.rateLimited(decision.retryAfterSeconds, 'user:weather')
  }

  const weather = c.var.services.weather
  if (!weather) {
    throw errors.upstreamUnavailable('Weather service unavailable.')
  }

  const lat = Number(c.req.query('lat'))
  const lng = Number(c.req.query('lng'))
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    throw errors.validation({ latlng: 'lat (-90..90) and lng (-180..180) are required.' })
  }
  const tz = c.req.query('tz')
  const date = c.req.query('date')

  // tz/date validation is delegated to events-api's RPC core (single
  // source of truth); its discriminated errors map back to 400s here.
  const result = await weather.getForecast({
    lat,
    lng,
    ...(tz ? { tz } : {}),
    ...(date ? { date } : {}),
  })
  if (result.kind === 'bad_latlng') {
    throw errors.validation({ latlng: 'lat/lng out of range.' })
  }
  if (result.kind === 'bad_tz') throw errors.validation({ tz: 'must be a valid IANA timezone' })
  if (result.kind === 'bad_date') {
    throw errors.validation({ date: 'must be a valid YYYY-MM-DD date' })
  }
  return c.json(result.data)
})
