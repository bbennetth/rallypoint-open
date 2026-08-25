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
import { healthRoutes } from './routes/health.js'
import { ssoRoutes } from './routes/sso.js'
import { settingsRoutes } from './routes/settings.js'
import { exercisesRoutes } from './routes/exercises.js'
import { musclesRoutes } from './routes/muscles.js'
import { workoutsRoutes } from './routes/workouts.js'
import { metricsRoutes } from './routes/metrics.js'
import { insightsRoutes } from './routes/insights.js'
import { wodTemplatesRoutes } from './routes/wod-templates.js'
import { favoritesRoutes } from './routes/favorites.js'
import { machineSettingsRoutes } from './routes/machine-settings.js'
import { trainingPlansRoutes } from './routes/training-plans.js'
import { scanRoutes } from './routes/scan.js'
import { aiFeedbackRoutes } from './routes/ai-feedback.js'
import { foodRoutes } from './routes/food.js'
import { foodFavoritesRoutes } from './routes/food-favorites.js'
import { weatherRoutes } from './routes/weather.js'
import { progressPhotosRoutes } from './routes/progress-photos.js'
import { submissionsRoutes } from './routes/submissions.js'
import { foodSubmissionsRoutes } from './routes/food-submissions.js'
import { mealPrepRoutes } from './routes/meal-prep.js'
import { recipesRoutes } from './routes/recipes.js'
import { pushRoutes } from './routes/push.js'
import { dataExportRoutes } from './routes/data-export.js'
import { dataImportRoutes } from './routes/data-import.js'

// Slice 1: health + SSO + settings + the exercise catalog (exercises +
// muscle taxonomy). Slice 2: workout (training session) logging.
// Slice 3: body/health metric data points.
// No realtime (HUB/DO). R2 (OBJECT_STORE) backs the progress-photo routes.

export interface BuildAppDeps {
  env: Env
  logger?: Logger
  // Drains the PostHog log-sink buffer. Passed alongside `logger` by the
  // Worker entrypoint (paired via buildLoggerWithFlush). Defaults to a
  // no-op when a bare logger is injected without one (tests).
  flushLogs?: () => Promise<void>
  // Repos are required — callers must inject D1 repos (buildD1Repos) or
  // memory repos for testing. There is no default fallback.
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
  // an existing fitness session.
  app.use('/api/v1/ui/*', requireAllowedOrigin())
  app.use('/api/v1/ui/*', requireCsrf())

  // The exercise catalog is session-gated (per-actor visibility + custom
  // ownership). Applied per-router so SSO/CSRF bootstrap stays reachable.
  app.use('/api/v1/ui/exercises', requireSession())
  app.use('/api/v1/ui/exercises/*', requireSession())
  app.use('/api/v1/ui/muscle-groups', requireSession())

  // Workout logging is session-gated; all reads and writes scope to the actor.
  app.use('/api/v1/ui/workouts', requireSession())
  app.use('/api/v1/ui/workouts/*', requireSession())

  // Metric time-series is session-gated; all reads and writes scope to the actor.
  app.use('/api/v1/ui/metrics', requireSession())
  app.use('/api/v1/ui/metrics/*', requireSession())

  // Derived training insights are session-gated; data scoped to actor only.
  app.use('/api/v1/ui/insights/*', requireSession())

  // WOD templates (slice 6): session-gated; reads return global benchmarks
  // plus the actor's own customs; writes only touch the actor's customs.
  app.use('/api/v1/ui/wod-templates', requireSession())
  app.use('/api/v1/ui/wod-templates/*', requireSession())

  // Per-user exercise favorites (Ink redesign S6): all surface gated on
  // the active fitness session.
  app.use('/api/v1/ui/favorites/*', requireSession())

  // Multi-plan weekly schedule (Ink redesign S7): all surface gated on
  // the active fitness session.
  app.use('/api/v1/ui/training-plans', requireSession())
  app.use('/api/v1/ui/training-plans/*', requireSession())

  // Photo-OCR scan (Ink redesign S9): session-gated. The body is JSON
  // with a base64-encoded image (rides the existing CSRF + JSON
  // pipeline), so the `requireCsrf()` guard at `/api/v1/ui/*` applies
  // identically — no special-casing.
  app.use('/api/v1/ui/scan/*', requireSession())

  // Food logger (issue #700): barcode lookup, AI photo scan, diary CRUD.
  // Session-gated; diary rows scope to the actor.
  app.use('/api/v1/ui/food/*', requireSession())

  // AI scan feedback (accepted/edited/rejected/retried → the AI trace
  // corpus): session-gated; userId comes from the session.
  app.use('/api/v1/ui/ai/*', requireSession())

  // Coordinate weather forecast (running weather snapshots): session-gated
  // + per-user rate limited inside the handler.
  app.use('/api/v1/ui/weather', requireSession())

  // Body Stats progress pictures: session-gated; rows + R2 objects scope
  // to the actor (the image serve route streams from the private bucket).
  app.use('/api/v1/ui/progress-photos', requireSession())
  app.use('/api/v1/ui/progress-photos/*', requireSession())

  // Exercise submissions: session-gated (the `/submit` sub-route lives
  // under exercises, already gated above; `/submissions*` covers the
  // list + migrate routes).
  app.use('/api/v1/ui/submissions', requireSession())
  app.use('/api/v1/ui/submissions/*', requireSession())

  // Food submissions: session-gated (the write path lives under
  // /food/log, already gated above; `/food-submissions*` covers the
  // list + migrate routes).
  app.use('/api/v1/ui/food-submissions', requireSession())
  app.use('/api/v1/ui/food-submissions/*', requireSession())

  // Meal-prep tool (prepared-meal batches + recipes): session-gated; all
  // rows scope to the actor. Ingredient identification reuses the already-
  // gated /food/* scan endpoints.
  app.use('/api/v1/ui/meal-prep', requireSession())
  app.use('/api/v1/ui/meal-prep/*', requireSession())
  app.use('/api/v1/ui/recipes', requireSession())
  app.use('/api/v1/ui/recipes/*', requireSession())

  // Whole-account data export/import (backup–restore): session-gated. The
  // export streams every row the actor owns and the import writes into that
  // same account, so the session IS the authorization boundary here — there is
  // no per-row check downstream to fall back on.
  app.use('/api/v1/ui/data-export', requireSession())
  app.use('/api/v1/ui/data-import', requireSession())

  // Peer BFFs (Planner) read a user's training via the FitnessRPC
  // WorkerEntrypoint (src/rpc.ts) — there is no key-gated HTTP SDK
  // surface any more.

  app.route('/', healthRoutes)
  app.route('/', ssoRoutes)
  app.route('/', settingsRoutes)
  app.route('/', exercisesRoutes)
  app.route('/', musclesRoutes)
  app.route('/', workoutsRoutes)
  app.route('/', metricsRoutes)
  app.route('/', insightsRoutes)
  app.route('/', wodTemplatesRoutes)
  app.route('/', favoritesRoutes)
  app.route('/', machineSettingsRoutes)
  app.route('/', trainingPlansRoutes)
  app.route('/', scanRoutes)
  app.route('/', aiFeedbackRoutes)
  app.route('/', foodRoutes)
  app.route('/', foodFavoritesRoutes)
  app.route('/', weatherRoutes)
  app.route('/', progressPhotosRoutes)
  app.route('/', dataExportRoutes)
  app.route('/', dataImportRoutes)
  app.route('/', submissionsRoutes)
  app.route('/', foodSubmissionsRoutes)
  app.route('/', mealPrepRoutes)
  app.route('/', recipesRoutes)
  app.route('/', pushRoutes)

  app.notFound((c) =>
    c.json({ error: ANTI_FINGERPRINT_NOT_FOUND }, 404),
  )

  return app
}
