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

  // Rallypoint ID UI origin — the in-browser id-web SPA. Required for the
  // SSO mint flow (the browser is redirected here for sign-in).
  // The companion `RPID_API_URL` / `LISTS_API_URL` / `MONEY_API_URL`
  // server-to-server origins were retired in PR 3 of feat/rpc-bindings —
  // events-api now reaches its sibling Workers via `Service<XRPC>`
  // bindings, not HTTP.
  RPID_UI_URL: z.string().url().default('http://localhost:5173'),

  // Comma-separated user ids granted owner-equivalent access to
  // system-owned events (events whose owner is the SYSTEM_USER_ID
  // sentinel). Must be kept in lockstep with admin-api's
  // ADMIN_USER_IDS (same secret value in the deploy pipeline) —
  // drift means an admin can manage a system event via admin-web but
  // 404 on it in events-web. Empty (default) → nobody.
  ADMIN_USER_IDS: z.string().default(''),

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

  // HMAC key for short-lived realtime channel tokens (Phase 4). The Worker
  // mints a token after the read-authorization check; the RealtimeHub
  // Durable Object verifies it on WebSocket connect/refresh. Required in
  // production; dev default supplied post-parse.
  REALTIME_TOKEN_HMAC_KEY: z.string().min(32).optional(),

  // Cloudflare AI Gateway id for the lineup-ingestion extraction calls
  // (@rallypoint/ai runAiJson). Set in qa/prod wrangler vars; unset in
  // dev → direct Workers AI call, no gateway logging.
  AI_GATEWAY_ID: z.string().min(1).optional(),

  // PostHog server-side error tracking. The project API key is a public
  // `phc_…` write key (same class of value the web bundles ship), so it
  // lives in wrangler.toml [vars], not secrets. Unset (local dev/FOSS) →
  // exception capture is a no-op.
  POSTHOG_KEY: z.string().min(1).optional(),
  POSTHOG_HOST: z.string().url().optional(),
  // Deploy target (qa/prod) — becomes the OTel
  // `deployment.environment` resource attribute on forwarded logs.
  // QA and prod share one PostHog project, so without it their logs
  // are indistinguishable. Unset locally.
  DEPLOY_ENV: z.enum(['qa', 'prod']).optional(),

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
  | 'EVENTS_SESSION_KEY_V1'
  | 'REALTIME_TOKEN_HMAC_KEY'
  | 'EVENTS_SESSION_COOKIE_NAME'
  | 'EVENTS_CSRF_COOKIE_NAME'
  | 'EVENTS_SSO_STATE_COOKIE_NAME'
> & {
  EVENTS_SESSION_KEY_V1: string
  REALTIME_TOKEN_HMAC_KEY: string
  EVENTS_SESSION_COOKIE_NAME: string
  EVENTS_CSRF_COOKIE_NAME: string
  EVENTS_SSO_STATE_COOKIE_NAME: string
}

// Dev-only fallbacks for the required secrets. Production refuses to boot
// without explicit values; dev/test get a fixed stand-in so the local stack
// and the test suite run unconfigured.
const DEV_SESSION_KEY_V1 = 'dev-events-session-key-v1-000000000000'
const DEV_REALTIME_TOKEN_HMAC_KEY = 'dev-realtime-token-hmac-key-0000000000000'

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

  const sessionKeyV1 =
    parsed.EVENTS_SESSION_KEY_V1 ?? (isProd ? undefined : DEV_SESSION_KEY_V1)
  const realtimeKey =
    parsed.REALTIME_TOKEN_HMAC_KEY ?? (isProd ? undefined : DEV_REALTIME_TOKEN_HMAC_KEY)
  if (!sessionKeyV1 || !realtimeKey) {
    const missing = [
      !sessionKeyV1 ? 'EVENTS_SESSION_KEY_V1' : null,
      !realtimeKey ? 'REALTIME_TOKEN_HMAC_KEY' : null,
    ]
      .filter(Boolean)
      .join(', ')
    throw new Error(`Invalid environment configuration:\n  ${missing}: required in production`)
  }

  return {
    ...parsed,
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
