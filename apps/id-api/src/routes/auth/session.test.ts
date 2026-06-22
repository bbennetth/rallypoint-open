import { describe, it, expect, vi } from 'vitest'
import { buildApp } from '../../build-app.js'
import { parseEnv } from '../../env.js'
import { buildInMemoryRepos } from '../../repos/memory.js'
import { createPasswordHasher } from '../../crypto/password.js'
import { createAlwaysAllowVerifier } from '../../services/captcha.js'
import { createStubBreachedCheck } from '../../services/breached-password.js'
import { createLogMailer } from '../../services/mailer/log.js'
import { issueSession } from '../../session/issue.js'
import { SessionCache } from '../../session/cache.js'
import type { UserId } from '@rallypoint/shared'
import { hashToken } from '@rallypoint/crypto'
import { SSO_HINT_COOKIE_NAME } from '../../lib/sso-hint-cookie.js'
const ENV = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
const SESSION_COOKIE_NAME = ENV.SESSION_COOKIE_NAME
const CSRF_COOKIE_NAME = ENV.CSRF_COOKIE_NAME

// CSRF double-submit (#18). Tests that drive state-changing UI
// requests need to include a matching cookie + header pair. The
// actual value is arbitrary — the middleware just checks equality.
const TEST_CSRF = 'test-csrf-' + 'x'.repeat(40)

function withCsrf(...cookies: string[]): Record<string, string> {
  return {
    cookie: [...cookies, `${CSRF_COOKIE_NAME}=${TEST_CSRF}`].filter(Boolean).join('; '),
    'x-rp-csrf': TEST_CSRF,
  }
}

function buildTestApp() {
  const repos = buildInMemoryRepos()
  const services = {
    mailer: createLogMailer({ sink: () => undefined }),
    captcha: createAlwaysAllowVerifier(),
    breachedPassword: createStubBreachedCheck(),
  }
  const passwordHasher = createPasswordHasher({ pepper: ENV.ARGON2_PEPPER })
  const app = buildApp({ env: ENV, repos, services, passwordHasher })
  return { app, repos, passwordHasher }
}

async function createUser(repos: ReturnType<typeof buildInMemoryRepos>): Promise<UserId> {
  const id = 'user_01HXTEST00000000000000000A' as UserId
  await repos.users.create({
    id,
    tenantId: 'rallypoint',
    email: 'alice@example.com',
    username: 'alice',
  })
  await repos.users.setEmailVerified(id, true)
  return id
}

describe('GET /api/v1/ui/session', () => {
  it('returns 401 when no cookie is present', async () => {
    const { app } = buildTestApp()
    const res = await app.request('/api/v1/ui/session')
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('session_required')
  })

  it('returns 401 when the cookie has an unknown token', async () => {
    const { app } = buildTestApp()
    const res = await app.request('/api/v1/ui/session', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=rps_live_nope` },
    })
    expect(res.status).toBe(401)
  })

  it('returns OIDC-shape userinfo for a valid session', async () => {
    const { app, repos } = buildTestApp()
    const userId = await createUser(repos)
    const { rawToken } = await issueSession(repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'a'.repeat(64),
      uaHash: 'b'.repeat(64),
    })
    const res = await app.request('/api/v1/ui/session', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${rawToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.sub).toBe(userId)
    expect(body.email).toBe('alice@example.com')
    expect(body.email_verified).toBe(true)
    expect(body.preferred_username).toBe('alice')
    expect(body.name).toBe('alice')
    expect(body.first_name).toBeNull()
    expect(body.last_name).toBeNull()
    expect(body.picture).toBeNull()
    expect(typeof body.updated_at).toBe('string')
  })

  it('folds the shared settings doc into the session probe', async () => {
    const { app, repos } = buildTestApp()
    const userId = await createUser(repos)
    await repos.settings.merge(userId, 'shared', { themeMode: 'light', themeColor: 'green' })
    const { rawToken } = await issueSession(repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'a'.repeat(64),
      uaHash: 'b'.repeat(64),
    })
    const res = await app.request('/api/v1/ui/session', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${rawToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings?: Record<string, unknown> }
    expect(body.settings).toEqual({ themeMode: 'light', themeColor: 'green' })
  })

  it('returns an empty settings object when the user has no shared doc', async () => {
    const { app, repos } = buildTestApp()
    const userId = await createUser(repos)
    const { rawToken } = await issueSession(repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'a'.repeat(64),
      uaHash: 'b'.repeat(64),
    })
    const res = await app.request('/api/v1/ui/session', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${rawToken}` },
    })
    const body = (await res.json()) as { settings?: Record<string, unknown> }
    expect(body.settings).toEqual({})
  })

  it('rejects an expired session', async () => {
    const { app, repos } = buildTestApp()
    const userId = await createUser(repos)
    const { rawToken, idHash } = await issueSession(repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'a'.repeat(64),
      uaHash: 'b'.repeat(64),
    })
    // Mutate the row directly to simulate expiry.
    const row = await repos.sessions.findByIdHash(idHash)
    row!.absoluteExpiresAt = new Date(Date.now() - 1000)
    await repos.sessions.create(row!) // overwrite

    const res = await app.request('/api/v1/ui/session', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${rawToken}` },
    })
    expect(res.status).toBe(401)
  })
})

describe('POST /api/v1/ui/signout', () => {
  it('clears the cookie, deletes the session row, and audits with the real userId (#23)', async () => {
    const { app, repos } = buildTestApp()
    const userId = await createUser(repos)
    const { rawToken, idHash } = await issueSession(repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'a'.repeat(64),
      uaHash: 'b'.repeat(64),
    })
    const res = await app.request('/api/v1/ui/signout', {
      method: 'POST',
      headers: withCsrf(`${SESSION_COOKIE_NAME}=${rawToken}`),
    })
    expect(res.status).toBe(200)
    // Audit row carries the real userId (regression test for #23).
    // The fire-and-forget audit may complete after the response, so
    // give it a microtask to settle.
    await new Promise((r) => setImmediate(r))
    const events = await repos.audit.list({ tenantId: 'rallypoint', userId })
    const signoutEvent = events.find((e) => e.eventType === 'signout.success')
    expect(signoutEvent).toBeDefined()
    expect(signoutEvent!.userId).toBe(userId)
    expect(signoutEvent!.meta.had_session_row).toBe(true)
    const setCookies = res.headers.getSetCookie()
    expect(setCookies.some((v) => v.includes(`${SESSION_COOKIE_NAME}=;`))).toBe(true)
    expect(setCookies.some((v) => v.includes('Max-Age=0'))).toBe(true)
    expect(await repos.sessions.findByIdHash(idHash)).toBeNull()
  })

  it('includes an rp_sso clear cookie (Max-Age=0) on signout (#369)', async () => {
    const { app, repos } = buildTestApp()
    const userId = await createUser(repos)
    const { rawToken } = await issueSession(repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'a'.repeat(64),
      uaHash: 'b'.repeat(64),
    })
    const res = await app.request('/api/v1/ui/signout', {
      method: 'POST',
      headers: withCsrf(`${SESSION_COOKIE_NAME}=${rawToken}`),
    })
    expect(res.status).toBe(200)
    const setCookies = res.headers.getSetCookie()
    const hintCookie = setCookies.find((v) => v.startsWith(`${SSO_HINT_COOKIE_NAME}=`))
    expect(hintCookie).toBeDefined()
    expect(hintCookie).toContain('Max-Age=0')
    expect(hintCookie).not.toContain('HttpOnly')
  })

  it('returns 200 even when there is no session cookie (no enumeration)', async () => {
    const { app } = buildTestApp()
    const res = await app.request('/api/v1/ui/signout', {
      method: 'POST',
      headers: withCsrf(),
    })
    expect(res.status).toBe(200)
  })

  it('omits Secure on the session clear-cookie when NODE_ENV is not production (dev localhost fix)', async () => {
    // Default test ENV has NODE_ENV='test' — Secure must be absent so
    // http://localhost browsers actually clear the cookie.
    const { app } = buildTestApp() // uses NODE_ENV='test'
    const res = await app.request('/api/v1/ui/signout', {
      method: 'POST',
      headers: withCsrf(),
    })
    expect(res.status).toBe(200)
    const setCookies = res.headers.getSetCookie()
    const sessionClear = setCookies.find((v) => v.startsWith(`${SESSION_COOKIE_NAME}=;`))
    expect(sessionClear).toBeDefined()
    expect(sessionClear).not.toContain('Secure')
    expect(sessionClear).toContain('HttpOnly')
    expect(sessionClear).toContain('Max-Age=0')
  })

  it('includes Secure on the session clear-cookie when NODE_ENV is production', async () => {
    const prodEnv = parseEnv({ NODE_ENV: 'production', LOG_LEVEL: 'fatal' })
    const repos = buildInMemoryRepos()
    const services = {
      mailer: createLogMailer({ sink: () => undefined }),
      captcha: createAlwaysAllowVerifier(),
      breachedPassword: createStubBreachedCheck(),
    }
    const passwordHasher = createPasswordHasher({ pepper: prodEnv.ARGON2_PEPPER })
    const app = buildApp({ env: prodEnv, repos, services, passwordHasher })

    // Use the prod env's CSRF cookie name (becomes __Host-rp_csrf in production).
    const prodCsrfCookieName = prodEnv.CSRF_COOKIE_NAME
    const prodSessionCookieName = prodEnv.SESSION_COOKIE_NAME
    const csrfToken = 'test-csrf-' + 'x'.repeat(40)
    const res = await app.request('/api/v1/ui/signout', {
      method: 'POST',
      headers: {
        cookie: `${prodCsrfCookieName}=${csrfToken}`,
        'x-rp-csrf': csrfToken,
      },
    })
    expect(res.status).toBe(200)
    const setCookies = res.headers.getSetCookie()
    const sessionClear = setCookies.find((v) =>
      v.startsWith(`${prodSessionCookieName}=;`),
    )
    expect(sessionClear).toBeDefined()
    expect(sessionClear).toContain('Secure')
    expect(sessionClear).toContain('HttpOnly')
    expect(sessionClear).toContain('Max-Age=0')
  })
})

// SSO hint cookie wiring (#369) — HTTP-level assertions for the signin-complete
// path. We drive the full signup → verify → start → complete flow via app.request
// so we're testing the route handler wiring, not the helper unit.
describe('POST /api/v1/ui/signin/complete — SSO hint cookie (#369)', () => {
  it('includes an rp_sso=1 hint cookie on signin-complete and no HttpOnly', async () => {
    const mailer = createLogMailer({ sink: () => undefined })
    const repos = buildInMemoryRepos()
    const services = {
      mailer,
      captcha: createAlwaysAllowVerifier(),
      breachedPassword: createStubBreachedCheck(),
    }
    const passwordHasher = createPasswordHasher({ pepper: ENV.ARGON2_PEPPER })
    const app = buildApp({ env: ENV, repos, services, passwordHasher })

    // Signup + verify + start (captures challengeId + code)
    await app.request('/api/v1/ui/signup', {
      method: 'POST',
      headers: { ...withCsrf(), 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'sso-hint@example.com',
        name: 'ssouser',
        password: 'a-very-strong-password',
        captchaToken: 'tok',
      }),
    })
    const user = await repos.users.findByEmail('rallypoint', 'sso-hint@example.com')
    await repos.users.setEmailVerified(user!.id, true)
    const startRes = await app.request('/api/v1/ui/signin/start', {
      method: 'POST',
      headers: { ...withCsrf(), 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'sso-hint@example.com', password: 'a-very-strong-password' }),
    })
    const startBody = (await startRes.json()) as { challengeId: string }
    const sent = mailer.sent[mailer.sent.length - 1]!
    const code = /\b(\d{6})\b/.exec(sent.text)![1]!

    // Complete signin
    const res = await app.request('/api/v1/ui/signin/complete', {
      method: 'POST',
      headers: { ...withCsrf(), 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: startBody.challengeId, code }),
    })
    expect(res.status).toBe(200)

    const setCookies = res.headers.getSetCookie()
    // Must have the session cookie
    expect(setCookies.some((v) => v.includes(SESSION_COOKIE_NAME))).toBe(true)
    // Must have the SSO hint cookie set to 1
    const hintCookie = setCookies.find((v) => v.startsWith(`${SSO_HINT_COOKIE_NAME}=1`))
    expect(hintCookie).toBeDefined()
    expect(hintCookie).toContain('Max-Age=')
    expect(hintCookie).not.toContain('HttpOnly')
  })
})

describe('POST /api/v1/sdk/session/verify', () => {
  it('returns 401 for a bearer that does not match a session', async () => {
    const { app } = buildTestApp()
    const res = await app.request('/api/v1/sdk/session/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'rps_live_nope' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns userinfo for a valid bearer', async () => {
    const { app, repos } = buildTestApp()
    const userId = await createUser(repos)
    const { rawToken } = await issueSession(repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'a'.repeat(64),
      uaHash: 'b'.repeat(64),
    })
    const res = await app.request('/api/v1/sdk/session/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: rawToken }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.sub).toBe(userId)
  })

  it('rejects a token that has the wrong prefix', async () => {
    const { app } = buildTestApp()
    const res = await app.request('/api/v1/sdk/session/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'rpv_thisisaverificationtokennotasession' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('POST /api/v1/sdk/signout', () => {
  it('deletes the session row for a valid bearer', async () => {
    const { app, repos } = buildTestApp()
    const userId = await createUser(repos)
    const { rawToken } = await issueSession(repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'a'.repeat(64),
      uaHash: 'b'.repeat(64),
    })
    const idHash = hashToken(rawToken)

    const res = await app.request('/api/v1/sdk/signout', {
      method: 'POST',
      headers: { authorization: `Bearer ${rawToken}` },
    })
    expect(res.status).toBe(200)
    expect(await repos.sessions.findByIdHash(idHash)).toBeNull()
  })
})

// Tests for the extracted signoutByToken helper (#52).
// Verifies that both the cookie (UI) and bearer (SDK) signout paths
// perform the full delete + cache-invalidate sequence so neither path
// can forget the cache step independently.
describe('signoutByToken — shared cache-invalidation invariant (#52)', () => {
  function buildCachedTestApp() {
    const repos = buildInMemoryRepos()
    const services = {
      mailer: createLogMailer({ sink: () => undefined }),
      captcha: createAlwaysAllowVerifier(),
      breachedPassword: createStubBreachedCheck(),
    }
    const passwordHasher = createPasswordHasher({ pepper: ENV.ARGON2_PEPPER })
    const sessionCache = new SessionCache()
    const app = buildApp({ env: ENV, repos, services, passwordHasher, sessionCache })
    return { app, repos, passwordHasher, sessionCache }
  }

  it('UI signout invalidates the in-process cache', async () => {
    const { app, repos, sessionCache } = buildCachedTestApp()
    const userId = await createUser(repos)
    const { rawToken, idHash } = await issueSession(repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'a'.repeat(64),
      uaHash: 'b'.repeat(64),
    })
    // Warm the cache so there is definitely an entry to invalidate.
    const row = await repos.sessions.findByIdHash(idHash)
    sessionCache.put(idHash, row)
    expect(sessionCache.get(idHash)).not.toBeUndefined()

    await app.request('/api/v1/ui/signout', {
      method: 'POST',
      headers: withCsrf(`${SESSION_COOKIE_NAME}=${rawToken}`),
    })

    expect(sessionCache.get(idHash)).toBeUndefined()
  })

  it('SDK signout invalidates the in-process cache', async () => {
    const { app, repos, sessionCache } = buildCachedTestApp()
    const userId = await createUser(repos)
    const { rawToken, idHash } = await issueSession(repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'a'.repeat(64),
      uaHash: 'b'.repeat(64),
    })
    // Warm the cache.
    const row = await repos.sessions.findByIdHash(idHash)
    sessionCache.put(idHash, row)
    expect(sessionCache.get(idHash)).not.toBeUndefined()

    await app.request('/api/v1/sdk/signout', {
      method: 'POST',
      headers: { authorization: `Bearer ${rawToken}` },
    })

    expect(sessionCache.get(idHash)).toBeUndefined()
  })
})

describe('POST /api/v1/sdk/session/reauth', () => {
  const EVENTS_KEY = 'test-events-api-key-32chars-minimum!!'
  const PASSWORD = 'correct horse battery staple'

  function buildReauthApp() {
    const env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal', EVENTS_API_KEY: EVENTS_KEY })
    const repos = buildInMemoryRepos()
    const services = {
      mailer: createLogMailer({ sink: () => undefined }),
      captcha: createAlwaysAllowVerifier(),
      breachedPassword: createStubBreachedCheck(),
    }
    const passwordHasher = createPasswordHasher({ pepper: env.ARGON2_PEPPER })
    const app = buildApp({ env, repos, services, passwordHasher })
    return { app, repos, passwordHasher }
  }

  async function withPassword(
    repos: ReturnType<typeof buildInMemoryRepos>,
    passwordHasher: ReturnType<typeof createPasswordHasher>,
    userId: UserId,
  ): Promise<void> {
    const { secretHash, keyVersion } = await passwordHasher.hash(PASSWORD)
    await repos.authMethods.create({
      id: 'authm_01HXTEST00000000000000000A',
      userId,
      tenantId: 'rallypoint',
      kind: 'password',
      secretHash,
      keyVersion,
    })
  }

  it('returns 404 when EVENTS_API_KEY is unset (anti-fingerprint)', async () => {
    const { app } = buildTestApp()
    const res = await app.request('/api/v1/sdk/session/reauth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer anything' },
      body: JSON.stringify({ user_id: 'user_x', password: 'p' }),
    })
    expect(res.status).toBe(404)
  })

  it('rejects a wrong/absent EVENTS_API_KEY with 403', async () => {
    const { app } = buildReauthApp()
    const res = await app.request('/api/v1/sdk/session/reauth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify({ user_id: 'user_x', password: 'p' }),
    })
    expect(res.status).toBe(403)
  })

  it('returns ok:true for the correct password and audits success', async () => {
    const { app, repos, passwordHasher } = buildReauthApp()
    const userId = await createUser(repos)
    await withPassword(repos, passwordHasher, userId)
    const res = await app.request('/api/v1/sdk/session/reauth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${EVENTS_KEY}` },
      body: JSON.stringify({ user_id: userId, password: PASSWORD }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as Record<string, unknown>).toEqual({ ok: true })

    await new Promise((r) => setImmediate(r))
    const events = await repos.audit.list({ tenantId: 'rallypoint', userId })
    expect(events.some((e) => e.eventType === 'session.reauth_succeeded')).toBe(true)
  })

  it('returns 401 reauth_failed for a wrong password and audits failure', async () => {
    const { app, repos, passwordHasher } = buildReauthApp()
    const userId = await createUser(repos)
    await withPassword(repos, passwordHasher, userId)
    const res = await app.request('/api/v1/sdk/session/reauth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${EVENTS_KEY}` },
      body: JSON.stringify({ user_id: userId, password: 'wrong password' }),
    })
    expect(res.status).toBe(401)
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ reason: 'reauth_failed' })

    await new Promise((r) => setImmediate(r))
    const events = await repos.audit.list({ tenantId: 'rallypoint', userId })
    expect(events.some((e) => e.eventType === 'session.reauth_failed')).toBe(true)
  })

  it('returns 401 reauth_failed when the user has no password method', async () => {
    const { app, repos } = buildReauthApp()
    const userId = await createUser(repos)
    const res = await app.request('/api/v1/sdk/session/reauth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${EVENTS_KEY}` },
      body: JSON.stringify({ user_id: userId, password: PASSWORD }),
    })
    expect(res.status).toBe(401)
  })

  it('429s once the per-user attempt budget is exhausted', async () => {
    // Pin the clock for the whole loop. The limiter buckets by wall-clock
    // window (windowStartMs over fixed 10-min epoch buckets). On a real
    // clock, if the 11 attempts happen to straddle a window boundary, the
    // 11th lands in a fresh window where the sliding-window blend rounds to
    // exactly the limit (floor(1 + 10·(1−ε/window)) = 10 ≤ 10) and slips
    // through as a wrong-password 401 instead of a 429 — a rare CI flake.
    // Freezing Date keeps all 11 attempts in one window. Only Date is faked,
    // so argon2 + async still run on real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-13T12:05:00.000Z'))
    try {
      const { app, repos, passwordHasher } = buildReauthApp()
      const userId = await createUser(repos)
      await withPassword(repos, passwordHasher, userId)
      // Limit is 10 per window; the 11th attempt trips it.
      let last = 0
      for (let i = 0; i < 11; i++) {
        const res = await app.request('/api/v1/sdk/session/reauth', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${EVENTS_KEY}` },
          body: JSON.stringify({ user_id: userId, password: 'wrong' }),
        })
        last = res.status
      }
      expect(last).toBe(429)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('issueSession', () => {
  it('produces a valid rps_live_ token whose hash matches the stored row', async () => {
    const { repos } = buildTestApp()
    const userId = await createUser(repos)
    const { rawToken, idHash, absoluteExpiresAt } = await issueSession(repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'x'.repeat(64),
      uaHash: 'y'.repeat(64),
    })
    expect(rawToken.startsWith('rps_live_')).toBe(true)
    expect(idHash).toBe(hashToken(rawToken))
    const row = await repos.sessions.findByIdHash(idHash)
    expect(row).not.toBeNull()
    expect(row!.userId).toBe(userId)
    expect(row!.absoluteExpiresAt.getTime()).toBe(absoluteExpiresAt.getTime())
  })

  it('revokes other sessions for the user when requested', async () => {
    const { repos } = buildTestApp()
    const userId = await createUser(repos)
    const a = await issueSession(repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'a'.repeat(64),
      uaHash: 'b'.repeat(64),
    })
    const b = await issueSession(repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'c'.repeat(64),
      uaHash: 'd'.repeat(64),
    })
    expect(await repos.sessions.findByIdHash(a.idHash)).not.toBeNull()
    expect(await repos.sessions.findByIdHash(b.idHash)).not.toBeNull()

    const c = await issueSession(repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'e'.repeat(64),
      uaHash: 'f'.repeat(64),
      revokeOtherSessionsForUser: true,
    })

    expect(await repos.sessions.findByIdHash(a.idHash)).toBeNull()
    expect(await repos.sessions.findByIdHash(b.idHash)).toBeNull()
    expect(await repos.sessions.findByIdHash(c.idHash)).not.toBeNull()

    // #222: the revoked idHashes are surfaced so the caller can evict
    // each from the SessionCache. Must list the deleted rows (a, b) and
    // never the kept one (c).
    expect(new Set(c.revokedIdHashes)).toEqual(new Set([a.idHash, b.idHash]))
    expect(c.revokedIdHashes).not.toContain(c.idHash)
  })

  it('returns an empty revokedIdHashes list when revoke is not requested', async () => {
    const { repos } = buildTestApp()
    const userId = await createUser(repos)
    const result = await issueSession(repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'a'.repeat(64),
      uaHash: 'b'.repeat(64),
    })
    expect(result.revokedIdHashes).toEqual([])
  })

  it('records parentSessionIdHash on the issued row when given (#93)', async () => {
    const { repos } = buildTestApp()
    const userId = await createUser(repos)
    const parent = await issueSession(repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'a'.repeat(64),
      uaHash: 'b'.repeat(64),
    })
    const child = await issueSession(repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'c'.repeat(64),
      uaHash: 'd'.repeat(64),
      parentSessionIdHash: parent.idHash,
    })
    expect((await repos.sessions.findByIdHash(parent.idHash))!.parentSessionId).toBeNull()
    expect((await repos.sessions.findByIdHash(child.idHash))!.parentSessionId).toBe(parent.idHash)
  })
})

// Single-logout session-family cascade (#93). Signing out of any
// family member (the browser login OR an SSO-minted consumer session)
// tears down the whole family — so "Sign out" actually signs you out
// everywhere in this browser. Sessions from another device/browser
// (a different family) are untouched.
describe('signout cascades the session family (#93)', () => {
  function buildCachedTestApp() {
    const repos = buildInMemoryRepos()
    const services = {
      mailer: createLogMailer({ sink: () => undefined }),
      captcha: createAlwaysAllowVerifier(),
      breachedPassword: createStubBreachedCheck(),
    }
    const passwordHasher = createPasswordHasher({ pepper: ENV.ARGON2_PEPPER })
    const sessionCache = new SessionCache()
    const app = buildApp({ env: ENV, repos, services, passwordHasher, sessionCache })
    return { app, repos, sessionCache }
  }

  // Browser login A with two SSO-minted children (B events, C lists),
  // plus an unrelated browser D on another device. Returns all handles.
  async function buildFamily(repos: ReturnType<typeof buildInMemoryRepos>) {
    const userId = await createUser(repos)
    const a = await issueSession(repos.sessions, {
      userId, tenantId: 'rallypoint', ipHash: 'a'.repeat(64), uaHash: 'b'.repeat(64),
    })
    const b = await issueSession(repos.sessions, {
      userId, tenantId: 'rallypoint', ipHash: 'c'.repeat(64), uaHash: 'd'.repeat(64),
      parentSessionIdHash: a.idHash,
    })
    const c = await issueSession(repos.sessions, {
      userId, tenantId: 'rallypoint', ipHash: 'e'.repeat(64), uaHash: 'f'.repeat(64),
      parentSessionIdHash: a.idHash,
    })
    // Unrelated browser on another device — its own family.
    const d = await issueSession(repos.sessions, {
      userId, tenantId: 'rallypoint', ipHash: '9'.repeat(64), uaHash: '8'.repeat(64),
    })
    return { a, b, c, d }
  }

  it('SDK signout of a consumer child kills the parent + all siblings, sparing other devices', async () => {
    const { app, repos } = buildCachedTestApp()
    const { a, b, c, d } = await buildFamily(repos)

    // Sign out of events (child B) via its bearer.
    const res = await app.request('/api/v1/sdk/signout', {
      method: 'POST',
      headers: { authorization: `Bearer ${b.rawToken}` },
    })
    expect(res.status).toBe(200)

    expect(await repos.sessions.findByIdHash(a.idHash)).toBeNull()
    expect(await repos.sessions.findByIdHash(b.idHash)).toBeNull()
    expect(await repos.sessions.findByIdHash(c.idHash)).toBeNull()
    // The other device stays signed in.
    expect(await repos.sessions.findByIdHash(d.idHash)).not.toBeNull()
  })

  it('UI signout of the browser login kills its children too', async () => {
    const { app, repos } = buildCachedTestApp()
    const { a, b, c, d } = await buildFamily(repos)

    const res = await app.request('/api/v1/ui/signout', {
      method: 'POST',
      headers: withCsrf(`${SESSION_COOKIE_NAME}=${a.rawToken}`),
    })
    expect(res.status).toBe(200)

    expect(await repos.sessions.findByIdHash(a.idHash)).toBeNull()
    expect(await repos.sessions.findByIdHash(b.idHash)).toBeNull()
    expect(await repos.sessions.findByIdHash(c.idHash)).toBeNull()
    expect(await repos.sessions.findByIdHash(d.idHash)).not.toBeNull()
  })

  it('invalidates the session cache for every family member it deletes', async () => {
    const { app, repos, sessionCache } = buildCachedTestApp()
    const { a, b, c } = await buildFamily(repos)
    // Warm the cache for the whole family.
    for (const s of [a, b, c]) {
      sessionCache.put(s.idHash, await repos.sessions.findByIdHash(s.idHash))
      expect(sessionCache.get(s.idHash)).not.toBeUndefined()
    }

    await app.request('/api/v1/sdk/signout', {
      method: 'POST',
      headers: { authorization: `Bearer ${c.rawToken}` },
    })

    expect(sessionCache.get(a.idHash)).toBeUndefined()
    expect(sessionCache.get(b.idHash)).toBeUndefined()
    expect(sessionCache.get(c.idHash)).toBeUndefined()
  })
})
