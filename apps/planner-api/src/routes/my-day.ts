import { Hono } from 'hono'
import { calendarDateField } from '@rallypoint/lists-shared'
import { eventTimezoneField } from '@rallypoint/events-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { applyPerUserRateLimit } from '../middleware/rate-limit.js'
import { bestEffort, proxyEvents, proxyLists } from '../lib/sdk-error.js'
import { listPersonalTaskLists } from '../lib/personal-scope.js'
import { mergeSharedGroupEvents, sharedEventIdSet } from '../lib/shared-merge.js'
import { zonedDayWindow } from '../lib/day-window.js'
import { composeMyDay } from '../lib/my-day.js'

// Planner My Day BFF (slice 8). A roll-up of the actor's tasks due today and
// personal events starting today, resolved in the user's timezone. planner-api
// owns no storage — it fans out to the Lists + Events SDKs and merges the
// results with the pure composeMyDay helper.
//
// Timezone: the planner session carries no tz and event rows are stored as UTC
// instants, so the client supplies its local `date` (YYYY-MM-DD) and IANA `tz`
// (its browser zone); the BFF resolves them into the UTC window [start, end)
// that both the task due-date filter and the event start_at window share.

export const myDayRoutes = new Hono<HonoApp>()
  .get('/api/v1/ui/my-day', requireSession(), async (c) => {
    const actor = c.var.session!.userId

    // Per-user rate limit: 60 requests per minute.
    await applyPerUserRateLimit(c, { userId: actor, route: 'my-day', limit: 60, windowSeconds: 60 })

    const { listsClient, eventsClient } = c.var.services

    const dateParsed = calendarDateField.safeParse(c.req.query('date'))
    if (!dateParsed.success)
      throw errors.validation({ date: 'required, must be a valid YYYY-MM-DD date' })
    const tzParsed = eventTimezoneField.safeParse(c.req.query('tz') ?? 'UTC')
    if (!tzParsed.success) throw errors.validation({ tz: 'must be a valid IANA timezone' })

    const date = dateParsed.data
    const timezone = tzParsed.data
    const window = zonedDayWindow(date, timezone)

    // Fan out across both SDKs for the actor, in parallel (they're
    // independent). Tasks have no server-side date filter (listItems returns a
    // whole list), so composeMyDay does the authoritative [start, end)
    // filtering for both; the events from/to is a payload optimisation only.
    const [personalLists, events, userEvents] = await Promise.all([
      proxyLists(async () => {
        const lists = await listPersonalTaskLists(listsClient, actor)
        const perList = await Promise.all(lists.map((l) => listsClient.listItems(l.id)))
        return { lists, items: perList.flat() }
      }),
      proxyEvents(() =>
        eventsClient.listPersonalEvents({ actor, from: window.start, to: window.end }),
      ),
      // Group (festival) events are additive — degrade to [] on any hiccup so
      // an events-api failure never drops the actor's tasks + personal events.
      bestEffort(() => eventsClient.listUserEvents({ actor }), []),
    ])

    // Tasks come from the actor's personal (planner-origin) lists only —
    // RPL lists no longer flow into Planner (#531 separation).
    const tasks = personalLists.items

    // Planner-flagged group events: best-effort so an events-api hiccup never
    // drops the actor's own events. Merge with already-reachable events, dedup
    // by eventId (reachable wins). Mark flagged-only events shared:true.
    const flaggedGroupEvents = await bestEffort(
      () => eventsClient.listPlannerGroupEvents({ actor }),
      [],
    )
    const reachableEventIds = userEvents.map((e) => e.eventId)
    const mergedUserEvents = mergeSharedGroupEvents(userEvents, flaggedGroupEvents)
    const sharedEventIds = [...sharedEventIdSet(flaggedGroupEvents.map((e) => e.eventId), reachableEventIds)]

    return c.json(
      composeMyDay({ date, timezone, window, tasks, events, userEvents: mergedUserEvents, sharedEventIds }),
    )
  })
