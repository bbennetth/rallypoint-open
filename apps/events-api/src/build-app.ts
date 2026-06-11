import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { noopRealtimeBus, type RealtimeBus, type RealtimeHubNamespace } from '@rallypoint/realtime'
import { ANTI_FINGERPRINT_NOT_FOUND } from '@rallypoint/shared'
import type { Env } from './env.js'
import { buildLogger, type Logger } from './logger.js'
import type { HonoApp } from './context.js'
import type { Repos } from './repos/types.js'
import type { Services } from './services/types.js'
import { requestId } from './middleware/request-id.js'
import { accessLog } from './middleware/access-log.js'
import { errorHandler } from './middleware/error-handler.js'
import { requireAllowedOrigin } from './middleware/origin.js'
import { requireCsrf } from './middleware/csrf.js'
import { requireSession } from './middleware/session.js'
import { healthRoutes } from './routes/health.js'
import { ssoRoutes } from './routes/sso.js'
import { settingsRoutes } from './routes/settings.js'
import { eventsRoutes } from './routes/events.js'
import { attendeesRoutes } from './routes/attendees.js'
import { ticketsRoutes } from './routes/tickets.js'
import { lineupRoutes } from './routes/lineup.js'
import { sessionsRoutes } from './routes/sessions.js'
import { snapshotsRoutes } from './routes/snapshots.js'
import { mapsRoutes } from './routes/maps.js'
import { groupsRoutes } from './routes/groups.js'
import { ralliesRoutes } from './routes/rallies.js'
import { groupDayRoutes } from './routes/group-day.js'
import { chatRoutes } from './routes/chat.js'
import { realtimeRoutes } from './routes/realtime.js'
import { sdkEventsRoutes } from './routes/sdk-events.js'
import { sdkPersonalEventsRoutes } from './routes/sdk-personal-events.js'
import { sdkPersonalTicketsRoutes } from './routes/sdk-personal-tickets.js'
import { sdkUserEventsRoutes } from './routes/sdk-user-events.js'
import { publicHtmlRoutes } from './routes/public-html.js'
import { weatherRoutes } from './routes/weather.js'
import { setStarsRoutes } from './routes/set-stars.js'
import { requireSdkKey } from './middleware/app-api-key.js'
import { plannerPrefsUiRoutes, plannerPrefsSdkRoutes } from './routes/planner-prefs.js'

export interface BuildAppDeps {
  env: Env
  logger?: Logger
  // Tests inject memory/stub implementations; the Worker entrypoint
  // passes buildD1Repos(createDb(env.EVENTS_DB)). No pg default — the
  // Node server was retired in the D1 migration.
  repos: Repos
  // Tests inject memory/stub implementations; the Worker entrypoint passes
  // buildServices(env, { objectStore }). No default — requires an R2 binding.
  services: Services
  // Realtime publisher bus. Defaults to a no-op so tests and
  // realtime-disabled deploys need no wiring.
  realtime?: RealtimeBus
  // The RealtimeHub Durable Object namespace (Phase 4). Injected by the
  // Worker entrypoint / Miniflare tests; absent on builds without a DO
  // binding, where the WebSocket-upgrade route returns 503.
  hub?: RealtimeHubNamespace
}

export function buildApp(deps: BuildAppDeps): Hono<HonoApp> {
  const logger = deps.logger ?? buildLogger(deps.env)
  const repos = deps.repos
  const services = deps.services
  const realtime = deps.realtime ?? noopRealtimeBus()
  const app = new Hono<HonoApp>()

  // Conservative default headers. Slice 2 layers CSP with nonces
  // when the API starts serving authenticated UI routes; slice 1
  // doesn't render any HTML so the stock secureHeaders defaults
  // are enough.
  app.use(
    '*',
    secureHeaders({
      ...(deps.env.NODE_ENV === 'production'
        ? { strictTransportSecurity: 'max-age=31536000; includeSubDomains' }
        : {}),
    }),
  )
  app.use('*', requestId)
  app.use('*', async (c, next) => {
    c.set('env', deps.env)
    c.set('logger', logger)
    c.set('repos', repos)
    c.set('services', services)
    c.set('realtime', realtime)
    if (deps.hub) c.set('hub', deps.hub)
    await next()
  })
  app.use('*', accessLog)

  app.onError(errorHandler)

  // The UI surface (§3.13): origin allowlist + CSRF double-submit
  // front everything under /api/v1/ui/*. requireSession is applied
  // per-router below, NOT here — SSO exchange, signout, and the CSRF
  // bootstrap must be reachable without an existing events session.
  app.use('/api/v1/ui/*', requireAllowedOrigin())
  app.use('/api/v1/ui/*', requireCsrf())
  // Session is required for the events CRUD surface and invite accept,
  // but not for the SSO bootstrap routes mounted by ssoRoutes.
  app.use('/api/v1/ui/events', requireSession())
  app.use('/api/v1/ui/events/*', requireSession())
  app.use('/api/v1/ui/invites/*', requireSession())
  // Global artist catalog (slice 3) — signed-in but not event-scoped.
  app.use('/api/v1/ui/artists', requireSession())
  app.use('/api/v1/ui/artists/*', requireSession())
  // Groups (slice 6) — signed-in; event-scoped create is covered by the
  // events/* wildcard above, the rest live under /groups(/*).
  app.use('/api/v1/ui/groups', requireSession())
  app.use('/api/v1/ui/groups/*', requireSession())

  app.route('/', healthRoutes)
  app.route('/', ssoRoutes)
  app.route('/', settingsRoutes)
  // Mounted before eventsRoutes and groupsRoutes: GET .../realtime-token
  // must match the realtime route, not be captured as GET /events/:id or
  // GET /groups/:id with id="realtime-token". The WS upgrade /realtime is
  // also registered here for the same reason.
  app.route('/', realtimeRoutes)
  // Planner-pref UI routes must be mounted BEFORE eventsRoutes so that
  // GET /api/v1/ui/events/planner-prefs is not captured by eventsRoutes'
  // GET /api/v1/ui/events/:slug wildcard. The SDK routes follow
  // sdkUserEventsRoutes below, under their own requireSdkKey guards.
  app.route('/', plannerPrefsUiRoutes)
  app.route('/', eventsRoutes)
  app.route('/', attendeesRoutes)
  app.route('/', ticketsRoutes)
  app.route('/', lineupRoutes)
  app.route('/', setStarsRoutes)
  app.route('/', sessionsRoutes)
  app.route('/', snapshotsRoutes)
  app.route('/', mapsRoutes)
  app.route('/', groupsRoutes)
  // Rallies (slice 9b) — under the /api/v1/ui/groups/* session guard above.
  app.route('/', ralliesRoutes)
  // My Day aggregator (slice 9b) — same /api/v1/ui/groups/* session guard.
  app.route('/', groupDayRoutes)
  // Group chat (slice 10) — same /api/v1/ui/groups/* session guard. Paths
  // (:id/chat) are distinct deeper segments, so neither is captured by
  // GET /groups/:id.
  app.route('/', chatRoutes)

  // Slice 11 — the public surfaces. Mounted at the end so the
  // ordering reads as "internal UI first, then public", but they
  // share NO middleware with /api/v1/ui/* (no session, no CSRF, no
  // origin allowlist). Gating is content-side (public_page_config
  // + privacy_mode); see routes/sdk-events.ts and routes/public-html.ts.
  app.route('/', weatherRoutes)
  app.route('/', sdkEventsRoutes)
  app.route('/', publicHtmlRoutes)

  // Slice 2 — authenticated personal-events namespace. The key gate
  // is applied ONLY to /api/v1/sdk/personal-events (and the wildcard
  // sub-path); the public /api/v1/sdk/events/* surface is untouched.
  app.use('/api/v1/sdk/personal-events', requireSdkKey)
  app.use('/api/v1/sdk/personal-events/*', requireSdkKey)
  app.route('/', sdkPersonalEventsRoutes)
  app.route('/', sdkPersonalTicketsRoutes)

  // Authenticated read of the actor's group (festival) events — owner,
  // collaborator, or attendee. Same planner-key gate as personal-events.
  app.use('/api/v1/sdk/user-events', requireSdkKey)
  app.route('/', sdkUserEventsRoutes)

  // SDK planner-pref routes (UI routes are mounted above eventsRoutes):
  app.use('/api/v1/sdk/events/:eventId/planner-pref', requireSdkKey)
  app.use('/api/v1/sdk/planner-events', requireSdkKey)
  app.route('/', plannerPrefsSdkRoutes)

  app.notFound((c) =>
    c.json({ error: ANTI_FINGERPRINT_NOT_FOUND }, 404),
  )

  return app
}
