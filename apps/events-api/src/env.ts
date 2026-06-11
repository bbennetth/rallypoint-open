import { z } from 'zod'

// Single source of truth for the Rallypoint Events API
// environment-variable contract. Mirrors the apps/id-api shape but
// stays lean — slice 1 only needs the bits that bind the
// listener, parse logs, and run migrations. Auth-side env keys
// (ARGON2_PEPPER etc.) belong to apps/id-api; this service consumes
// Rallypoint ID via @rallypoint/id-client (slice 2).

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // The hosted Events UI origin. Used by the same UI/SDK CORS
  // split described in docs/design/api-namespaces-cors.md. Slice 2
  // wires the actual middleware; slice 1 just parses the value.
  //
  // Deliberately namespaced — RPID's apps/id-api consumes `UI_ORIGIN`
  // from the same shell env when both services run on the host
  // (the local dev stack), so events-api uses `EVENTS_UI_ORIGIN` to
  // avoid the collision.
  EVENTS_UI_ORIGIN: z.string().url().default('http://localhost:5174'),
  SDK_CORS_ALLOWED_ORIGINS: z.string().default(''),

  // Rallypoint ID coordinates. events-api uses these in slice 2
  // when it starts consuming @rallypoint/id-client.
  RPID_API_URL: z.string().url().default('http://localhost:8080'),
  RPID_UI_URL: z.string().url().default('http://localhost:5173'),

  // Base origin of lists-api, for the group-lists BFF proxy. events-api
  // calls @rallypoint/lists-client against this server-to-server,
  // presenting EVENTS_API_KEY to lists-api's /sdk/* gate.
  LISTS_API_URL: z.string().url().default('http://localhost:8082'),

  // Base origin of money-api, for the per-group ledger auto-attach +
  // BFF read (design §8). events-api calls @rallypoint/money-client
  // against this server-to-server, presenting EVENTS_API_KEY to
  // money-api's /sdk/* gate (which already allowlists the events key).
  MONEY_API_URL: z.string().url().default('http://localhost:8083'),

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

  // Bearer presented to RPID's EVENTS_API_KEY-gated SDK endpoints
  // (/sdk/sso/exchange, /sdk/session/reauth). MUST match the value
  // RPID's apps/id-api parses under the same name. Required in
  // production; a dev default is supplied post-parse so the local
  // stack boots without manual config (the local dev stack sets the same
  // value on both services).
  EVENTS_API_KEY: z
    .string()
    .min(32, 'EVENTS_API_KEY must be at least 32 characters (set a longer shared secret).')
    .optional(),

  // Key events-api ACCEPTS from the Planner BFF on the
  // /api/v1/sdk/personal-events/* namespace (Slice 2). Optional in
  // production — a deployment without Planner simply has no key and the
  // namespace 404s (anti-fingerprint). A dev default is supplied
  // post-parse so the local stack boots without manual config.
  PLANNER_API_KEY: z
    .string()
    .min(32, 'PLANNER_API_KEY must be at least 32 characters (set a longer shared secret).')
    .optional(),

  // Symmetric key material for sealing the RPID session bearer at
  // rest (crypto/encryption.ts). The active version is
  // EVENTS_SESSION_KEY_VERSION; rows store the version they were
  // sealed under so a rotation can add V2 while V1 rows still
  // decrypt. Required in production; dev default supplied post-parse.
  EVENTS_SESSION_KEY_V1: z.string().min(32).optional(),
  EVENTS_SESSION_KEY_VERSION: z.coerce.number().int().min(1).default(1),

  // Cookie names. Optional → derived from NODE_ENV post-parse:
  // production gets the __Host- prefix (locks path=/, Secure, no
  // Domain); dev drops it because __Host- cookies are silently
  // refused over http://localhost (footgun #20).
  EVENTS_SESSION_COOKIE_NAME: z.string().min(1).optional(),
  EVENTS_CSRF_COOKIE_NAME: z.string().min(1).optional(),
  EVENTS_SSO_STATE_COOKIE_NAME: z.string().min(1).optional(),

  // Weather provider (slice 12; design slice plan row 12). Defaults
  // point at the free Open-Meteo public endpoints; commercial
  // operators set OPEN_METEO_COMMERCIAL_API_KEY to lift rate limits.
  OPEN_METEO_FORECAST_URL: z
    .string()
    .url()
    .default('https://api.open-meteo.com/v1/forecast'),
  OPEN_METEO_AIR_QUALITY_URL: z
    .string()
    .url()
    .default('https://air-quality-api.open-meteo.com/v1/air-quality'),
  OPEN_METEO_COMMERCIAL_API_KEY: z.string().min(1).optional(),

  // Weather cache freshness. The Cron Trigger pre-warms events in the
  // (-7d, +14d) window; a cached row is refetched once it is older than
  // this. Lazy reads beyond that window fall through to a one-shot fetch.
  EVENTS_WEATHER_FRESHNESS_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(3 * 60 * 60 * 1000),
  EVENTS_WEATHER_REFRESH_ENABLED: z.coerce.boolean().default(true),

  // HMAC key for short-lived realtime channel tokens (Phase 4). The Worker
  // mints a token after the read-authorization check; the RealtimeHub
  // Durable Object verifies it on WebSocket connect/refresh. Required in
  // production; dev default supplied post-parse.
  REALTIME_TOKEN_HMAC_KEY: z.string().min(32).optional(),

  // Build metadata — set by the Dockerfile at image-build time.
  BUILD_VERSION: z.string().default('dev'),
  BUILD_COMMIT: z.string().default('dev'),
})

type ParsedEnv = z.infer<typeof EnvSchema>

// Resolved env — the fields below are mandatory at the consumption
// boundary, so the resolver fills them in (DB-url fallback, prod/dev
// secret + cookie-name derivation) and strips their optionality so
// callers can treat them as non-optional.
export type Env = Omit<
  ParsedEnv,
  | 'EVENTS_API_KEY'
  | 'EVENTS_SESSION_KEY_V1'
  | 'REALTIME_TOKEN_HMAC_KEY'
  | 'EVENTS_SESSION_COOKIE_NAME'
  | 'EVENTS_CSRF_COOKIE_NAME'
  | 'EVENTS_SSO_STATE_COOKIE_NAME'
> & {
  EVENTS_API_KEY: string
  EVENTS_SESSION_KEY_V1: string
  REALTIME_TOKEN_HMAC_KEY: string
  EVENTS_SESSION_COOKIE_NAME: string
  EVENTS_CSRF_COOKIE_NAME: string
  EVENTS_SSO_STATE_COOKIE_NAME: string
}

// Dev-only fallbacks for the required secrets. Production refuses to boot
// without explicit values; dev/test get a fixed stand-in so the local stack
// and the test suite run unconfigured. Must match the local dev stack and
// .env.example so the SSO exchange works even when an app is started
// outside the dev stack (RPID and events-api must present the SAME key or RPID
// 403s the exchange).
const DEV_API_KEY = 'dev-events-api-key-do-not-use-in-production-32+chars'
const DEV_SESSION_KEY_V1 = 'dev-events-session-key-v1-000000000000'
const DEV_REALTIME_TOKEN_HMAC_KEY = 'dev-realtime-token-hmac-key-0000000000000'
// Dev default for the Planner BFF key (Slice 2). In production the key
// is supplied explicitly or left absent (namespace 404s — intentional).
const DEV_PLANNER_API_KEY = 'dev-planner-api-key-do-not-use-in-production-32+chars'

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

  const apiKey = parsed.EVENTS_API_KEY ?? (isProd ? undefined : DEV_API_KEY)
  const sessionKeyV1 =
    parsed.EVENTS_SESSION_KEY_V1 ?? (isProd ? undefined : DEV_SESSION_KEY_V1)
  const realtimeKey =
    parsed.REALTIME_TOKEN_HMAC_KEY ?? (isProd ? undefined : DEV_REALTIME_TOKEN_HMAC_KEY)
  if (!apiKey || !sessionKeyV1 || !realtimeKey) {
    const missing = [
      !apiKey ? 'EVENTS_API_KEY' : null,
      !sessionKeyV1 ? 'EVENTS_SESSION_KEY_V1' : null,
      !realtimeKey ? 'REALTIME_TOKEN_HMAC_KEY' : null,
    ]
      .filter(Boolean)
      .join(', ')
    throw new Error(`Invalid environment configuration:\n  ${missing}: required in production`)
  }

  return {
    ...parsed,
    EVENTS_API_KEY: apiKey,
    EVENTS_SESSION_KEY_V1: sessionKeyV1,
    REALTIME_TOKEN_HMAC_KEY: realtimeKey,
    EVENTS_SESSION_COOKIE_NAME:
      parsed.EVENTS_SESSION_COOKIE_NAME ??
      (isProd ? '__Host-rpe_session' : 'rpe_session'),
    EVENTS_CSRF_COOKIE_NAME:
      parsed.EVENTS_CSRF_COOKIE_NAME ?? (isProd ? '__Host-rpe_csrf' : 'rpe_csrf'),
    EVENTS_SSO_STATE_COOKIE_NAME:
      parsed.EVENTS_SSO_STATE_COOKIE_NAME ??
      (isProd ? '__Host-rpe_sso_state' : 'rpe_sso_state'),
    // Planner key: undefined in prod when not configured → namespace 404s.
    // Dev gets a fixed stand-in so the local stack and tests have a working key.
    PLANNER_API_KEY: parsed.PLANNER_API_KEY ?? (isProd ? undefined : DEV_PLANNER_API_KEY),
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
