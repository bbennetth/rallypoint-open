import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { noopRealtimeBus, type RealtimeBus, type RealtimeHubNamespace } from '@rallypoint/realtime'
import { ANTI_FINGERPRINT_NOT_FOUND } from '@rallypoint/shared'
import type { Env } from './env.js'
import { buildLoggerWithFlush, type Logger } from './logger.js'
import type { HonoApp } from './context.js'
import type { Repos } from './repos/types.js'
import type { Services } from './services/types.js'
import { buildServices } from './services/index.js'
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
import { mcpTokensRoutes } from './routes/mcp-tokens.js'
import { listsRoutes } from './routes/lists.js'
import { listItemsRoutes } from './routes/list-items.js'
import { fieldDefsRoutes } from './routes/field-defs.js'
import { statusesRoutes } from './routes/statuses.js'
import { commentsRoutes } from './routes/comments.js'
import { labelsRoutes } from './routes/labels.js'
import { viewsRoutes } from './routes/views.js'
import { groupsRoutes } from './routes/groups.js'
import { realtimeRoutes } from './routes/realtime.js'

export interface BuildAppDeps {
  env: Env
  logger?: Logger
  // Drains the PostHog log-sink buffer. Passed alongside `logger` by the
  // Worker entrypoint (paired via buildLoggerWithFlush). Defaults to a
  // no-op when a bare logger is injected without one (tests).
  flushLogs?: () => Promise<void>
  // Tests inject memory/stub implementations; the Worker entrypoint
  // passes buildD1Repos(createDb(env.LISTS_DB)). No pg default — the
  // Node server was retired in the #313 D1 migration.
  repos: Repos
  services?: Services
  // The realtime publisher bus. server.ts owns the prod bus lifecycle
  // and injects it; tests default to a no-op (or inject a spy).
  realtime?: RealtimeBus
  // The RealtimeHub Durable Object namespace (#313, Phase 3). Injected by
  // the Worker entrypoint / Miniflare tests; absent on the Node server,
  // where the WebSocket-upgrade route returns 503.
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
  const services = deps.services ?? buildServices(deps.env)
  const realtime = deps.realtime ?? noopRealtimeBus()
  const app = new Hono<HonoApp>()

  // Outermost middleware: after every request (success or throw) drain the
  // PostHog log-sink buffer via executionCtx.waitUntil. Registered first so
  // its post-next flush runs last, after all logging including onError.
  app.use('*', logFlush(flushLogs))

  // Conservative default headers. Slice 1 serves no HTML, so the stock
  // secureHeaders defaults are enough; CSP with nonces lands when the
  // API starts rendering authenticated UI.
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

  // The UI surface (§3.13): origin allowlist + CSRF double-submit front
  // everything under /api/v1/ui/*. requireSession is applied per-router
  // below, NOT here — SSO exchange, signout, and the CSRF bootstrap
  // must be reachable without an existing lists session.
  app.use('/api/v1/ui/*', requireAllowedOrigin())
  app.use('/api/v1/ui/*', requireCsrf())
  // Session is required for the lists CRUD surface, but not for the SSO
  // bootstrap routes mounted by ssoRoutes.
  app.use('/api/v1/ui/lists', requireSession())
  app.use('/api/v1/ui/lists/*', requireSession())
  app.use('/api/v1/ui/groups', requireSession())
  app.use('/api/v1/ui/groups/*', requireSession())
  app.use('/api/v1/ui/mcp-tokens', requireSession())
  app.use('/api/v1/ui/mcp-tokens/*', requireSession())

  // The SDK surface (`/api/v1/sdk/*`) was retired in PR 3 of
  // feat/rpc-bindings — consumers (events-api, planner-api, lists-mcp)
  // now reach lists-api through the `ListsRPC` `WorkerEntrypoint`
  // binding, so the key-gated HTTP routes and the `sdkKeyGate`
  // middleware are gone.

  app.route('/', healthRoutes)
  app.route('/', ssoRoutes)
  app.route('/', settingsRoutes)
  app.route('/', mcpTokensRoutes)
  // Mounted before listsRoutes: GET /lists/realtime-token must match the
  // realtime route, not be captured as GET /lists/:listId with
  // listId="realtime-token".
  app.route('/', realtimeRoutes)
  app.route('/', listsRoutes)
  app.route('/', listItemsRoutes)
  app.route('/', fieldDefsRoutes)
  app.route('/', statusesRoutes)
  app.route('/', commentsRoutes)
  app.route('/', labelsRoutes)
  app.route('/', viewsRoutes)
  app.route('/', groupsRoutes)

  app.notFound((c) =>
    c.json({ error: ANTI_FINGERPRINT_NOT_FOUND }, 404),
  )

  return app
}
