import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UserId } from '@rallypoint/shared'
import { buildD1Repos, createDb } from '../src/repos/d1/index.js'
import type { Repos } from '../src/repos/types.js'
import { runOAuthStart, runOAuthCallback, type OAuthCoreDeps } from '../src/routes/oauth-core.js'
import {
  OAuthProviderError,
  type OAuthProvider,
  type NormalizedIdentity,
} from '../src/services/oauth/types.js'
import type { OAuthProviderSlug } from '../src/repos/oauth-identity.js'

// OAuth flow tests against real D1 with a STUBBED provider (no live
// Google/Apple/GitHub calls): resolve/create/auto-link/link, the
// unverified-email collision guard, state single-use (replay), the
// browser-bind login-CSRF guard, provider errors, and disabled providers.

const repos: Repos = buildD1Repos(createDb(env.DB))
const TENANT = 'rallypoint'
const UI_ORIGIN = 'http://localhost:5173'

function deps(providers: Map<OAuthProviderSlug, OAuthProvider>): OAuthCoreDeps {
  return {
    repos,
    providers,
    sessionHmacKey: 'session-hmac-session-hmac-32chars!',
    argon2PepperKey: 'pepper-pepper-pepper-pepper-32chars',
    uiOrigin: UI_ORIGIN,
    redirectBaseUrl: 'http://localhost:8080',
    allowedReturnHosts: ['events.rallypt.app'],
    now: () => new Date(),
  }
}

function identity(over: Partial<NormalizedIdentity> = {}): NormalizedIdentity {
  return {
    provider: 'google',
    subject: 'sub-1',
    email: 'new@example.com',
    emailVerified: true,
    name: 'New User',
    firstName: 'New',
    lastName: 'User',
    ...over,
  }
}

function stubProviders(
  id: NormalizedIdentity,
  opts: { throwOnExchange?: boolean } = {},
): Map<OAuthProviderSlug, OAuthProvider> {
  const provider: OAuthProvider = {
    slug: id.provider,
    buildAuthorizeUrl: (p) => `https://provider.example/auth?state=${encodeURIComponent(p.state)}`,
    exchangeAndFetchIdentity: async () => {
      if (opts.throwOnExchange) throw new OAuthProviderError('exchange boom')
      return id
    },
  }
  return new Map([[id.provider, provider]])
}

async function flow(
  providers: Map<OAuthProviderSlug, OAuthProvider>,
  slug: OAuthProviderSlug,
  opts: {
    returnTo?: string
    link?: boolean
    sessionUserId?: UserId | null
    tamperBind?: boolean
  } = {},
) {
  const start = await runOAuthStart(deps(providers), {
    provider: slug,
    returnTo: opts.returnTo ?? '/',
    link: opts.link ?? false,
    sessionUserId: opts.sessionUserId ?? null,
  })
  const state = new URL(start.authorizeUrl).searchParams.get('state')!
  const callback = (bind: string) =>
    runOAuthCallback(deps(providers), {
      provider: slug,
      code: 'code-1',
      state,
      bindCookie: bind,
      error: null,
      appleUser: null,
      ipAddress: '127.0.0.1',
      userAgent: 'test',
    })
  return { state, start, callback, bind: opts.tamperBind ? 'wrong-bind' : start.bindCookieValue }
}

async function clearAll(): Promise<void> {
  for (const t of ['oauth_states', 'oauth_identities', 'sessions', 'auth_methods', 'audit_log', 'users']) {
    await env.DB.exec(`DELETE FROM ${t}`)
  }
}
beforeEach(clearAll)
afterEach(clearAll)

describe('OAuth callback — resolve/create/link', () => {
  it('creates a new account + identity on first sign-in', async () => {
    const id = identity()
    const providers = stubProviders(id)
    const { callback, bind } = await flow(providers, 'google', { returnTo: '/planner' })
    const outcome = await callback(bind)
    expect(outcome.kind).toBe('success')
    if (outcome.kind === 'success') {
      expect(outcome.location).toBe('http://localhost:5173/planner')
      expect(outcome.sessionToken).toMatch(/^rps_live_/)
    }
    const user = await repos.users.findByEmail(TENANT, 'new@example.com')
    expect(user).not.toBeNull()
    expect(user!.emailVerified).toBe(true)
    expect(await repos.oauthIdentities.findByProviderSubject(TENANT, 'google', 'sub-1')).not.toBeNull()
  })

  it('is idempotent for a known (provider, subject)', async () => {
    const existing = 'user_known' as UserId
    await repos.users.create({ id: existing, tenantId: TENANT, email: 'known@example.com', username: 'K' })
    await repos.oauthIdentities.create({
      id: 'oi_known',
      userId: existing,
      tenantId: TENANT,
      provider: 'google',
      subject: 'sub-known',
      emailVerified: true,
    })
    const { callback, bind } = await flow(stubProviders(identity({ subject: 'sub-known' })), 'google')
    const outcome = await callback(bind)
    expect(outcome.kind).toBe('success')
    // No second user created for new@example.com.
    expect(await repos.users.findByEmail(TENANT, 'new@example.com')).toBeNull()
    expect((await repos.oauthIdentities.listByUser(existing)).length).toBe(1)
  })

  it('auto-links a provider-verified email to an existing account', async () => {
    const u = 'user_pw' as UserId
    await repos.users.create({ id: u, tenantId: TENANT, email: 'shared@example.com', username: 'PW' })
    await repos.users.setEmailVerified(u, true)
    const { callback, bind } = await flow(
      stubProviders(identity({ subject: 'sub-new', email: 'shared@example.com', emailVerified: true })),
      'google',
    )
    const outcome = await callback(bind)
    expect(outcome.kind).toBe('success')
    const linked = await repos.oauthIdentities.findByProviderSubject(TENANT, 'google', 'sub-new')
    expect(linked?.userId).toBe(u)
  })

  it('refuses to auto-merge an UNVERIFIED email onto an existing account', async () => {
    const u = 'user_pw2' as UserId
    await repos.users.create({ id: u, tenantId: TENANT, email: 'taken@example.com', username: 'PW2' })
    const { callback, bind } = await flow(
      stubProviders(identity({ subject: 'sub-unv', email: 'taken@example.com', emailVerified: false })),
      'google',
    )
    const outcome = await callback(bind)
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') expect(outcome.location).toContain('error=account_exists')
    // No identity was linked to the existing account.
    expect(await repos.oauthIdentities.findByProviderSubject(TENANT, 'google', 'sub-unv')).toBeNull()
  })

  it('does NOT claim an UNVERIFIED local account even when the provider email is verified', async () => {
    // Attacker pre-registers an unverified shell under the victim's email.
    const shell = 'user_shell' as UserId
    await repos.users.create({ id: shell, tenantId: TENANT, email: 'shell@example.com', username: 'Shell' })
    // Victim later signs in with a provider-VERIFIED same email.
    const { callback, bind } = await flow(
      stubProviders(identity({ subject: 'sub-shell', email: 'shell@example.com', emailVerified: true })),
      'google',
    )
    const outcome = await callback(bind)
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') expect(outcome.location).toContain('error=account_exists')
    // The shell account was NOT auto-linked (no pre-hijacking).
    expect(await repos.oauthIdentities.findByProviderSubject(TENANT, 'google', 'sub-shell')).toBeNull()
  })

  it('refuses a link when the provider account is already linked elsewhere', async () => {
    const owner = 'user_owner' as UserId
    await repos.users.create({ id: owner, tenantId: TENANT, email: 'owner@example.com', username: 'O' })
    await repos.oauthIdentities.create({
      id: 'oi_owned',
      userId: owner,
      tenantId: TENANT,
      provider: 'google',
      subject: 'sub-owned',
      emailVerified: true,
    })
    const linker = 'user_linker2' as UserId
    await repos.users.create({ id: linker, tenantId: TENANT, email: 'linker2@example.com', username: 'L2' })
    const { callback, bind } = await flow(
      stubProviders(identity({ subject: 'sub-owned', email: 'x@example.com', emailVerified: true })),
      'google',
      { link: true, sessionUserId: linker },
    )
    const outcome = await callback(bind)
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') expect(outcome.location).toContain('error=identity_already_linked')
  })

  it('links to the signed-in user on the link flow', async () => {
    const u = 'user_link' as UserId
    await repos.users.create({ id: u, tenantId: TENANT, email: 'linker@example.com', username: 'L' })
    await repos.authMethods.create({
      id: 'am_link',
      userId: u,
      tenantId: TENANT,
      kind: 'password',
      secretHash: 'h',
      keyVersion: 1,
    })
    const { callback, bind } = await flow(
      stubProviders(identity({ subject: 'sub-link', email: 'other@example.com', emailVerified: true })),
      'google',
      { link: true, sessionUserId: u },
    )
    const outcome = await callback(bind)
    expect(outcome.kind).toBe('success')
    const linked = await repos.oauthIdentities.findByProviderSubject(TENANT, 'google', 'sub-link')
    expect(linked?.userId).toBe(u)
  })
})

describe('OAuth callback — security guards', () => {
  it('rejects a replayed state (single-use)', async () => {
    const { callback, bind } = await flow(stubProviders(identity()), 'google')
    expect((await callback(bind)).kind).toBe('success')
    const replay = await callback(bind)
    expect(replay.kind).toBe('error')
    if (replay.kind === 'error') expect(replay.location).toContain('error=invalid_state')
  })

  it('rejects a mismatched browser-bind cookie (login-CSRF defense)', async () => {
    const { callback, bind } = await flow(stubProviders(identity()), 'google', { tamperBind: true })
    const outcome = await callback(bind)
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') expect(outcome.location).toContain('error=invalid_state')
  })

  it('maps a provider exchange failure to a generic error redirect', async () => {
    const { callback, bind } = await flow(stubProviders(identity(), { throwOnExchange: true }), 'google')
    const outcome = await callback(bind)
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') expect(outcome.location).toContain('error=provider_error')
  })

  it('404s an unconfigured provider', async () => {
    await expect(
      runOAuthStart(deps(new Map()), { provider: 'apple', returnTo: '/', link: false, sessionUserId: null }),
    ).rejects.toMatchObject({ status: 404 })
  })
})
