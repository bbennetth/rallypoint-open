import { z } from 'zod'

// Single source of truth for the Rallypoint Admin API environment-variable
// contract. Mirrors apps/fitness-api/src/env.ts: lean, namespaced under
// ADMIN_ so the services can share a host shell (the local dev stack)
// without clobbering each other's vars.

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8087),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // The hosted Admin UI origin. Backs the UI CORS split described in
  // docs/design/api-namespaces-cors.md.
  ADMIN_UI_ORIGIN: z.string().url().default('http://localhost:5179'),

  // Rallypoint ID UI origin (browser-facing redirects). The server-to-server
  // RPID hop rides the typed `Service<IdRPC>` binding (feat/rpc-bindings).
  RPID_UI_URL: z.string().url().default('http://localhost:5173'),

  // Comma-separated allowlist of RPID user ids permitted past requireAdmin.
  // Empty/absent = nobody (a valid session alone never grants admin). A
  // secret-class value in qa/prod (pushed via `wrangler secret bulk`), a
  // .dev.vars line locally.
  ADMIN_USER_IDS: z.string().default(''),

  // Trust policy for IP-extraction headers (#33). See the sibling apps'
  // env.ts for the full option table; Cloudflare deploys set
  // 'cf-connecting-ip' via wrangler.toml.
  TRUSTED_PROXY_HEADER: z
    .enum(['legacy', 'xff', 'cf-connecting-ip', 'none'])
    .default('legacy'),

  // Symmetric key material for sealing the RPID session bearer at rest
  // (crypto/encryption.ts). Active version is ADMIN_SESSION_KEY_VERSION;
  // rows store the version they were sealed under so a rotation can add V2
  // while V1 rows still decrypt. Required in production; dev default
  // supplied post-parse.
  ADMIN_SESSION_KEY_V1: z.string().min(32).optional(),
  ADMIN_SESSION_KEY_VERSION: z.coerce.number().int().min(1).default(1),

  // Cookie names. Optional → derived from NODE_ENV post-parse: production
  // gets the __Host- prefix; dev drops it because __Host- cookies are
  // silently refused over http://localhost.
  // Cookie acronym: rpa (Rallypoint Admin).
  ADMIN_SESSION_COOKIE_NAME: z.string().min(1).optional(),
  ADMIN_CSRF_COOKIE_NAME: z.string().min(1).optional(),
  ADMIN_SSO_STATE_COOKIE_NAME: z.string().min(1).optional(),

  // PostHog server-side error tracking. The project API key is a public
  // `phc_…` write key, so it lives in wrangler.toml [vars], not secrets.
  // Unset (local dev/FOSS) → exception capture is a no-op.
  POSTHOG_KEY: z.string().min(1).optional(),
  POSTHOG_HOST: z.string().url().optional(),
  // Deploy target (qa/prod) — becomes the OTel
  // `deployment.environment` resource attribute on forwarded logs.
  // QA and prod share one PostHog project, so without it their logs
  // are indistinguishable. Unset locally.
  DEPLOY_ENV: z.enum(['qa', 'prod']).optional(),

  // Build metadata.
  BUILD_VERSION: z.string().default('dev'),
  BUILD_COMMIT: z.string().default('dev'),
})

type ParsedEnv = z.infer<typeof EnvSchema>

// Resolved env — the fields below are mandatory at the consumption
// boundary, so the resolver fills them in (prod/dev secret + cookie-name
// derivation) and strips their optionality.
export type Env = Omit<
  ParsedEnv,
  | 'ADMIN_SESSION_KEY_V1'
  | 'ADMIN_SESSION_COOKIE_NAME'
  | 'ADMIN_CSRF_COOKIE_NAME'
  | 'ADMIN_SSO_STATE_COOKIE_NAME'
> & {
  ADMIN_SESSION_KEY_V1: string
  ADMIN_SESSION_COOKIE_NAME: string
  ADMIN_CSRF_COOKIE_NAME: string
  ADMIN_SSO_STATE_COOKIE_NAME: string
}

// Dev-only fallback for the required secret. Production refuses to boot
// without an explicit value; dev/test get a fixed stand-in so the local
// stack and the test suite run unconfigured.
const DEV_SESSION_KEY_V1 = 'dev-admin-session-key-v1-000000000000000'

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
    parsed.ADMIN_SESSION_KEY_V1 ?? (isProd ? undefined : DEV_SESSION_KEY_V1)
  if (!sessionKeyV1) {
    throw new Error(
      'Invalid environment configuration:\n  ADMIN_SESSION_KEY_V1: required in production',
    )
  }

  return {
    ...parsed,
    ADMIN_SESSION_KEY_V1: sessionKeyV1,
    ADMIN_SESSION_COOKIE_NAME:
      parsed.ADMIN_SESSION_COOKIE_NAME ?? (isProd ? '__Host-rpa_session' : 'rpa_session'),
    ADMIN_CSRF_COOKIE_NAME:
      parsed.ADMIN_CSRF_COOKIE_NAME ?? (isProd ? '__Host-rpa_csrf' : 'rpa_csrf'),
    ADMIN_SSO_STATE_COOKIE_NAME:
      parsed.ADMIN_SSO_STATE_COOKIE_NAME ??
      (isProd ? '__Host-rpa_sso_state' : 'rpa_sso_state'),
  }
}

// Lazy memoized accessor for boot code; tests construct an Env directly via
// parseEnv() against an explicit source object.
let _env: Env | null = null
export function getEnv(): Env {
  _env ??= parseEnv()
  return _env
}
export function _resetEnvCacheForTests(): void {
  _env = null
}
