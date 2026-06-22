import { Hono } from 'hono'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'

// Planner BFF for US federal holidays (#548).
// GET /api/v1/ui/holidays?from=YYYY-MM-DD&to=YYYY-MM-DD
// Session-gated; applies the user's holiday settings:
//   - holidaysEnabled (absent = true): master kill-switch
//   - hiddenHolidays: string[] of ids to filter out
//
// The actual holiday computation lives in events-api (sdk route); this BFF
// proxies through eventsClient.listHolidays() and applies the user's prefs.

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

function isValidYmd(s: string): boolean {
  if (!YMD_RE.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y!, m! - 1, d!)
  return dt.getFullYear() === y && dt.getMonth() + 1 === m && dt.getDate() === d
}

export const holidaysRoutes = new Hono<HonoApp>()
  .get('/api/v1/ui/holidays', requireSession(), async (c) => {
    const from = c.req.query('from')
    const to = c.req.query('to')

    if (!from || !to) {
      throw errors.validation({ params: '`from` and `to` query params are required (YYYY-MM-DD)' })
    }
    if (!isValidYmd(from)) {
      throw errors.validation({ from: 'must be a valid YYYY-MM-DD date' })
    }
    if (!isValidYmd(to)) {
      throw errors.validation({ to: 'must be a valid YYYY-MM-DD date' })
    }
    if (from > to) {
      throw errors.validation({ range: '`from` must be on or before `to`' })
    }

    const userId = c.var.session!.userId
    const settings = await c.var.services.settings.get(userId, 'planner')

    // Master kill-switch: holidaysEnabled absent → true (on by default).
    if (settings.holidaysEnabled === false) {
      return c.json({ holidays: [] })
    }

    const hidden = Array.isArray(settings.hiddenHolidays)
      ? (settings.hiddenHolidays as unknown[]).filter((x): x is string => typeof x === 'string')
      : []

    const all = await c.var.services.eventsClient.listHolidays({ from, to })
    const visible = hidden.length > 0 ? all.filter((h) => !hidden.includes(h.id)) : all

    return c.json({ holidays: visible })
  })
