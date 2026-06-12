import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { noopRealtimeBus, type RealtimeBus, type RealtimeHubNamespace } from '@rallypoint/realtime'
import { ANTI_FINGERPRINT_NOT_FOUND } from '@rallypoint/shared'
import type { Env } from './env.js'
import { buildLogger, type Logger } from './logger.js'
import type { HonoApp } from './context.js'
import type { Repos } from './repos/types.js'
import type { Services } from './services/types.js'
import { buildServices } from './services/index.js'
import { requestId } from './middleware/request-id.js'
import { accessLog } from './middleware/access-log.js'
import { errorHandler } from './middleware/error-handler.js'
import { requireAllowedOrigin } from './middleware/origin.js'
import { requireCsrf } from './middleware/csrf.js'
import { requireSession } from './middleware/session.js'
import { sdkKeyGate } from './middleware/app-api-key.js'
import { healthRoutes } from './routes/health.js'
import { ssoRoutes } from './routes/sso.js'
import { settingsRoutes } from './routes/settings.js'
import { sdkListsRoutes } from './routes/sdk-lists.js'
import { sdkSeriesRoutes } from './routes/sdk-series.js'
import { sdkWritesRoutes } from './routes/sdk-writes.js'
import { sdkMcpRoutes } from './routes/sdk-mcp.js'
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
  const logger = deps.logger ?? buildLogger(deps.env)
  const repos = deps.repos
  const services = deps.services ?? buildServices(deps.env)
  const realtime = deps.realtime ?? noopRealtimeBus()
  const app = new Hono<HonoApp>()

  // Conservative default headers. Slice 1 serves no HTML, so the stock
  // secureHeaders defaults are enough; CSP with nonces lands when the
  // API starts rendering authenticated UI.
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

  // The SDK surface (§3.13): peer-app key gate, no cookies/origin/CSRF.
  // events-api proxies group-list reads (GET /sdk/lists, /sdk/lists/:id/items,
  // /sdk/lists/:id/fields) using either configured key. All other SDK routes
  // are planner-api–only. sdkKeyGate dispatches to the right key set based on
  // method + path so a single app.use() covers the whole surface without
  // double-gating overlapping URLs (e.g. POST vs GET on /api/v1/sdk/lists).
  app.use('/api/v1/sdk/*', sdkKeyGate)

  app.route('/', healthRoutes)
  app.route('/', ssoRoutes)
  app.route('/', settingsRoutes)
  app.route('/', sdkListsRoutes)
  app.route('/', sdkSeriesRoutes)
  app.route('/', sdkWritesRoutes)
  app.route('/', sdkMcpRoutes)
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
