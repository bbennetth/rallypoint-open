import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
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
import { holidaysRoutes } from './routes/holidays.js'
import { weatherRoutes } from './routes/weather.js'
import { pushRoutes } from './routes/push.js'

export interface BuildAppDeps {
  env: Env
  logger?: Logger
  // Repos are required — callers must inject D1 repos (buildD1Repos) or
  // memory repos for testing. There is no default pg fallback.
  repos: Repos
  services?: Services
}

export function buildApp(deps: BuildAppDeps): Hono<HonoApp> {
  const logger = deps.logger ?? buildLogger(deps.env)
  const repos = deps.repos
  const services = deps.services ?? buildServices(deps.env)
  const app = new Hono<HonoApp>()

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
  app.route('/', holidaysRoutes)
  app.route('/', weatherRoutes)
  app.route('/', pushRoutes)

  app.notFound((c) =>
    c.json({ error: ANTI_FINGERPRINT_NOT_FOUND }, 404),
  )

  return app
}
