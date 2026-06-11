import { z } from 'zod'

// Single source of truth for environment-variable contract. Every
// value is parsed once at startup; handlers receive a typed Env
// object via the Hono context rather than reading process.env
// scattered throughout the code.

const EnvSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Origin/CORS — slice 0 design doc.
  UI_ORIGIN: z.string().url().default('http://localhost:5173'),
  SDK_CORS_ALLOWED_ORIGINS: z.string().default(''),

  // Session cookie name. Defaults derived from NODE_ENV below:
  //   production -> __Host-rp_session  (full prefix protections,
  //                  requires Secure + no Domain + Path=/)
  //   dev / test  -> rp_session         (Firefox/Safari silently
  //                  drop __Host- on http://localhost; #20).
  // Operators with a custom hostname strategy can override.
  SESSION_COOKIE_NAME: z.string().min(1).optional(),

  // CSRF cookie name (#18). Same env semantics as SESSION_COOKIE_NAME.
  //   production -> __Host-rp_csrf
  //   dev / test  -> rp_csrf
  CSRF_COOKIE_NAME: z.string().min(1).optional(),

  // Trust policy for IP-extraction headers (#33).
  //   legacy           — current behavior: leftmost XFF, then
  //                       cf-connecting-ip, then 0.0.0.0. Safe
  //                       behind a single trusted reverse proxy
  //                       (Nginx/Caddy/Render/Fly).
  //   xff              — strict: leftmost XFF only, no fallback
  //                       to cf-connecting-ip.
  //   cf-connecting-ip — Cloudflare deploys: ignore XFF, use
  //                       cf-connecting-ip exclusively.
  //   none             — no proxy at all (rare). Trust no
  //                       forwarded headers — IP rate-limits +
  //                       audit IPs come from the socket address.
  // Default 'legacy' preserves current behavior. Operators on
  // bare-metal-public-internet should switch to 'none' (or front
  // the API with a proxy that strips client-supplied XFF).
  TRUSTED_PROXY_HEADER: z
    .enum(['legacy', 'xff', 'cf-connecting-ip', 'none'])
    .default('legacy'),

  // (Postgres DATABASE_URL removed in the CF migration #313 — id-api uses
  // the D1 binding, not a connection URL.)

  // Secrets (slice 1 just validates presence/shape; slice 2+ uses them)
  ARGON2_PEPPER: z
    .string()
    .min(32, 'ARGON2_PEPPER must be at least 32 characters')
    .default('dev-pepper-do-not-use-in-production-32+chars'),
  SESSION_HMAC_KEY: z
    .string()
    .min(32, 'SESSION_HMAC_KEY must be at least 32 characters')
    .default('dev-session-hmac-do-not-use-in-production-32+chars'),
  SIGNIN_CODE_HMAC_KEY: z
    .string()
    .min(32, 'SIGNIN_CODE_HMAC_KEY must be at least 32 characters')
    .default('dev-signin-code-hmac-do-not-use-in-production-32+chars'),

  // Mailer. SMTP (nodemailer) was dropped in the CF migration (#313) —
  // it's Node-only and id-api runs on Workers; use Resend (prod) or log
  // (dev). Default `log` so a bare Worker boots without a mail provider.
  MAILER: z.enum(['resend', 'log']).default('log'),
  RESEND_API_KEY: z.string().optional(),
  // The From address (used by Resend). Name kept for back-compat.
  SMTP_FROM: z.string().default('Rallypoint ID <noreply@rallypoint.local>'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:8080'),

  // Captcha
  CAPTCHA: z.enum(['turnstile', 'allow', 'deny']).default('turnstile'),
  TURNSTILE_SITE_KEY: z.string().default('1x00000000000000000000AA'),
  TURNSTILE_SECRET: z.string().default('1x0000000000000000000000000000000AA'),

  // HIBP
  BREACHED_PASSWORD_CHECK: z.enum(['hibp', 'stub', 'always-breached']).default('hibp'),

  // Admin (slice 5.5)
  ADMIN_TOKEN: z
    .string()
    .min(32, 'ADMIN_TOKEN must be at least 32 characters when set')
    .optional(),

  // EVENTS_API_KEY — bearer for the events-api → RPID
  // /api/v1/sdk/sso/exchange call (Rallypoint Events #57).
  // Empty = SSO exchange disabled (anti-fingerprint 404, same
  // pattern as ADMIN_TOKEN).
  EVENTS_API_KEY: z.string().min(32).optional(),

  // LISTS_API_KEY — same role as EVENTS_API_KEY but for the
  // lists-api → RPID /sdk/* calls (Rallypoint Lists #114). Each
  // product app registers its own key; the /sdk gate accepts any
  // configured app key.
  LISTS_API_KEY: z.string().min(32).optional(),

  // SSO_EVENTS_HOST — bare host (no protocol) where the Rallypoint
  // Events web client lives. The mint endpoint at
  // /api/v1/ui/sso/code validates the body's `return_to_host`
  // against this value when the body's `client` is 'events'.
  // Future apps add their own *_HOST env (see SSO_LISTS_HOST).
  // Empty = mint with client='events' returns 400 sso_client_unknown.
  // Dev: localhost:5174 (matches docker-compose events-web).
  // Prod: events.rallypt.app.
  SSO_EVENTS_HOST: z.string().min(1).optional(),

  // SSO_LISTS_HOST — bare host for the Rallypoint Lists web client.
  // Mirrors SSO_EVENTS_HOST; gates mint with client='lists'.
  // Dev: localhost:5175. Prod: lists.rallypt.app.
  SSO_LISTS_HOST: z.string().min(1).optional(),

  // MONEY_API_KEY — same role as EVENTS_API_KEY/LISTS_API_KEY but for
  // money-api → RPID /sdk/* calls (Rallypoint Money #116). Each
  // product app registers its own key; the /sdk gate accepts any
  // configured app key.
  MONEY_API_KEY: z.string().min(32).optional(),

  // SSO_MONEY_HOST — bare host for the Rallypoint Money web client.
  // Mirrors SSO_LISTS_HOST; gates mint with client='money'.
  // Dev: localhost:5176. Prod: money.rallypt.app.
  SSO_MONEY_HOST: z.string().min(1).optional(),

  // PLANNER_API_KEY — same role as EVENTS_API_KEY/LISTS_API_KEY but for
  // planner-api → RPID /sdk/* calls (Rallypoint Planner #255). Each
  // product app registers its own key; the /sdk gate accepts any
  // configured app key.
  PLANNER_API_KEY: z.string().min(32).optional(),

  // SSO_PLANNER_HOST — bare host for the Rallypoint Planner web client.
  // Mirrors SSO_MONEY_HOST; gates mint with client='planner'.
  // Dev: localhost:5177. Prod: planner.rallypt.app.
  SSO_PLANNER_HOST: z.string().min(1).optional(),

  // SSO_HINT_COOKIE_DOMAIN — parent domain for the JS-readable rp_sso
  // hint cookie (#369). App-web subdomains read this to decide whether
  // to attempt silent SSO. Omit the attribute when undefined/empty (dev
  // localhost: browsers ignore port, cookie still crosses dev ports).
  // Prod: .rallypt.app  QA: .rallypt.dev
  SSO_HINT_COOKIE_DOMAIN: z.string().min(1).optional(),

  // Object storage (avatar uploads) is a native R2 binding
  // (env.OBJECT_STORE), wired in services/index.ts from the
  // wrangler.toml [[r2_buckets]] binding — no endpoint/region/keys as
  // string config (#409).

  // Build metadata — set by the Dockerfile at image-build time
  BUILD_VERSION: z.string().default('dev'),
  BUILD_COMMIT: z.string().default('dev'),
})

type ParsedEnv = z.infer<typeof EnvSchema>

// SESSION_COOKIE_NAME is required at the consumption boundary
// (handlers read c.var.env.SESSION_COOKIE_NAME), so we strip the
// optionality after deriving it.
export type Env = Omit<ParsedEnv, 'SESSION_COOKIE_NAME' | 'CSRF_COOKIE_NAME'> & {
  SESSION_COOKIE_NAME: string
  CSRF_COOKIE_NAME: string
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  const parsed = result.data
  const isProd = parsed.NODE_ENV === 'production'
  return {
    ...parsed,
    SESSION_COOKIE_NAME:
      parsed.SESSION_COOKIE_NAME ?? (isProd ? '__Host-rp_session' : 'rp_session'),
    CSRF_COOKIE_NAME:
      parsed.CSRF_COOKIE_NAME ?? (isProd ? '__Host-rp_csrf' : 'rp_csrf'),
  }
}

// Lazy memoized accessor — server.ts calls parseEnv() once at
// boot, but test code may want a fresh parse per test.
let _env: Env | null = null
export function getEnv(): Env {
  _env ??= parseEnv()
  return _env
}
export function _resetEnvCacheForTests(): void {
  _env = null
}
