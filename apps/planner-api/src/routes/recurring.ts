import { Hono } from 'hono'
import { calendarDateField, materializeOccurrences } from '@rallypoint/lists-shared'
import { eventTimezoneField } from '@rallypoint/events-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { proxyLists } from '../lib/sdk-error.js'
import { listPersonalTaskLists } from '../lib/personal-scope.js'

// Planner Recurring Roll-up BFF (slice 12b). A read-only snapshot of every
// recurring series the actor owns, each augmented with a `next` preview of
// upcoming occurrences computed from the rule — NO DB writes, no item
// materialization. This sidesteps the 50-instance cap and gives the UI a
// forward-looking calendar view of all recurring habits in one request.
//
// Series with upcoming dates sort earliest-first; exhausted series (empty
// `next`) sink to the bottom, alphabetically by title.

export const recurringRoutes = new Hono<HonoApp>()
  .get('/api/v1/ui/recurring', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listsClient = c.var.services.listsClient

    // --- parse & validate query params (same pattern as upcoming.ts) ---
    const dateParsed = calendarDateField.safeParse(c.req.query('date'))
    if (!dateParsed.success)
      throw errors.validation({ date: 'required, must be a valid YYYY-MM-DD date' })
    const tzParsed = eventTimezoneField.safeParse(c.req.query('tz') ?? 'UTC')
    if (!tzParsed.success) throw errors.validation({ tz: 'must be a valid IANA timezone' })

    const date = dateParsed.data

    // --- fan out: fetch all personal task lists, then series per list ---
    const recurringItems = await proxyLists(async () => {
      const lists = await listPersonalTaskLists(listsClient, actor)
      const perList = await Promise.all(
        lists.map(async (list) => {
          const seriesRows = await listsClient.listSeries(list.id)
          return seriesRows.map((s) => {
            const next = materializeOccurrences(
              {
                freq: s.freq,
                interval: s.interval,
                ...(s.byDay != null ? { byDay: s.byDay } : {}),
                dtstart: s.dtstart,
                ...(s.until != null ? { until: s.until } : {}),
                ...(s.count != null ? { count: s.count } : {}),
              },
              { from: date, limit: 5 },
            )
            return {
              id: s.id,
              listId: s.listId,
              listName: list.name,
              title: s.title,
              notes: s.notes,
              freq: s.freq,
              interval: s.interval,
              byDay: s.byDay,
              dtstart: s.dtstart,
              until: s.until,
              count: s.count,
              timeOfDay: s.timeOfDay,
              priority: s.priority,
              next,
            }
          })
        }),
      )
      return perList.flat()
    })

    // --- sort: upcoming first by earliest date, exhausted last by title ---
    recurringItems.sort((a, b) => {
      const aNext = a.next[0]
      const bNext = b.next[0]
      if (aNext && bNext) return aNext < bNext ? -1 : aNext > bNext ? 1 : 0
      if (aNext) return -1
      if (bNext) return 1
      return a.title.localeCompare(b.title)
    })

    return c.json({ date, recurring: recurringItems })
  })
