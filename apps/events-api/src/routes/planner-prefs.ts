import { Hono } from 'hono'
import { z } from 'zod'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { readJsonBody } from './_body.js'
import { loadForAction } from './_access.js'

// Per-user "show in planner" flag for a group event — UI surface only.
// The companion SDK routes (`PUT /api/v1/sdk/events/:eventId/planner-pref`
// and `GET /api/v1/sdk/planner-events`) were retired in PR 3 of
// feat/rpc-bindings; planner-api now reaches them through the
// `EventsRPC.setPlannerPref` / `EventsRPC.getPlannerEvents` binding
// methods.

const PlannerPrefSchema = z.object({ show: z.boolean() })

// Mounted before eventsRoutes in build-app.ts so
// GET /api/v1/ui/events/planner-prefs isn't captured by GET /:slug.
export const plannerPrefsUiRoutes = new Hono<HonoApp>()
  // List all flagged event ids for the caller. Registered FIRST so
  // "planner-prefs" literal wins over /:slug.
  .get('/api/v1/ui/events/planner-prefs', async (c) => {
    const userId = c.var.session!.userId
    const eventIds = await c.var.repos.eventPlannerPrefs.flaggedEventIdsForActor(userId)
    return c.json({ eventIds })
  })

  // Set pref for a single event (session-gated viewer+).
  .put('/api/v1/ui/events/:eventId/planner-pref', async (c) => {
    const userId = c.var.session!.userId
    const { event } = await loadForAction(c, c.req.param('eventId'), 'viewer')
    const parsed = PlannerPrefSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    await c.var.repos.eventPlannerPrefs.upsert(event.id, userId, parsed.data.show)
    return c.body(null, 204)
  })
