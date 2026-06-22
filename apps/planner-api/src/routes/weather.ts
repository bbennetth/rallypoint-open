import { Hono } from 'hono'
import { calendarDateField } from '@rallypoint/lists-shared'
import { eventTimezoneField } from '@rallypoint/events-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { applyPerUserRateLimit } from '../middleware/rate-limit.js'
import { proxyEvents } from '../lib/sdk-error.js'

// Planner Weather BFF (Phase C). Proxies the actor's local lat/lng to the
// events-api coordinate forecast (Open-Meteo) so My Day can show today's
// weather. Thin: no storage, no domain logic — the browser supplies the
// coordinates per request (geolocation), nothing is persisted. Rate-limited
// since each call hits an external provider.

export const weatherRoutes = new Hono<HonoApp>().get(
  '/api/v1/ui/my-day/weather',
  requireSession(),
  async (c) => {
    const actor = c.var.session!.userId
    await applyPerUserRateLimit(c, {
      userId: actor,
      route: 'my-day-weather',
      limit: 30,
      windowSeconds: 60,
    })

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
    const tzParsed = eventTimezoneField.safeParse(c.req.query('tz') ?? 'UTC')
    if (!tzParsed.success) throw errors.validation({ tz: 'must be a valid IANA timezone' })
    const rawDate = c.req.query('date')
    let date: string | undefined
    if (rawDate) {
      const dateParsed = calendarDateField.safeParse(rawDate)
      if (!dateParsed.success) throw errors.validation({ date: 'must be a valid YYYY-MM-DD date' })
      date = dateParsed.data
    }

    const forecast = await proxyEvents(() =>
      c.var.services.eventsClient.getForecast({
        lat,
        lng,
        tz: tzParsed.data,
        ...(date ? { date } : {}),
      }),
    )
    return c.json(forecast)
  },
)
