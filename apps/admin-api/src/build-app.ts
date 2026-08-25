import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
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
import { requireAdmin } from './middleware/admin.js'
import { healthRoutes } from './routes/health.js'
import { ssoRoutes } from './routes/sso.js'
import { settingsRoutes } from './routes/settings.js'
import { reviewRoutes } from './routes/review.js'
import { exerciseCatalogRoutes } from './routes/exercises.js'
import { foodReviewRoutes } from './routes/food-review.js'
import { systemEventsRoutes } from './routes/system-events.js'
import { lineupIngestRoutes } from './routes/lineup-ingest.js'
import { artistReviewRoutes } from './routes/artist-reviews.js'

// Rallypoint Admin BFF: health + SSO + settings passthrough + the
// exercise-submission review queue (proxied to FitnessRPC). Every domain
// route sits behind requireSession + requireAdmin (the ADMIN_USER_IDS
// allowlist). No realtime, no R2, no cron.

export interface BuildAppDeps {
  env: Env
  logger?: Logger
  // Drains the PostHog log-sink buffer. Passed alongside `logger` by the
  // Worker entrypoint (paired via buildLoggerWithFlush). Defaults to a
  // no-op when a bare logger is injected without one (tests).
  flushLogs?: () => Promise<void>
  // Repos are required — callers must inject D1 repos (buildD1Repos) or
  // stubs for testing. There is no default fallback.
  repos: Repos
  services: Services
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
  const app = new Hono<HonoApp>()

  // Outermost middleware: after every request (success or throw) drain the
  // PostHog log-sink buffer via executionCtx.waitUntil. Registered first so
  // its post-next flush runs last, after all logging including onError.
  app.use('*', logFlush(flushLogs))

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
    await next()
  })
  app.use('*', accessLog)

  app.onError(errorHandler)

  // The UI surface: origin allowlist + CSRF double-submit front everything
  // under /api/v1/ui/*. requireSession is applied per-router, NOT here —
  // SSO exchange, signout, and the CSRF bootstrap must be reachable without
  // an existing admin session.
  app.use('/api/v1/ui/*', requireAllowedOrigin())
  app.use('/api/v1/ui/*', requireCsrf())

  // The review queue: session-gated AND allowlist-gated. requireAdmin runs
  // after requireSession so it can read the verified session userId.
  app.use('/api/v1/ui/submissions', requireSession(), requireAdmin())
  app.use('/api/v1/ui/submissions/*', requireSession(), requireAdmin())
  app.use('/api/v1/ui/food-submissions', requireSession(), requireAdmin())
  app.use('/api/v1/ui/food-submissions/*', requireSession(), requireAdmin())
  app.use('/api/v1/ui/exercises', requireSession(), requireAdmin())
  app.use('/api/v1/ui/exercises/*', requireSession(), requireAdmin())
  app.use('/api/v1/ui/ai-reviews', requireSession(), requireAdmin())
  app.use('/api/v1/ui/ai-reviews/*', requireSession(), requireAdmin())
  app.use('/api/v1/ui/system-events', requireSession(), requireAdmin())
  app.use('/api/v1/ui/system-events/*', requireSession(), requireAdmin())
  app.use('/api/v1/ui/lineup-ingestions/*', requireSession(), requireAdmin())
  app.use('/api/v1/ui/artists', requireSession(), requireAdmin())
  app.use('/api/v1/ui/artists/*', requireSession(), requireAdmin())
  app.use('/api/v1/ui/artist-mb-reviews', requireSession(), requireAdmin())
  app.use('/api/v1/ui/artist-mb-reviews/*', requireSession(), requireAdmin())

  app.route('/', healthRoutes)
  app.route('/', ssoRoutes)
  app.route('/', settingsRoutes)
  app.route('/', reviewRoutes)
  app.route('/', foodReviewRoutes)
  app.route('/', exerciseCatalogRoutes)
  app.route('/', systemEventsRoutes)
  app.route('/', lineupIngestRoutes)
  app.route('/', artistReviewRoutes)

  app.notFound((c) =>
    c.json({ error: ANTI_FINGERPRINT_NOT_FOUND }, 404),
  )

  return app
}
