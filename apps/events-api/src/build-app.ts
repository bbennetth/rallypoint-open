import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { noopRealtimeBus, type RealtimeBus, type RealtimeHubNamespace } from '@rallypoint/realtime'
import { ANTI_FINGERPRINT_NOT_FOUND } from '@rallypoint/shared'
import type { Env } from './env.js'
import { buildLoggerWithFlush, type Logger } from './logger.js'
import type { HonoApp } from './context.js'
import type { Repos } from './repos/types.js'
import type { Services } from './services/types.js'
import { requestId } from './middleware/request-id.js'
import { accessLog } from './middleware/access-log.js'
import { logFlush } from './middleware/log-flush.js'
import { errorHandler } from './middleware/error-handler.js'
import { requireAllowedOrigin } from './middleware/origin.js'
import { requireCsrf } from './middleware/csrf.js'
import { requireSession } from './middleware/session.js'
import { healthRoutes } from './routes/health.js'
import { ssoRoutes } from './routes/sso.js'
import { settingsRoutes } from './routes/settings.js'
import { eventsRoutes } from './routes/events.js'
import { attendeesRoutes } from './routes/attendees.js'
import { attendanceRoutes } from './routes/attendance.js'
import { ticketsRoutes } from './routes/tickets.js'
import { lineupRoutes } from './routes/lineup.js'
import { sessionsRoutes } from './routes/sessions.js'
import { snapshotsRoutes } from './routes/snapshots.js'
import { mapsRoutes } from './routes/maps.js'
import { groupMapsRoutes } from './routes/group-maps.js'
import { memberLocationsRoutes } from './routes/member-locations.js'
import { groupsRoutes } from './routes/groups.js'
import { ralliesRoutes } from './routes/rallies.js'
import { groupDayRoutes } from './routes/group-day.js'
import { chatRoutes } from './routes/chat.js'
import { realtimeRoutes } from './routes/realtime.js'
import { sdkEventsRoutes } from './routes/sdk-events.js'
import { pwaRoutes } from './routes/pwa.js'
import { publicHtmlRoutes } from './routes/public-html.js'
import { weatherRoutes } from './routes/weather.js'
import { setStarsRoutes } from './routes/set-stars.js'
import { artistFavoritesRoutes } from './routes/artist-favorites.js'
import { plannerPrefsUiRoutes } from './routes/planner-prefs.js'
import { browseRoutes } from './routes/browse.js'

export interface BuildAppDeps {
  env: Env
  logger?: Logger
  // Drains the PostHog log-sink buffer. Passed alongside `logger` by the
  // Worker entrypoint (paired via buildLoggerWithFlush). Defaults to a
  // no-op when a bare logger is injected without one (tests).
  flushLogs?: () => Promise<void>
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
  let logger: Logger
  let flushLogs: () => Promise<void>
  if (deps.logger) {
    logger = deps.logger
    flushLogs = deps.flushLogs ?? (async () => {})
  } else {
    ;({ logger, flushLogs } = buildLoggerWithFlush(deps.env))
  }
  const repos = deps.repos
  const services = deps.services
  const realtime = deps.realtime ?? noopRealtimeBus()
  const app = new Hono<HonoApp>()

  // Outermost middleware: after every request (success or throw) drain the
  // PostHog log-sink buffer via executionCtx.waitUntil. Registered first so
  // its post-next flush runs last, after all logging including onError.
  app.use('*', logFlush(flushLogs))

  // Conservative default headers. Slice 2 layers CSP with nonces
  // when the API starts serving authenticated UI routes; slice 1
  // doesn't render any HTML so the stock secureHeaders defaults
  // are enough.
  //
  // The realtime WS-upgrade route is exempt: secureHeaders mutates
  // c.res.headers after next(), but that route returns the RealtimeHub
  // DO's response verbatim — a fetch()-produced Response with immutable
  // headers (and a 101 carrying webSocket must not be cloned), so the
  // mutation throws "Can't modify immutable headers" and 500s the
  // handshake.
  const secure = secureHeaders({
    ...(deps.env.NODE_ENV === 'production'
      ? { strictTransportSecurity: 'max-age=31536000; includeSubDomains' }
      : {}),
  })
  app.use('*', (c, next) =>
    c.req.path === '/api/v1/ui/realtime' ? next() : secure(c, next),
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
  // GET /api/v1/ui/events/:slug wildcard. The companion SDK routes were
  // retired in PR 3 of feat/rpc-bindings — planner-api reaches them via
  // the EventsRPC binding.
  app.route('/', plannerPrefsUiRoutes)
  // Per-event PWA (#per-event-install). Mounted before eventsRoutes so
  // the static `app-icon` segment can't be captured by a broader
  // /events/:slug pattern; the public manifest + icon routes it also
  // carries are content-gated on the event id, not public_page_config
  // (see routes/pwa.ts for why).
  app.route('/', pwaRoutes)
  // Browse tab (#browse-tab). Mounted before eventsRoutes so the literal
  // GET /api/v1/ui/events/browse wins over GET /api/v1/ui/events/:slug
  // (same reason as plannerPrefsUiRoutes above).
  app.route('/', browseRoutes)
  app.route('/', eventsRoutes)
  app.route('/', attendeesRoutes)
  app.route('/', attendanceRoutes)
  app.route('/', ticketsRoutes)
  app.route('/', lineupRoutes)
  app.route('/', setStarsRoutes)
  app.route('/', artistFavoritesRoutes)
  app.route('/', sessionsRoutes)
  app.route('/', snapshotsRoutes)
  app.route('/', mapsRoutes)
  // Group-scoped mirror reads of the event map surface (attendee Map
  // tab). Mounted before groupsRoutes; paths (:id/maps, :id/pois,
  // :id/zones) are distinct deeper segments, so none is captured by
  // GET /groups/:id.
  app.route('/', groupMapsRoutes)
  // Crew map pins (attendee Map tab) — same deeper-segment reasoning.
  app.route('/', memberLocationsRoutes)
  app.route('/', groupsRoutes)
  // Rallies (slice 9b) — under the /api/v1/ui/groups/* session guard above.
  app.route('/', ralliesRoutes)
  // My Day aggregator (slice 9b) — same /api/v1/ui/groups/* session guard.
  app.route('/', groupDayRoutes)
  // Group chat (slice 10) — same /api/v1/ui/groups/* session guard. Paths
  // (:id/chat) are distinct deeper segments, so neither is captured by
  // GET /groups/:id.
  app.route('/', chatRoutes)

  // Public surfaces — share NO middleware with /api/v1/ui/* (no session,
  // no CSRF, no origin allowlist). Gating is content-side
  // (public_page_config + privacy_mode); see routes/sdk-events.ts and
  // routes/public-html.ts. The PLANNER_API_KEY-gated `/api/v1/sdk/*`
  // surfaces (personal-events, user-events, planner-prefs, holidays,
  // weather coordinate forecast) were retired in PR 3 of
  // feat/rpc-bindings — consumers now reach those handlers through the
  // `EventsRPC` `WorkerEntrypoint` binding.
  app.route('/', weatherRoutes)
  app.route('/', sdkEventsRoutes)
  app.route('/', publicHtmlRoutes)

  app.notFound((c) =>
    c.json({ error: ANTI_FINGERPRINT_NOT_FOUND }, 404),
  )

  return app
}
