import { z } from 'zod'

// Single source of truth for the Rallypoint Money API
// environment-variable contract. Mirrors apps/lists-api: lean, and
// namespaced under MONEY_ so the services can share a host shell
// (the local dev stack) without clobbering each other's vars.

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8083),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // The hosted Money UI origin. Backs the UI/SDK CORS split described
  // in docs/design/api-namespaces-cors.md. Namespaced to avoid the
  // RPID `UI_ORIGIN` collision when multiple services run on one host.
  MONEY_UI_ORIGIN: z.string().url().default('http://localhost:5176'),
  SDK_CORS_ALLOWED_ORIGINS: z.string().default(''),

  // Rallypoint ID coordinates. money-api consumes RPID over HTTP via
  // @rallypoint/id-client (session verify) and the SSO exchange.
  RPID_API_URL: z.string().url().default('http://localhost:8080'),
  RPID_UI_URL: z.string().url().default('http://localhost:5173'),

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

  // Bearer presented to RPID's *_API_KEY-gated SDK endpoints
  // (/sdk/sso/exchange). MUST match the value RPID parses for the
  // money app. Required in production; a dev default is supplied
  // post-parse so the local stack boots unconfigured.
  MONEY_API_KEY: z.string().min(32).optional(),

  // Peer-app key that gates the /api/v1/sdk/* surface. events-api
  // presents its own EVENTS_API_KEY; money-api validates it against
  // this. Optional → unset means /sdk/* 404s (the route does not
  // exist on this deployment). the local dev stack exports the same value
  // to both services.
  EVENTS_API_KEY: z.string().min(32).optional(),

  // Symmetric key material for sealing the RPID session bearer at rest
  // (crypto/encryption.ts). Active version is MONEY_SESSION_KEY_VERSION;
  // rows store the version they were sealed under so a rotation can add
  // V2 while V1 rows still decrypt. Required in production; dev default
  // supplied post-parse.
  MONEY_SESSION_KEY_V1: z.string().min(32).optional(),
  MONEY_SESSION_KEY_VERSION: z.coerce.number().int().min(1).default(1),

  // HMAC key for short-lived realtime channel tokens (#313, Phase 3).
  // The Worker mints a token after the read-authorization check; the
  // RealtimeHub Durable Object verifies it on WebSocket connect/refresh.
  // Required in production; dev default supplied post-parse.
  REALTIME_TOKEN_HMAC_KEY: z.string().min(32).optional(),

  // Cookie names. Optional → derived from NODE_ENV post-parse:
  // production gets the __Host- prefix; dev drops it because __Host-
  // cookies are silently refused over http://localhost.
  MONEY_SESSION_COOKIE_NAME: z.string().min(1).optional(),
  MONEY_CSRF_COOKIE_NAME: z.string().min(1).optional(),
  MONEY_SSO_STATE_COOKIE_NAME: z.string().min(1).optional(),

  // Build metadata — set by the Dockerfile at image-build time.
  BUILD_VERSION: z.string().default('dev'),
  BUILD_COMMIT: z.string().default('dev'),
})

type ParsedEnv = z.infer<typeof EnvSchema>

// Resolved env — the fields below are mandatory at the consumption
// boundary, so the resolver fills them in (prod/dev secret + cookie-name
// derivation) and strips their optionality.
export type Env = Omit<
  ParsedEnv,
  | 'MONEY_API_KEY'
  | 'MONEY_SESSION_KEY_V1'
  | 'REALTIME_TOKEN_HMAC_KEY'
  | 'MONEY_SESSION_COOKIE_NAME'
  | 'MONEY_CSRF_COOKIE_NAME'
  | 'MONEY_SSO_STATE_COOKIE_NAME'
> & {
  MONEY_API_KEY: string
  MONEY_SESSION_KEY_V1: string
  REALTIME_TOKEN_HMAC_KEY: string
  MONEY_SESSION_COOKIE_NAME: string
  MONEY_CSRF_COOKIE_NAME: string
  MONEY_SSO_STATE_COOKIE_NAME: string
}

// Dev-only fallbacks for the required secrets. Production refuses
// to boot without explicit values; dev/test get a fixed stand-in so
// the local stack and the test suite run unconfigured. Must match
// the local dev stack and .env.example so the SSO exchange works even when
// an app is started outside the dev stack (RPID and money-api must present
// the SAME key or RPID 403s the exchange).
const DEV_API_KEY = 'dev-money-api-key-do-not-use-in-production-32+chars'
const DEV_SESSION_KEY_V1 = 'dev-money-session-key-v1-0000000000000'
const DEV_REALTIME_TOKEN_HMAC_KEY = 'dev-realtime-token-hmac-key-0000000000000'
// MUST match apps/events-api/src/env.ts DEV_API_KEY — that is the value
// events-api presents to money-api's /sdk/* gate in the dev stack.
const DEV_EVENTS_API_KEY = 'dev-events-api-key-do-not-use-in-production-32+chars'

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

  const apiKey = parsed.MONEY_API_KEY ?? (isProd ? undefined : DEV_API_KEY)
  const sessionKeyV1 =
    parsed.MONEY_SESSION_KEY_V1 ?? (isProd ? undefined : DEV_SESSION_KEY_V1)
  const realtimeKey =
    parsed.REALTIME_TOKEN_HMAC_KEY ?? (isProd ? undefined : DEV_REALTIME_TOKEN_HMAC_KEY)
  if (!apiKey || !sessionKeyV1 || !realtimeKey) {
    const missing = [
      !apiKey ? 'MONEY_API_KEY' : null,
      !sessionKeyV1 ? 'MONEY_SESSION_KEY_V1' : null,
      !realtimeKey ? 'REALTIME_TOKEN_HMAC_KEY' : null,
    ]
      .filter(Boolean)
      .join(', ')
    throw new Error(`Invalid environment configuration:\n  ${missing}: required in production`)
  }

  return {
    ...parsed,
    MONEY_API_KEY: apiKey,
    // Unset in prod → /sdk/* 404s (integration off); dev gets the shared
    // stand-in so a fresh stack proxies group ledgers without manual config.
    EVENTS_API_KEY: parsed.EVENTS_API_KEY ?? (isProd ? undefined : DEV_EVENTS_API_KEY),
    MONEY_SESSION_KEY_V1: sessionKeyV1,
    REALTIME_TOKEN_HMAC_KEY: realtimeKey,
    MONEY_SESSION_COOKIE_NAME:
      parsed.MONEY_SESSION_COOKIE_NAME ?? (isProd ? '__Host-rpm_session' : 'rpm_session'),
    MONEY_CSRF_COOKIE_NAME:
      parsed.MONEY_CSRF_COOKIE_NAME ?? (isProd ? '__Host-rpm_csrf' : 'rpm_csrf'),
    MONEY_SSO_STATE_COOKIE_NAME:
      parsed.MONEY_SSO_STATE_COOKIE_NAME ??
      (isProd ? '__Host-rpm_sso_state' : 'rpm_sso_state'),
  }
}

// Lazy memoized accessor for boot code; tests construct an Env
// directly via parseEnv() against an explicit source object.
let _env: Env | null = null
export function getEnv(): Env {
  _env ??= parseEnv()
  return _env
}
export function _resetEnvCacheForTests(): void {
  _env = null
}
