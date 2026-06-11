import { Hono } from 'hono'
import { NONCE, secureHeaders } from 'hono/secure-headers'
import { ANTI_FINGERPRINT_NOT_FOUND } from '@rallypoint/shared'
import type { Env } from './env.js'
import { buildLogger, type Logger } from './logger.js'
import type { HonoApp } from './context.js'
import { requestId } from './middleware/request-id.js'
import { accessLog } from './middleware/access-log.js'
import { errorHandler } from './middleware/error-handler.js'
import { csrfIssueHandler, requireCsrf } from './middleware/csrf.js'
import { requireAllowedOrigin } from './middleware/origin.js'
import { sdkCors } from './middleware/sdk-cors.js'
import { healthRoutes } from './routes/health.js'
import { authUiRoutes, publicAuthRoutes } from './routes/auth/index.js'
import { sessionRoutes } from './routes/auth/session.js'
import { adminRoutes } from './routes/admin.js'
import { ssoRoutes } from './routes/sso.js'
import { appsRoutes } from './routes/apps.js'
import { sdkUsersRoutes } from './routes/sdk-users.js'
import { settingsRoutes } from './routes/settings.js'
import { avatarUiRoutes, avatarServeRoutes } from './routes/avatar.js'
import type { Repos } from './repos/types.js'
import type { Services } from './services/types.js'
import { createPasswordHasher, type PasswordHasher } from './crypto/password.js'
import { SessionCache } from './session/cache.js'
import { attachSessionCache } from './middleware/session.js'

export interface BuildAppDeps {
  env: Env
  logger?: Logger
  repos: Repos
  services: Services
  passwordHasher?: PasswordHasher
  sessionCache?: SessionCache
}

export function buildApp(deps: BuildAppDeps): Hono<HonoApp> {
  const logger = deps.logger ?? buildLogger(deps.env)
  const passwordHasher =
    deps.passwordHasher ?? createPasswordHasher({ pepper: deps.env.ARGON2_PEPPER })
  const sessionCache = deps.sessionCache ?? new SessionCache()
  const app = new Hono<HonoApp>()

  // The public avatar serve route is embedded cross-origin as an <img>
  // by every Rallypoint web app (planner/events/money/id-web), each on
  // its own origin. The global secureHeaders() below defaults to
  // `Cross-Origin-Resource-Policy: same-origin`, which the browser
  // honours on the serve route's 302 and so blocks the embed. Relax CORP
  // to cross-origin for just this path. Registered BEFORE secureHeaders
  // so it unwinds last and wins the final header write.
  app.use('/api/v1/avatars/*', async (c, next) => {
    await next()
    c.header('Cross-Origin-Resource-Policy', 'cross-origin')
  })

  // CSP (#14):
  //   default-src 'self'        — only same-origin by default
  //   script-src NONCE          — per-request nonce; the only
  //                               inline script we have is on
  //                               /verify-email and it carries
  //                               the nonce attribute from
  //                               c.get('secureHeadersNonce').
  //   object-src 'none'         — no <object>/<embed>/<applet>
  //   base-uri 'self'           — neuters <base> injection
  //   frame-ancestors 'none'    — clickjacking defense
  //   style-src 'self' 'unsafe-inline' — server-controlled inline
  //                                       <style> blocks
  //   img-src 'self' data:      — allow inline data URIs (the
  //                               admin docs reference some)
  // HSTS only in production (so http://localhost dev isn't
  // permanently pinned to https by the browser).
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: [NONCE],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
      },
      // Permissions-Policy (P4.2) — neuter sensor / capture
      // APIs we don't use. Reduces blast radius of any future
      // XSS by denying access to camera/mic/geolocation/etc.
      permissionsPolicy: {
        accelerometer: [],
        camera: [],
        geolocation: [],
        gyroscope: [],
        magnetometer: [],
        microphone: [],
        payment: [],
        usb: [],
      },
      ...(deps.env.NODE_ENV === 'production'
        ? { strictTransportSecurity: 'max-age=31536000; includeSubDomains' }
        : {}),
    }),
  )
  app.use('*', requestId)
  app.use('*', async (c, next) => {
    c.set('env', deps.env)
    c.set('logger', logger)
    c.set('repos', deps.repos)
    c.set('services', deps.services)
    c.set('passwordHasher', passwordHasher)
    await next()
  })
  app.use('*', attachSessionCache(sessionCache))
  app.use('*', accessLog)

  app.onError(errorHandler)

  // Origin allowlist (#18) — defense-in-depth for /api/v1/ui/*.
  // Browsers always send Origin on cross-origin POST/PATCH/DELETE;
  // requests with a present-but-non-matching Origin get 403.
  // Missing Origin is allowed (covers curl + same-origin GETs).
  app.use('/api/v1/ui/*', requireAllowedOrigin())

  // CSRF token endpoint (#18). Bare GET, no CSRF check itself —
  // it's the issuer.
  app.get('/api/v1/ui/csrf', csrfIssueHandler)

  // CSRF double-submit check (#18) on every state-changing UI
  // request. GET/HEAD/OPTIONS pass through.
  app.use('/api/v1/ui/*', requireCsrf())

  // Allowlist CORS (#19) for the bearer-token SDK namespace. Runs
  // ahead of the SDK route mounts so OPTIONS preflight is answered
  // before per-route bearer auth.
  app.use('/api/v1/sdk/*', sdkCors())

  app.route('/', healthRoutes)
  app.route('/', publicAuthRoutes)
  app.route('/', authUiRoutes)
  app.route('/', sessionRoutes)
  app.route('/', adminRoutes)
  app.route('/', ssoRoutes)
  app.route('/', appsRoutes)
  app.route('/', sdkUsersRoutes)
  app.route('/', settingsRoutes)
  app.route('/', avatarUiRoutes)
  app.route('/', avatarServeRoutes)

  app.notFound((c) =>
    c.json({ error: ANTI_FINGERPRINT_NOT_FOUND }, 404),
  )

  return app
}
