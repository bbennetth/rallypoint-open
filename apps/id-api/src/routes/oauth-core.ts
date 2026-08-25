import { ulid } from 'ulid'
import {
  ANTI_FINGERPRINT_NOT_FOUND,
  TENANT_DEFAULT,
  type UserId,
} from '@rallypoint/shared'
import { hashToken, constantTimeEqual } from '@rallypoint/crypto'
import { ApiError } from '../errors.js'
import { normalizeEmail } from '../lib/normalize-email.js'
import { resolveReturnTo } from '../lib/safe-return-to.js'
import { dailySalt, hashIp, hashUserAgent } from '../crypto/ip-hash.js'
import { issueSession } from '../session/issue.js'
import { UniqueConstraintError } from '@rallypoint/api-kit'
import {
  generateStateToken,
  generateNonce,
  generateCodeVerifier,
  codeChallengeS256,
  generateBrowserBind,
} from '../crypto/oauth-pkce.js'
import type { Repos } from '../repos/types.js'
import type { OAuthProviderSlug } from '../repos/oauth-identity.js'
import type { OAuthStateRecord } from '../repos/oauth-state.js'
import type { OAuthProviders } from '../services/oauth/index.js'
import type { NormalizedIdentity } from '../services/oauth/types.js'
import type { Logger } from '../logger.js'

// Provider-agnostic OAuth start/callback logic, kept out of the Hono
// layer so it can be tested with a stubbed provider. The route glue only
// translates the outcomes into a redirect + Set-Cookie.

const STATE_TTL_MS = 10 * 60 * 1000

export interface OAuthCoreDeps {
  repos: Repos
  providers: OAuthProviders
  sessionHmacKey: string
  argon2PepperKey: string
  uiOrigin: string
  redirectBaseUrl: string
  allowedReturnHosts: string[]
  now?: () => Date
  logger?: Logger
  tenantId?: string
}

function notFound(): ApiError {
  return new ApiError({ ...ANTI_FINGERPRINT_NOT_FOUND, status: 404 })
}

function redirectUriFor(deps: OAuthCoreDeps, provider: OAuthProviderSlug): string {
  return `${deps.redirectBaseUrl.replace(/\/$/, '')}/api/v1/oauth/${provider}/callback`
}

// --- start ----------------------------------------------------------
export interface StartInput {
  provider: string
  returnTo: string | null
  link: boolean
  sessionUserId: UserId | null
}

export interface StartOutcome {
  authorizeUrl: string
  bindCookieValue: string
}

export async function runOAuthStart(deps: OAuthCoreDeps, input: StartInput): Promise<StartOutcome> {
  const provider = deps.providers.get(input.provider as OAuthProviderSlug)
  if (!provider) throw notFound()
  const tenantId = deps.tenantId ?? TENANT_DEFAULT
  const now = deps.now ?? (() => new Date())

  const returnTo = resolveReturnTo(input.returnTo, {
    uiOrigin: deps.uiOrigin,
    allowedHosts: deps.allowedReturnHosts,
  })
  const state = generateStateToken()
  const nonce = generateNonce()
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await codeChallengeS256(codeVerifier)
  const bind = generateBrowserBind()

  await deps.repos.oauthStates.create({
    stateHash: hashToken(state),
    tenantId,
    provider: provider.slug,
    codeVerifier,
    nonce,
    returnTo,
    linkUserId: input.link && input.sessionUserId ? input.sessionUserId : null,
    browserBindHash: hashToken(bind),
    expiresAt: new Date(now().getTime() + STATE_TTL_MS),
  })

  const authorizeUrl = provider.buildAuthorizeUrl({
    state,
    codeChallenge,
    nonce,
    redirectUri: redirectUriFor(deps, provider.slug),
  })
  return { authorizeUrl, bindCookieValue: bind }
}

// --- callback -------------------------------------------------------
export interface CallbackInput {
  provider: string
  code: string | null
  state: string | null
  bindCookie: string | null
  error: string | null
  appleUser: string | null // Apple first-auth `user` form field (JSON)
  ipAddress: string
  userAgent: string
}

export type CallbackOutcome =
  | { kind: 'success'; location: string; sessionToken: string }
  | { kind: 'error'; location: string }

class OAuthResolveError extends Error {
  constructor(public readonly errorCode: string) {
    super(errorCode)
  }
}

export async function runOAuthCallback(
  deps: OAuthCoreDeps,
  input: CallbackInput,
): Promise<CallbackOutcome> {
  const provider = deps.providers.get(input.provider as OAuthProviderSlug)
  if (!provider) throw notFound()
  const now = deps.now ?? (() => new Date())
  const uiBase = deps.uiOrigin.replace(/\/$/, '')
  const errorOut = (code: string): CallbackOutcome => ({
    kind: 'error',
    location: `${uiBase}/signin?error=${encodeURIComponent(code)}`,
  })

  if (input.error) return errorOut('provider_denied')
  if (!input.state || !input.code || !input.bindCookie) return errorOut('invalid_request')

  const stateHash = hashToken(input.state)
  const row = await deps.repos.oauthStates.findByHash(stateHash)
  if (
    !row ||
    row.provider !== provider.slug ||
    row.consumedAt ||
    row.expiresAt.getTime() < now().getTime()
  ) {
    return errorOut('invalid_state')
  }
  // Login-CSRF defense: the callback must present the same browser-bound
  // cookie set at /start. An attacker-initiated flow can't (their cookie
  // lives in their browser, not the victim's).
  if (!constantTimeEqual(row.browserBindHash, hashToken(input.bindCookie))) {
    return errorOut('invalid_state')
  }
  if (!(await deps.repos.oauthStates.markConsumed(stateHash, now()))) return errorOut('invalid_state')

  let identity: NormalizedIdentity
  try {
    identity = await provider.exchangeAndFetchIdentity({
      code: input.code,
      codeVerifier: row.codeVerifier,
      redirectUri: redirectUriFor(deps, provider.slug),
      nonce: row.nonce,
    })
  } catch (err: unknown) {
    deps.logger?.warn(
      { err: err instanceof Error ? err.message : String(err), provider: provider.slug },
      'oauth exchange failed',
    )
    return errorOut('provider_error')
  }

  if (provider.slug === 'apple' && input.appleUser) applyAppleName(identity, input.appleUser)

  let userId: UserId
  try {
    userId = await resolveUser(deps, identity, row, now())
  } catch (err: unknown) {
    if (err instanceof OAuthResolveError) return errorOut(err.errorCode)
    // Unverified-email collision with an existing account: don't auto-merge.
    if (err instanceof UniqueConstraintError) return errorOut('account_exists')
    throw err
  }

  const user = await deps.repos.users.findById(userId)
  if (!user) return errorOut('account_error')

  const salt = dailySalt(deps.argon2PepperKey, now())
  const { rawToken } = await issueSession(deps.repos.sessions, {
    userId: user.id,
    tenantId: user.tenantId,
    ipHash: hashIp(input.ipAddress, salt),
    uaHash: hashUserAgent(input.userAgent),
    sessionHmacKey: deps.sessionHmacKey,
    now,
  })

  deps.repos.audit
    .write({
      tenantId: user.tenantId,
      eventType: 'oauth.signin.success',
      userId: user.id,
      ipHash: hashIp(input.ipAddress, salt),
      uaHash: hashUserAgent(input.userAgent),
      meta: { provider: provider.slug },
    })
    .catch((e: unknown) =>
      deps.logger?.warn({ err: e instanceof Error ? e.message : String(e) }, 'oauth audit failed'),
    )

  return { kind: 'success', location: row.returnTo, sessionToken: rawToken }
}

// resolve-or-create-or-link, in the order the plan locks in.
async function resolveUser(
  deps: OAuthCoreDeps,
  identity: NormalizedIdentity,
  row: OAuthStateRecord,
  now: Date,
): Promise<UserId> {
  const tenantId = deps.tenantId ?? TENANT_DEFAULT

  // 1. Known identity → that account (idempotent sign-in).
  const existing = await deps.repos.oauthIdentities.findByProviderSubject(
    tenantId,
    identity.provider,
    identity.subject,
  )
  if (existing) {
    // If this is a link flow but the provider account is already tied to a
    // DIFFERENT Rallypoint account, refuse rather than silently switching
    // the signed-in user into that other account.
    if (row.linkUserId && existing.userId !== row.linkUserId) {
      throw new OAuthResolveError('identity_already_linked')
    }
    await deps.repos.oauthIdentities.touchLastUsed(existing.id, now)
    return existing.userId
  }

  const email = identity.email ? normalizeEmail(identity.email) : null

  // 2. Link flow → attach to the signed-in user.
  if (row.linkUserId) {
    await deps.repos.oauthIdentities.create({
      id: ulid(),
      userId: row.linkUserId,
      tenantId,
      provider: identity.provider,
      subject: identity.subject,
      email,
      emailVerified: identity.emailVerified,
    })
    return row.linkUserId
  }

  // 3. Auto-link when the provider-VERIFIED email matches an account whose
  // OWN email is ALSO verified. Requiring the local account to be verified
  // blocks account pre-hijacking: an attacker who registered an unverified
  // shell under the victim's email must not have it silently claimed when
  // the victim later signs in with the provider. An unverified local match
  // falls through to step 4 → email collision → `account_exists`.
  if (email && identity.emailVerified) {
    const user = await deps.repos.users.findByEmail(tenantId, email)
    if (user && user.emailVerified) {
      await deps.repos.oauthIdentities.create({
        id: ulid(),
        userId: user.id,
        tenantId,
        provider: identity.provider,
        subject: identity.subject,
        email,
        emailVerified: true,
      })
      return user.id
    }
  }

  // 4. New account. Needs an email (users.email is NOT NULL + the login
  // identifier). An unverified-email collision throws UniqueConstraintError
  // → the caller redirects with account_exists rather than auto-merging.
  if (!email) throw new OAuthResolveError('no_email')
  const userId = `user_${ulid()}` as UserId
  const username = identity.name ?? email.split('@')[0] ?? 'Rallypoint user'
  await deps.repos.userAuth.createUserWithOAuthIdentity(
    {
      id: userId,
      tenantId,
      email,
      username,
      firstName: identity.firstName ?? null,
      lastName: identity.lastName ?? null,
      emailVerified: identity.emailVerified,
    },
    {
      id: ulid(),
      tenantId,
      provider: identity.provider,
      subject: identity.subject,
      email,
      emailVerified: identity.emailVerified,
    },
  )
  return userId
}

function applyAppleName(identity: NormalizedIdentity, appleUserJson: string): void {
  try {
    const parsed = JSON.parse(appleUserJson) as { name?: { firstName?: string; lastName?: string } }
    const first = parsed.name?.firstName ?? null
    const last = parsed.name?.lastName ?? null
    if (first) identity.firstName = first
    if (last) identity.lastName = last
    const full = [first, last].filter(Boolean).join(' ')
    if (full) identity.name = full
  } catch {
    // Malformed user field — ignore, keep the id_token-derived identity.
  }
}
