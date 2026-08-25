import { z } from 'zod'

// Single source of truth for the Rallypoint Planner API
// environment-variable contract. Mirrors apps/money-api: lean, and
// namespaced under PLANNER_ so the services can share a host shell
// (the local dev stack) without clobbering each other's vars.

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8084),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // The hosted Planner UI origin. Backs the UI CORS split described
  // in docs/design/api-namespaces-cors.md. Namespaced to avoid the
  // RPID `UI_ORIGIN` collision when multiple services run on one host.
  PLANNER_UI_ORIGIN: z.string().url().default('http://localhost:5177'),

  // The D1 database is a Worker binding (env.DB), not a connection-string
  // env var — see src/repos/d1/db.ts. No PLANNER_DATABASE_URL in the
  // native-Cloudflare build.

  // Rallypoint ID UI origin (browser-facing). The id-api / lists-api /
  // events-api server-to-server origins moved off HTTP in PR 3 of
  // feat/rpc-bindings — planner-api now reaches the three producers
  // through their `Service<XRPC>` bindings.
  RPID_UI_URL: z.string().url().default('http://localhost:5173'),

  // The fitness integration (My Day "today's training") moved to the
  // FitnessRPC binding when fitness-api caught up to feat/rpc-bindings —
  // FITNESS_API_URL and PLANNER_API_KEY (the last *_API_KEY var) are gone.

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

  // Symmetric key material for sealing the RPID session bearer at rest
  // (crypto/encryption.ts). Active version is PLANNER_SESSION_KEY_VERSION;
  // rows store the version they were sealed under so a rotation can add
  // V2 while V1 rows still decrypt. Required in production; dev default
  // supplied post-parse.
  PLANNER_SESSION_KEY_V1: z.string().min(32).optional(),
  PLANNER_SESSION_KEY_VERSION: z.coerce.number().int().min(1).default(1),

  // Cookie names. Optional → derived from NODE_ENV post-parse:
  // production gets the __Host- prefix; dev drops it because __Host-
  // cookies are silently refused over http://localhost.
  PLANNER_SESSION_COOKIE_NAME: z.string().min(1).optional(),
  PLANNER_CSRF_COOKIE_NAME: z.string().min(1).optional(),
  PLANNER_SSO_STATE_COOKIE_NAME: z.string().min(1).optional(),

  // VAPID keys for Web Push (planner-owned notifications). The public key
  // is the browser applicationServerKey (served to planner-web at runtime
  // via GET /api/v1/push/public-key); the private key signs the VAPID JWT
  // and is a secret. Subject is the contact URI (mailto:/https). Required in
  // production; dev defaults supplied post-parse so the local stack boots.
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  VAPID_SUBJECT: z.string().min(1).optional(),

  // AI Gateway id for the AI Assist Workers AI call (routes/assist.ts).
  // When set, `ai.run` routes through the named Cloudflare AI Gateway
  // (logging / caching / cost visibility); unset (local dev) → the call
  // goes straight to Workers AI. Mirrors fitness-api's AI_GATEWAY_ID.
  AI_GATEWAY_ID: z.string().min(1).optional(),

  // Workers AI model override for AI Assist. Unset → lib/assist.ts's
  // ASSIST_MODEL default (Mistral Small 3.1). Exists so a smaller open
  // model can be A/B'd for latency on QA with a config flip — never a
  // Meta/xAI model (policy).
  ASSIST_MODEL: z.string().min(1).optional(),

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

  // Offline-grace window (E4 O2): when id-api's /sdk/session/verify is
  // unreachable, the session middleware silently accepts a request if
  // the row's last_verified_at is within this many hours. 0 disables
  // grace entirely (back to the old "503 on transport error" semantics).
  // Default 24h matches the planner's "stay usable on the train" UX
  // requirement; per-user override is intentionally deferred to v2.
  SESSION_OFFLINE_TTL_HOURS: z.coerce.number().int().min(0).max(72).default(24),
})

type ParsedEnv = z.infer<typeof EnvSchema>

// Resolved env — the fields below are mandatory at the consumption
// boundary, so the resolver fills them in (prod/dev secret + cookie-name
// derivation) and strips their optionality.
export type Env = Omit<
  ParsedEnv,
  | 'PLANNER_SESSION_KEY_V1'
  | 'PLANNER_SESSION_COOKIE_NAME'
  | 'PLANNER_CSRF_COOKIE_NAME'
  | 'PLANNER_SSO_STATE_COOKIE_NAME'
  | 'VAPID_PUBLIC_KEY'
  | 'VAPID_PRIVATE_KEY'
  | 'VAPID_SUBJECT'
> & {
  PLANNER_SESSION_KEY_V1: string
  PLANNER_SESSION_COOKIE_NAME: string
  PLANNER_CSRF_COOKIE_NAME: string
  PLANNER_SSO_STATE_COOKIE_NAME: string
  VAPID_PUBLIC_KEY: string
  VAPID_PRIVATE_KEY: string
  VAPID_SUBJECT: string
}

const DEV_SESSION_KEY_V1 = 'dev-planner-session-key-v1-0000000000000'

// Dev-only VAPID keypair (P-256). Local-stack stand-in so Web Push works
// end-to-end without provisioning real keys; production refuses to boot
// without explicit VAPID_* secrets. NOT a secret — regenerate for any real
// deployment with `npx tsx scripts/gen-vapid-keys.ts`.
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
    parsed.PLANNER_SESSION_KEY_V1 ?? (isProd ? undefined : DEV_SESSION_KEY_V1)
  const vapidPublicKey = parsed.VAPID_PUBLIC_KEY ?? (isProd ? undefined : DEV_VAPID_PUBLIC_KEY)
  const vapidPrivateKey = parsed.VAPID_PRIVATE_KEY ?? (isProd ? undefined : DEV_VAPID_PRIVATE_KEY)
  const vapidSubject = parsed.VAPID_SUBJECT ?? (isProd ? undefined : DEV_VAPID_SUBJECT)
  if (!sessionKeyV1 || !vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    const missing = [
      !sessionKeyV1 ? 'PLANNER_SESSION_KEY_V1' : null,
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
    PLANNER_SESSION_KEY_V1: sessionKeyV1,
    VAPID_PUBLIC_KEY: vapidPublicKey,
    VAPID_PRIVATE_KEY: vapidPrivateKey,
    VAPID_SUBJECT: vapidSubject,
    PLANNER_SESSION_COOKIE_NAME:
      parsed.PLANNER_SESSION_COOKIE_NAME ?? (isProd ? '__Host-rpp_session' : 'rpp_session'),
    PLANNER_CSRF_COOKIE_NAME:
      parsed.PLANNER_CSRF_COOKIE_NAME ?? (isProd ? '__Host-rpp_csrf' : 'rpp_csrf'),
    PLANNER_SSO_STATE_COOKIE_NAME:
      parsed.PLANNER_SSO_STATE_COOKIE_NAME ??
      (isProd ? '__Host-rpp_sso_state' : 'rpp_sso_state'),
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
