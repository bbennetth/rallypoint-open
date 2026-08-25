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
import { realtimeRoutes } from './routes/realtime.js'
import { ledgersRoutes } from './routes/ledgers.js'
import { ledgerInvitesRoutes } from './routes/ledger-invites.js'
import { ledgerGroupsRoutes } from './routes/ledger-groups.js'
import { expensesRoutes } from './routes/expenses.js'
import { expenseCategoriesRoutes } from './routes/expense-categories.js'
import { expenseReceiptsRoutes } from './routes/expense-receipts.js'
import { settlementsRoutes } from './routes/settlements.js'

export interface BuildAppDeps {
  env: Env
  logger?: Logger
  // Drains the PostHog log-sink buffer. Passed alongside `logger` by the
  // Worker entrypoint (paired via buildLoggerWithFlush). Defaults to a
  // no-op when a bare logger is injected without one (tests).
  flushLogs?: () => Promise<void>
  // Repos are required — callers must inject D1 repos (buildD1Repos) or
  // memory repos for testing. There is no default pg fallback.
  repos: Repos
  // Required — the objectStore is backed by an R2 binding the caller must
  // wire (worker.ts from env.OBJECT_STORE; tests inject a stub or a real
  // Miniflare binding). No default: buildServices needs the binding (#409).
  services: Services
  // The realtime publisher bus. Tests default to a no-op (or inject a spy).
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
  const services = deps.services
  const realtime = deps.realtime ?? noopRealtimeBus()
  const app = new Hono<HonoApp>()

  // Outermost middleware: after every request (success or throw) drain the
  // PostHog log-sink buffer via executionCtx.waitUntil. Registered first so
  // its post-next flush runs last, after all logging including onError.
  app.use('*', logFlush(flushLogs))

  // The realtime WS-upgrade route is exempt from secureHeaders: it
  // mutates c.res.headers after next(), but that route returns the
  // RealtimeHub DO's response verbatim — a fetch()-produced Response
  // with immutable headers (and a 101 carrying webSocket must not be
  // cloned), so the mutation throws "Can't modify immutable headers"
  // and 500s the handshake.
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

  // The UI surface: origin allowlist + CSRF double-submit front
  // everything under /api/v1/ui/*. requireSession is applied per-router
  // below, NOT here — SSO exchange, signout, and the CSRF bootstrap
  // must be reachable without an existing money session.
  app.use('/api/v1/ui/*', requireAllowedOrigin())
  app.use('/api/v1/ui/*', requireCsrf())
  // Session is required for the ledger CRUD + groups + invite-accept
  // surfaces, but not for the SSO bootstrap routes mounted by ssoRoutes.
  app.use('/api/v1/ui/ledgers', requireSession())
  app.use('/api/v1/ui/ledgers/*', requireSession())
  app.use('/api/v1/ui/ledger-groups', requireSession())
  app.use('/api/v1/ui/ledger-groups/*', requireSession())

  // The SDK surface (`/api/v1/sdk/money/*`) was retired in PR 3 of
  // feat/rpc-bindings — events-api now reaches money-api through the
  // `MoneyRPC` `WorkerEntrypoint` binding, so the key-gated HTTP routes
  // and the `requireSdkKey` middleware are gone.

  app.route('/', healthRoutes)
  app.route('/', ssoRoutes)
  app.route('/', settingsRoutes)
  // realtimeRoutes MUST mount before ledgersRoutes so '/ledgers/realtime-token'
  // matches the scope-overview token handler instead of being captured as
  // `:ledgerId` on `GET /api/v1/ui/ledgers/:ledgerId`.
  app.route('/', realtimeRoutes)
  app.route('/', ledgersRoutes)
  app.route('/', ledgerInvitesRoutes)
  app.route('/', ledgerGroupsRoutes)
  app.route('/', expensesRoutes)
  app.route('/', expenseCategoriesRoutes)
  app.route('/', expenseReceiptsRoutes)
  app.route('/', settlementsRoutes)

  app.notFound((c) =>
    c.json({ error: ANTI_FINGERPRINT_NOT_FOUND }, 404),
  )

  return app
}
