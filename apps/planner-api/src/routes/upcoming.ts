import { Hono } from 'hono'
import { calendarDateField } from '@rallypoint/lists-shared'
import { eventTimezoneField } from '@rallypoint/events-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { applyPerUserRateLimit } from '../middleware/rate-limit.js'
import { bestEffort, proxyEvents, proxyLists } from '../lib/sdk-error.js'
import { listPersonalTaskLists } from '../lib/personal-scope.js'
import { fetchChoresFeedItems } from '../lib/chores-feed.js'
import { resolveRecurrenceDues } from '../lib/recurrence-time.js'
import { mergeSharedGroupEvents, sharedEventIdSet } from '../lib/shared-merge.js'
import { zonedDayWindow } from '../lib/day-window.js'
import { composeUpcoming } from '../lib/upcoming.js'

// Planner Upcoming BFF (slice 9). A forward-looking, date-sorted merge of the
// actor's tasks and personal events, split into `dated` (at/after the start of
// today) and `undated` (no date — the backlog). planner-api owns no storage —
// it fans out to the Lists + Events SDKs and merges with the pure
// composeUpcoming helper.
//
// Timezone: like My Day, the planner session carries no tz and event rows are
// UTC instants, so the client supplies its local `date` (YYYY-MM-DD) and IANA
// `tz`; the BFF resolves the start-of-day UTC instant that bounds the window.
// Upcoming is open-ended forward, so only the lower bound is used.

export const upcomingRoutes = new Hono<HonoApp>()
  .get('/api/v1/ui/upcoming', requireSession(), async (c) => {
    const actor = c.var.session!.userId

    // Per-user rate limit: 60 requests per minute.
    await applyPerUserRateLimit(c, { userId: actor, route: 'upcoming', limit: 60, windowSeconds: 60 })

    const { listsClient, eventsClient, settings } = c.var.services

    const dateParsed = calendarDateField.safeParse(c.req.query('date'))
    if (!dateParsed.success)
      throw errors.validation({ date: 'required, must be a valid YYYY-MM-DD date' })
    const tzParsed = eventTimezoneField.safeParse(c.req.query('tz') ?? 'UTC')
    if (!tzParsed.success) throw errors.validation({ tz: 'must be a valid IANA timezone' })

    const date = dateParsed.data
    const timezone = tzParsed.data
    const fromInstant = zonedDayWindow(date, timezone).start

    // Fan out across both SDKs for the actor, in parallel. Neither call is
    // date-filtered (listItems returns whole lists; personal events without a
    // `from` returns all), so composeUpcoming does the authoritative bucketing
    // — it floats undated items into their own box and drops past-dated ones.
    const [personalLists, choreItems, events, userEvents] = await Promise.all([
      proxyLists(async () => {
        const lists = await listPersonalTaskLists(listsClient, actor)
        const perList = await Promise.all(lists.map((l) => listsClient.listItems(l.id)))
        return { lists, items: perList.flat() }
      }),
      // Chores are additive and gated by the showChoresInFeeds setting — a
      // chores/settings hiccup degrades to [] so it never drops the actor's
      // tasks + events. Items carry their listId so the UI can badge them.
      bestEffort(() => fetchChoresFeedItems(listsClient, settings, actor), []),
      proxyEvents(() => eventsClient.listPersonalEvents({ actor })),
      // Group (festival) events are additive — degrade to [] on any hiccup so
      // an events-api failure never drops the actor's tasks + personal events.
      bestEffort(() => eventsClient.listUserEvents({ actor }), []),
    ])

    // Tasks come from the actor's personal (planner-origin) lists only —
    // RPL lists no longer flow into Planner (#531 separation).
    // Append chores items (toggle-gated; [] when off) so they appear in the
    // Upcoming feed alongside tasks. composeUpcoming stays signature-stable.
    // Recurring dues are floating local wall-clocks — resolve them into the
    // request tz so a "10:30" chore sorts + renders at 10:30 local, not the
    // raw UTC stamp (see resolveRecurrenceDues).
    const tasks = resolveRecurrenceDues([...personalLists.items, ...choreItems], timezone)

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
      composeUpcoming({ date, timezone, fromInstant, tasks, events, userEvents: mergedUserEvents, sharedEventIds }),
    )
  })
