import { z } from 'zod'

// Single source of truth for the Rallypoint Fitness API
// environment-variable contract. Mirrors apps/money-api/src/env.ts:
// lean, namespaced under FITNESS_ so the services can share a host shell
// (the local dev stack) without clobbering each other's vars.

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8085),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // The hosted Fitness UI origin. Backs the UI/SDK CORS split described
  // in docs/design/api-namespaces-cors.md. Namespaced to avoid the
  // RPID `UI_ORIGIN` collision when multiple services run on one host.
  FITNESS_UI_ORIGIN: z.string().url().default('http://localhost:5178'),
  SDK_CORS_ALLOWED_ORIGINS: z.string().default(''),

  // Rallypoint ID UI origin (browser-facing redirects). The
  // server-to-server RPID origin is gone — fitness-api reaches id-api
  // through the typed `Service<IdRPC>` binding (feat/rpc-bindings).
  RPID_UI_URL: z.string().url().default('http://localhost:5173'),

  // Trust policy for IP-extraction headers (#33).
  //   legacy           — current behavior: leftmost XFF, then
  //                       cf-connecting-ip, then 0.0.0.0. Safe
  //                       behind a single trusted reverse proxy.
  //   xff              — strict: leftmost XFF only, no fallback
  //                       to cf-connecting-ip.
  //   cf-connecting-ip — Cloudflare deploys: ignore XFF, use
  //                       cf-connecting-ip exclusively.
  //   none             — no proxy at all (rare).
  TRUSTED_PROXY_HEADER: z
    .enum(['legacy', 'xff', 'cf-connecting-ip', 'none'])
    .default('legacy'),

  // The FITNESS_API_KEY / PLANNER_API_KEY bearer pair is gone: both the
  // fitness→RPID hop and the Planner→fitness hop moved to typed
  // WorkerEntrypoint RPC bindings (feat/rpc-bindings catch-up).

  // Symmetric key material for sealing the RPID session bearer at rest
  // (crypto/encryption.ts). Active version is FITNESS_SESSION_KEY_VERSION;
  // rows store the version they were sealed under so a rotation can add
  // V2 while V1 rows still decrypt. Required in production; dev default
  // supplied post-parse.
  FITNESS_SESSION_KEY_V1: z.string().min(32).optional(),
  FITNESS_SESSION_KEY_VERSION: z.coerce.number().int().min(1).default(1),

  // Cookie names. Optional → derived from NODE_ENV post-parse:
  // production gets the __Host- prefix; dev drops it because __Host-
  // cookies are silently refused over http://localhost.
  // Cookie acronym: rft (Rallypoint Fitness).
  FITNESS_SESSION_COOKIE_NAME: z.string().min(1).optional(),
  FITNESS_CSRF_COOKIE_NAME: z.string().min(1).optional(),
  FITNESS_SSO_STATE_COOKIE_NAME: z.string().min(1).optional(),

  // VAPID keys for Web Push (fitness-owned rest-timer notifications).
  // The public key is the browser applicationServerKey (served to
  // fitness-web at runtime via GET /api/v1/push/public-key); the private
  // key signs the VAPID JWT and is a secret. Subject is the contact URI. Required in
  // production; dev defaults supplied post-parse (mirrors planner-api).
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  VAPID_SUBJECT: z.string().min(1).optional(),

  // Cloudflare AI Gateway id for the Workers AI vision calls (WOD +
  // food-photo scans). Optional: when set (qa/prod via wrangler.toml),
  // `env.AI.run` routes through the gateway for logging / caching / cost
  // visibility; unset (local dev) → calls hit Workers AI directly, exactly
  // as before. Just an id string, not a secret.
  AI_GATEWAY_ID: z.string().min(1).optional(),

  // USDA FoodData Central api.data.gov key — the barcode-lookup fallback
  // for Open Food Facts outages. Optional secret: unset (local dev) →
  // the FDC tier is skipped and lookups are OFF-only, exactly as before.
  FDC_API_KEY: z.string().min(1).optional(),

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
// boundary, so the resolver fills them in (prod/dev secret + cookie-name
// derivation) and strips their optionality.
export type Env = Omit<
  ParsedEnv,
  | 'FITNESS_SESSION_KEY_V1'
  | 'FITNESS_SESSION_COOKIE_NAME'
  | 'FITNESS_CSRF_COOKIE_NAME'
  | 'FITNESS_SSO_STATE_COOKIE_NAME'
  | 'VAPID_PUBLIC_KEY'
  | 'VAPID_PRIVATE_KEY'
  | 'VAPID_SUBJECT'
> & {
  FITNESS_SESSION_KEY_V1: string
  FITNESS_SESSION_COOKIE_NAME: string
  FITNESS_CSRF_COOKIE_NAME: string
  FITNESS_SSO_STATE_COOKIE_NAME: string
  VAPID_PUBLIC_KEY: string
  VAPID_PRIVATE_KEY: string
  VAPID_SUBJECT: string
}

// Dev-only fallback for the required secret. Production refuses
// to boot without an explicit value; dev/test get a fixed stand-in so
// the local stack and the test suite run unconfigured.
const DEV_SESSION_KEY_V1 = 'dev-fitness-session-key-v1-0000000000000'

// Dev-only VAPID keypair (P-256) — same class of stand-in as planner-api's:
// lets Web Push work end-to-end on the local stack without provisioning
// real keys; production refuses to boot without explicit VAPID_* secrets.
// NOT a secret — regenerate for any real deployment with
// `npx tsx scripts/gen-vapid-keys.ts`.
const DEV_VAPID_PUBLIC_KEY =
  'BMtiizjeUZ7oRAzgJkYldtNsBFin0L1VdojVUccJqDzYjoOE0mkyQJ35H-4y2A4-gASqZh1A3ae2ADWzmSw_0so'
const DEV_VAPID_PRIVATE_KEY = 'VARin9jVKIK8tfhdZNhgdOJs7vOILzNz68HkFuDS_Yk'
const DEV_VAPID_SUBJECT = 'mailto:dev@rallypt.dev'

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
    parsed.FITNESS_SESSION_KEY_V1 ?? (isProd ? undefined : DEV_SESSION_KEY_V1)
  const vapidPublicKey = parsed.VAPID_PUBLIC_KEY ?? (isProd ? undefined : DEV_VAPID_PUBLIC_KEY)
  const vapidPrivateKey =
    parsed.VAPID_PRIVATE_KEY ?? (isProd ? undefined : DEV_VAPID_PRIVATE_KEY)
  const vapidSubject = parsed.VAPID_SUBJECT ?? (isProd ? undefined : DEV_VAPID_SUBJECT)
  if (!sessionKeyV1 || !vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    const missing = [
      !sessionKeyV1 ? 'FITNESS_SESSION_KEY_V1' : null,
      !vapidPublicKey ? 'VAPID_PUBLIC_KEY' : null,
      !vapidPrivateKey ? 'VAPID_PRIVATE_KEY' : null,
      !vapidSubject ? 'VAPID_SUBJECT' : null,
    ]
      .filter(Boolean)
      .join(', ')
    throw new Error(`Invalid environment configuration:\n  ${missing}: required in production`)
  }

  return {
    ...parsed,
    FITNESS_SESSION_KEY_V1: sessionKeyV1,
    VAPID_PUBLIC_KEY: vapidPublicKey,
    VAPID_PRIVATE_KEY: vapidPrivateKey,
    VAPID_SUBJECT: vapidSubject,
    FITNESS_SESSION_COOKIE_NAME:
      parsed.FITNESS_SESSION_COOKIE_NAME ?? (isProd ? '__Host-rft_session' : 'rft_session'),
    FITNESS_CSRF_COOKIE_NAME:
      parsed.FITNESS_CSRF_COOKIE_NAME ?? (isProd ? '__Host-rft_csrf' : 'rft_csrf'),
    FITNESS_SSO_STATE_COOKIE_NAME:
      parsed.FITNESS_SSO_STATE_COOKIE_NAME ??
      (isProd ? '__Host-rft_sso_state' : 'rft_sso_state'),
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
