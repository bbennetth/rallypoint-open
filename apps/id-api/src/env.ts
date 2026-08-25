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
  // Default 'cf-connecting-ip': every deploy target is now a Cloudflare
  // Worker (epic #313) sitting directly behind Cloudflare's edge, so
  // cf-connecting-ip is always the correct, non-spoofable client IP —
  // there is no other reverse proxy in front of it. The old 'legacy'
  // default (leftmost XFF, falling back to cf-connecting-ip) predates
  // the CF migration and trusted a client-spoofable header by default.
  // Operators on bare-metal-public-internet should switch to 'none' (or
  // front the API with a proxy that strips client-supplied XFF).
  TRUSTED_PROXY_HEADER: z
    .enum(['legacy', 'xff', 'cf-connecting-ip', 'none'])
    .default('cf-connecting-ip'),

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

  // DEV-ONLY 2FA bypass. When set, every issued + resent 2FA code is
  // forced to this constant value instead of a random 6-digit string,
  // so dev loops don't have to grep the [id-api] log for the
  // MAILER=log'd code on every signin. The HMAC compare path is
  // unchanged — the override just narrows the secret space. NEVER set
  // this in qa/prod; absent (the default) restores the real generator.
  DEV_SIGNIN_CODE_OVERRIDE: z.string().optional(),

  // DEV-ONLY: when "true", new signups skip the email-verification
  // step entirely (the user lands as email_verified=true with no
  // verification email sent). Pairs with DEV_SIGNIN_CODE_OVERRIDE so
  // `dev:stack` + `dev:seed` can stand up demo accounts with a single
  // step. NEVER set in qa/prod; absent (the default) restores the
  // real verify-email flow.
  //
  // Schema shape: `.literal('true').optional().transform(...)` so the
  // parsed type is `true | undefined` (NOT `boolean`). Absent →
  // undefined → route-layer conditional spread omits the ctx field
  // entirely, mirroring DEV_SIGNIN_CODE_OVERRIDE. A literal `'false'`
  // is rejected by the schema — opt-in only, matching the intent of
  // a one-way dev override.
  DEV_AUTO_VERIFY_EMAIL: z
    .literal('true')
    .optional()
    .transform((v) => (v === 'true' ? true : undefined)),

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

  // SSO_MONEY_HOST — bare host for the Rallypoint Money web client.
  // Mirrors SSO_LISTS_HOST; gates mint with client='money'.
  // Dev: localhost:5176. Prod: money.rallypt.app.
  SSO_MONEY_HOST: z.string().min(1).optional(),

  // SSO_PLANNER_HOST — bare host for the Rallypoint Planner web client.
  // Mirrors SSO_MONEY_HOST; gates mint with client='planner'.
  // Dev: localhost:5177. Prod: planner.rallypt.app.
  SSO_PLANNER_HOST: z.string().min(1).optional(),

  // SSO_FITNESS_HOST — bare host for the Rallypoint Fitness web client.
  // Mirrors SSO_PLANNER_HOST; gates mint with client='fitness'.
  // Dev: localhost:5178. Prod: health.rallypt.app.
  SSO_FITNESS_HOST: z.string().min(1).optional(),

  // SSO_ADMIN_HOST — bare host for the Rallypoint Admin web client.
  // Mirrors SSO_FITNESS_HOST; gates mint with client='admin'.
  // Dev: localhost:5179. Prod: admin.rallypt.app.
  SSO_ADMIN_HOST: z.string().min(1).optional(),

  // SSO_HINT_COOKIE_DOMAIN — parent domain for the JS-readable rp_sso
  // hint cookie (#369). App-web subdomains read this to decide whether
  // to attempt silent SSO. Omit the attribute when undefined/empty (dev
  // localhost: browsers ignore port, cookie still crosses dev ports).
  // Prod: .rallypt.app  QA: .rallypt.dev
  SSO_HINT_COOKIE_DOMAIN: z.string().min(1).optional(),

  // WebAuthn / passkeys. RP_ID is the registrable domain the credential
  // is scoped to (the browser requires it to be a suffix of the page
  // origin's host). ORIGIN(s) is the comma-separated allowlist checked
  // against clientDataJSON.origin. Both default off UI_ORIGIN so local
  // dev (localhost:5173 → rpId 'localhost') works with no config; prod
  // sets WEBAUTHN_RP_ID=id.rallypt.app + WEBAUTHN_ORIGIN=https://id.rallypt.app.
  WEBAUTHN_RP_ID: z.string().min(1).optional(),
  WEBAUTHN_RP_NAME: z.string().min(1).default('Rallypoint ID'),
  WEBAUTHN_ORIGIN: z.string().min(1).optional(),

  // Social sign-in (OAuth/OIDC). MASTER SWITCH — defaults OFF. Social
  // login stays fully disabled (no providers, /oauth/* routes 404, the UI
  // shows no social buttons) until this is 'true', REGARDLESS of whether
  // provider credentials happen to be set. Flip to 'true' per-env once the
  // provider backends (registered OAuth apps + redirect URIs) are ready;
  // then each provider additionally turns on only when ITS credentials are
  // present, so you can bring providers up one at a time. Passkeys are
  // unaffected by this flag.
  SOCIAL_SIGNIN_ENABLED: z.enum(['true', 'false']).default('false'),

  // A provider is ENABLED only when its client credentials are set (AND the
  // master switch above is on) — absent = the /oauth/<provider>/* routes
  // 404 (same anti-fingerprint envelope as an unknown route). All are
  // secrets pushed via `wrangler secret bulk`; none has a dev default, so
  // social login is dark in local dev until real credentials are supplied.
  // OAUTH_REDIRECT_BASE_URL builds each redirect_uri; defaults to
  // PUBLIC_BASE_URL (id-api == id-web origin in qa/prod).
  OAUTH_REDIRECT_BASE_URL: z.string().url().optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  APPLE_OAUTH_CLIENT_ID: z.string().min(1).optional(), // the Services ID
  APPLE_OAUTH_TEAM_ID: z.string().min(1).optional(),
  APPLE_OAUTH_KEY_ID: z.string().min(1).optional(),
  APPLE_OAUTH_PRIVATE_KEY: z.string().min(1).optional(), // .p8 PKCS8 PEM

  // Object storage (avatar uploads) is a native R2 binding
  // (env.OBJECT_STORE), wired in services/index.ts from the
  // wrangler.toml [[r2_buckets]] binding — no endpoint/region/keys as
  // string config (#409).

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

  // Build metadata — set by the Dockerfile at image-build time
  BUILD_VERSION: z.string().default('dev'),
  BUILD_COMMIT: z.string().default('dev'),
})

type ParsedEnv = z.infer<typeof EnvSchema>

// SESSION_COOKIE_NAME is required at the consumption boundary
// (handlers read c.var.env.SESSION_COOKIE_NAME), so we strip the
// optionality after deriving it.
export type Env = Omit<
  ParsedEnv,
  'SESSION_COOKIE_NAME' | 'CSRF_COOKIE_NAME' | 'WEBAUTHN_RP_ID' | 'WEBAUTHN_ORIGIN'
> & {
  SESSION_COOKIE_NAME: string
  CSRF_COOKIE_NAME: string
  WEBAUTHN_RP_ID: string
  WEBAUTHN_ORIGIN: string
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
  // Derive the WebAuthn RP id / origin off UI_ORIGIN when unset (dev).
  let uiHost = 'localhost'
  try {
    uiHost = new URL(parsed.UI_ORIGIN).hostname
  } catch {
    // UI_ORIGIN is url-validated by zod, so this should be unreachable.
  }
  return {
    ...parsed,
    SESSION_COOKIE_NAME:
      parsed.SESSION_COOKIE_NAME ?? (isProd ? '__Host-rp_session' : 'rp_session'),
    CSRF_COOKIE_NAME:
      parsed.CSRF_COOKIE_NAME ?? (isProd ? '__Host-rp_csrf' : 'rp_csrf'),
    WEBAUTHN_RP_ID: parsed.WEBAUTHN_RP_ID ?? uiHost,
    WEBAUTHN_ORIGIN: parsed.WEBAUTHN_ORIGIN ?? parsed.UI_ORIGIN,
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
