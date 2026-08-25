import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
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
import { healthRoutes } from './routes/health.js'
import { ssoRoutes } from './routes/sso.js'
import { settingsRoutes } from './routes/settings.js'
import { listsRoutes } from './routes/lists.js'
import { notesRoutes } from './routes/notes.js'
import { eventsRoutes } from './routes/events.js'
import { myDayRoutes } from './routes/my-day.js'
import { upcomingRoutes } from './routes/upcoming.js'
import { recurringRoutes } from './routes/recurring.js'
import { shoppingRoutes } from './routes/shopping.js'
import { choresRoutes } from './routes/chores.js'
import { diaryRoutes } from './routes/diary.js'
import { braindumpRoutes } from './routes/braindump.js'
import { assistRoutes } from './routes/assist.js'
import { fitnessFoodRoutes } from './routes/fitness-food.js'
import { holidaysRoutes } from './routes/holidays.js'
import { weatherRoutes } from './routes/weather.js'
import { dataExportRoutes } from './routes/data-export.js'
import { dataImportRoutes } from './routes/data-import.js'
import { pushRoutes } from './routes/push.js'

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
  services?: Services
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

  // The UI surface: origin allowlist + CSRF double-submit front
  // everything under /api/v1/ui/*. requireSession is applied per-router
  // below, NOT here — SSO exchange, signout, and the CSRF bootstrap
  // must be reachable without an existing planner session.
  app.use('/api/v1/ui/*', requireAllowedOrigin())
  app.use('/api/v1/ui/*', requireCsrf())

  app.route('/', healthRoutes)
  app.route('/', ssoRoutes)
  app.route('/', settingsRoutes)
  app.route('/', listsRoutes)
  app.route('/', notesRoutes)
  app.route('/', eventsRoutes)
  app.route('/', myDayRoutes)
  app.route('/', upcomingRoutes)
  app.route('/', recurringRoutes)
  app.route('/', shoppingRoutes)
  app.route('/', choresRoutes)
  app.route('/', diaryRoutes)
  app.route('/', braindumpRoutes)
  app.route('/', assistRoutes)
  app.route('/', fitnessFoodRoutes)
  app.route('/', holidaysRoutes)
  app.route('/', weatherRoutes)
  app.route('/', dataExportRoutes)
  app.route('/', dataImportRoutes)
  app.route('/', pushRoutes)

  app.notFound((c) =>
    c.json({ error: ANTI_FINGERPRINT_NOT_FOUND }, 404),
  )

  return app
}
