import { Hono } from 'hono'
import { expandHolidays } from '@rallypoint/events-shared'
import type { HonoApp } from '../context.js'

// Public (SDK-key-gated) holiday expansion surface.
// GET /api/v1/sdk/holidays?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns the US federal holidays whose observedDate falls in [from, to].
// Window capped at 3 years. No DB dependency — pure computation.
//
// Auth is applied in build-app.ts via requireSdkKey on this path.

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

function isValidYmd(s: string): boolean {
  if (!YMD_RE.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y!, m! - 1, d!)
  return (
    dt.getFullYear() === y &&
    dt.getMonth() + 1 === m &&
    dt.getDate() === d
  )
}

// 3 years in days (accounting for leap years generously).
const MAX_SPAN_DAYS = 366 * 3

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = new Date(fromYmd).getTime()
  const b = new Date(toYmd).getTime()
  return Math.round((b - a) / 86_400_000)
}

export const sdkHolidaysRoutes = new Hono<HonoApp>()
  .get('/api/v1/sdk/holidays', async (c) => {
    const from = c.req.query('from')
    const to = c.req.query('to')

    if (!from || !to) {
      return c.json(
        { error: { code: 'validation_error', message: '`from` and `to` query params are required (YYYY-MM-DD).' } },
        422,
      )
    }
    if (!isValidYmd(from)) {
      return c.json(
        { error: { code: 'validation_error', message: '`from` must be a valid YYYY-MM-DD date.' } },
        422,
      )
    }
    if (!isValidYmd(to)) {
      return c.json(
        { error: { code: 'validation_error', message: '`to` must be a valid YYYY-MM-DD date.' } },
        422,
      )
    }
    if (from > to) {
      return c.json(
        { error: { code: 'validation_error', message: '`from` must be on or before `to`.' } },
        422,
      )
    }
    if (daysBetween(from, to) > MAX_SPAN_DAYS) {
      return c.json(
        { error: { code: 'validation_error', message: 'Date window may not exceed 3 years.' } },
        422,
      )
    }

    const holidays = expandHolidays(from, to)
    return c.json({ holidays })
  })
