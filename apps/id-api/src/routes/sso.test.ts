import { describe, it, expect } from 'vitest'
import { buildApp } from '../build-app.js'
import { parseEnv } from '../env.js'
import { buildInMemoryRepos } from '../repos/memory.js'
import { createPasswordHasher } from '../crypto/password.js'
import { createAlwaysAllowVerifier } from '../services/captcha.js'
import { createStubBreachedCheck } from '../services/breached-password.js'
import { createLogMailer } from '../services/mailer/log.js'
import { issueSession } from '../session/issue.js'
import { hashToken } from '@rallypoint/crypto'
import { TOKEN_PREFIXES } from '@rallypoint/shared'
import type { UserId } from '@rallypoint/shared'

// Shared env for mint tests (EVENTS_API_KEY set + SSO_EVENTS_HOST configured).
const ENV_WITH_EVENTS = parseEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  SSO_EVENTS_HOST: 'localhost:5174',
  EVENTS_API_KEY: 'test-events-api-key-32chars-minimum!!',
})

// Env without EVENTS_API_KEY — for test #9.
const ENV_NO_KEY = parseEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  SSO_EVENTS_HOST: 'localhost:5174',
})

const SESSION_COOKIE_NAME = ENV_WITH_EVENTS.SESSION_COOKIE_NAME
const CSRF_COOKIE_NAME = ENV_WITH_EVENTS.CSRF_COOKIE_NAME
const TEST_CSRF = 'test-csrf-' + 'x'.repeat(40)

function withCsrf(...cookies: string[]): Record<string, string> {
  return {
    cookie: [...cookies, `${CSRF_COOKIE_NAME}=${TEST_CSRF}`].filter(Boolean).join('; '),
    'x-rp-csrf': TEST_CSRF,
  }
}

function buildTestApp(env = ENV_WITH_EVENTS) {
  const repos = buildInMemoryRepos()
  const services = {
    mailer: createLogMailer({ sink: () => undefined }),
    captcha: createAlwaysAllowVerifier(),
    breachedPassword: createStubBreachedCheck(),
  }
  const passwordHasher = createPasswordHasher({ pepper: env.ARGON2_PEPPER })
  const app = buildApp({ env, repos, services, passwordHasher })
  return { app, repos }
}

async function createUser(
  repos: ReturnType<typeof buildInMemoryRepos>,
): Promise<UserId> {
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

async function signedInCookie(
  repos: ReturnType<typeof buildInMemoryRepos>,
  userId: UserId,
): Promise<string> {
  const { rawToken } = await issueSession(repos.sessions, {
    userId,
    tenantId: 'rallypoint',
    ipHash: 'a'.repeat(64),
    uaHash: 'b'.repeat(64),
  })
  return `${SESSION_COOKIE_NAME}=${rawToken}`
}

// -------------------------------------------------------------------
// Mint: POST /api/v1/ui/sso/code
// -------------------------------------------------------------------

describe('POST /api/v1/ui/sso/code — mint', () => {
  it('happy path: returns 200 with rpsso_ code and creates sso_codes row', async () => {
    const { app, repos } = buildTestApp()
    const userId = await createUser(repos)
    const sessionCookie = await signedInCookie(repos, userId)

    const res = await app.request('/api/v1/ui/sso/code', {
      method: 'POST',
      headers: {
        ...withCsrf(sessionCookie),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ client: 'events', return_to_host: 'localhost:5174' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { code?: string }
    expect(typeof body.code).toBe('string')
    expect(body.code!.startsWith(TOKEN_PREFIXES.sso)).toBe(true)

    // Row exists in sso_codes
    const codeHash = hashToken(body.code!)
    const row = await repos.ssoCodes.findByCodeHash(codeHash)
    expect(row).not.toBeNull()
    expect(row!.userId).toBe(userId)
    expect(row!.client).toBe('events')
    expect(row!.returnToHost).toBe('localhost:5174')
    expect(row!.consumedAt).toBeNull()
    // expiresAt ≈ now + 60s (within 5s window for test clock drift)
    const ttl = row!.expiresAt.getTime() - Date.now()
    expect(ttl).toBeGreaterThan(55_000)
    expect(ttl).toBeLessThanOrEqual(60_000)
  })

  it('rejects unknown client with 400 sso_client_unknown', async () => {
    const { app, repos } = buildTestApp()
    const userId = await createUser(repos)
    const sessionCookie = await signedInCookie(repos, userId)

    const res = await app.request('/api/v1/ui/sso/code', {
      method: 'POST',
      headers: {
        ...withCsrf(sessionCookie),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ client: 'mystery', return_to_host: 'whatever' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('sso_client_unknown')
  })

  it('markConsumed is atomic — concurrent flips return true once, false thereafter', async () => {
    // Repo-level invariant: the second markConsumed call on the
    // same code_hash returns false (consumed_at already set), so
    // the route handler's `if (!flipped) → 409` branch fires.
    // This guards the race condition where two concurrent exchange
    // requests both pass the pre-check `row.consumedAt === null`.
    const { repos } = buildTestApp()
    const userId = await createUser(repos)
    const codeHash = 'h-' + 'x'.repeat(62)
    await repos.ssoCodes.create({
      codeHash,
      userId,
      tenantId: 'rallypoint',
      client: 'events',
      returnToHost: 'localhost:5174',
      expiresAt: new Date(Date.now() + 60_000),
    })

    const now = new Date()
    const first = await repos.ssoCodes.markConsumed(codeHash, now)
    const second = await repos.ssoCodes.markConsumed(codeHash, now)

    expect(first).toBe(true)
    expect(second).toBe(false)
  })

  it('rejects events client with 400 sso_client_unknown when SSO_EVENTS_HOST env is unset', async () => {
    // Deploy bug: client is allowlisted in code (CLIENT_ALLOWLIST
    // includes 'events') but SSO_EVENTS_HOST is not configured.
    // Surfaces clearly to the operator, doesn't silently allow.
    const envNoHost = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      EVENTS_API_KEY: 'test-events-api-key-32chars-minimum!!',
    })
    const { app, repos } = buildTestApp(envNoHost)
    const userId = await createUser(repos)
    const sessionCookie = await signedInCookie(repos, userId)

    const res = await app.request('/api/v1/ui/sso/code', {
      method: 'POST',
      headers: {
        ...withCsrf(sessionCookie),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ client: 'events', return_to_host: 'localhost:5174' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('sso_client_unknown')
  })

  it('rejects mismatched return_to_host with 400 sso_return_to_host_invalid', async () => {
    const { app, repos } = buildTestApp()
    const userId = await createUser(repos)
    const sessionCookie = await signedInCookie(repos, userId)

    const res = await app.request('/api/v1/ui/sso/code', {
      method: 'POST',
      headers: {
        ...withCsrf(sessionCookie),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ client: 'events', return_to_host: 'attacker.example.com' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('sso_return_to_host_invalid')
  })

  it('rejects without session cookie with 401', async () => {
    const { app } = buildTestApp()

    const res = await app.request('/api/v1/ui/sso/code', {
      method: 'POST',
      headers: {
        [`${CSRF_COOKIE_NAME}`]: TEST_CSRF,
        'x-rp-csrf': TEST_CSRF,
        'content-type': 'application/json',
        cookie: `${CSRF_COOKIE_NAME}=${TEST_CSRF}`,
      },
      body: JSON.stringify({ client: 'events', return_to_host: 'localhost:5174' }),
    })

    expect(res.status).toBe(401)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('session_required')
  })

  it('rejects without CSRF header with 403', async () => {
    const { app, repos } = buildTestApp()
    const userId = await createUser(repos)
    const sessionCookie = await signedInCookie(repos, userId)

    // Cookie present but no X-RP-CSRF header
    const res = await app.request('/api/v1/ui/sso/code', {
      method: 'POST',
      headers: {
        cookie: sessionCookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ client: 'events', return_to_host: 'localhost:5174' }),
    })

    expect(res.status).toBe(403)
  })
})

// -------------------------------------------------------------------
// Exchange: POST /api/v1/sdk/sso/exchange
// -------------------------------------------------------------------

const EVENTS_BEARER = `Bearer ${ENV_WITH_EVENTS.EVENTS_API_KEY}`

describe('POST /api/v1/sdk/sso/exchange', () => {
  async function mintCode(
    app: ReturnType<typeof buildTestApp>['app'],
    repos: ReturnType<typeof buildInMemoryRepos>,
    userId: UserId,
  ): Promise<string> {
    const sessionCookie = await signedInCookie(repos, userId)
    const res = await app.request('/api/v1/ui/sso/code', {
      method: 'POST',
      headers: {
        ...withCsrf(sessionCookie),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ client: 'events', return_to_host: 'localhost:5174' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { code: string }
    return body.code
  }

  it('happy path: returns 200 with all user fields + session', async () => {
    const { app, repos } = buildTestApp()
    const userId = await createUser(repos)
    const code = await mintCode(app, repos, userId)

    const res = await app.request('/api/v1/sdk/sso/exchange', {
      method: 'POST',
      headers: {
        authorization: EVENTS_BEARER,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.user_id).toBe(userId)
    expect(body.email).toBe('alice@example.com')
    expect(body.email_verified).toBe(true)
    expect(body.display_name).toBe('alice')
    expect(body.first_name).toBeNull()
    expect(body.last_name).toBeNull()
    expect(body.picture_url).toBeNull()
    expect(body.username).toBe('alice')
    expect(typeof body.session_bearer).toBe('string')
    expect((body.session_bearer as string).startsWith('rps_live_')).toBe(true)
    expect(typeof body.session_absolute_expires_at).toBe('string')
    // Validate ISO string
    expect(() => new Date(body.session_absolute_expires_at as string)).not.toThrow()

    // sso_codes row is now consumed
    const codeHash = hashToken(code)
    const row = await repos.ssoCodes.findByCodeHash(codeHash)
    expect(row!.consumedAt).not.toBeNull()

    // A sessions row exists for the issued bearer
    const sessionHash = hashToken(body.session_bearer as string)
    const sessionRow = await repos.sessions.findByIdHash(sessionHash)
    expect(sessionRow).not.toBeNull()
    expect(sessionRow!.userId).toBe(userId)
  })

  it('rejects expired code with 400 sso_code_invalid; consumedAt stays null', async () => {
    const { app, repos } = buildTestApp()
    const userId = await createUser(repos)

    // Insert an already-expired code directly
    const fakeRaw = TOKEN_PREFIXES.sso + 'A'.repeat(43)
    const codeHash = hashToken(fakeRaw)
    await repos.ssoCodes.create({
      codeHash,
      userId,
      tenantId: 'rallypoint',
      client: 'events',
      returnToHost: 'localhost:5174',
      expiresAt: new Date(Date.now() - 1000), // already expired
    })

    const res = await app.request('/api/v1/sdk/sso/exchange', {
      method: 'POST',
      headers: {
        authorization: EVENTS_BEARER,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code: fakeRaw }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('sso_code_invalid')

    // consumedAt must NOT be set
    const row = await repos.ssoCodes.findByCodeHash(codeHash)
    expect(row!.consumedAt).toBeNull()
  })

  it('rejects already-consumed code with 409 sso_code_already_consumed', async () => {
    const { app, repos } = buildTestApp()
    const userId = await createUser(repos)
    const code = await mintCode(app, repos, userId)

    // First exchange — success
    const first = await app.request('/api/v1/sdk/sso/exchange', {
      method: 'POST',
      headers: {
        authorization: EVENTS_BEARER,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code }),
    })
    expect(first.status).toBe(200)

    // Second exchange with same code
    const second = await app.request('/api/v1/sdk/sso/exchange', {
      method: 'POST',
      headers: {
        authorization: EVENTS_BEARER,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code }),
    })
    expect(second.status).toBe(409)
    const body = (await second.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('sso_code_already_consumed')
  })

  it('returns 404 when EVENTS_API_KEY env is unset (anti-fingerprint)', async () => {
    const { app } = buildTestApp(ENV_NO_KEY)

    const res = await app.request('/api/v1/sdk/sso/exchange', {
      method: 'POST',
      headers: {
        authorization: 'Bearer anything',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code: 'rpsso_whatever' }),
    })

    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('not_found')
  })

  it('rejects wrong EVENTS_API_KEY with 403', async () => {
    const { app } = buildTestApp()

    const res = await app.request('/api/v1/sdk/sso/exchange', {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-key-here',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code: 'rpsso_whatever' }),
    })

    expect(res.status).toBe(403)
  })

  it('rejects malformed code (no rpsso_ prefix) with 400 sso_code_invalid', async () => {
    const { app } = buildTestApp()

    const res = await app.request('/api/v1/sdk/sso/exchange', {
      method: 'POST',
      headers: {
        authorization: EVENTS_BEARER,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code: 'not-an-rpsso-token' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('sso_code_invalid')
  })

  // Per-app key compartmentalisation (Phase 0 / #159). An app key
  // that matches a configured value is *not* automatically allowed to
  // exchange any client's code — the key's bound client must match
  // the code's client field. The handler returns the same opaque
  // 400 sso_code_invalid as a bad code so a leaked key can't probe
  // for valid codes from other apps.
  it('rejects exchange when the app key belongs to a different client than the code', async () => {
    // Build an env that has BOTH events + lists keys configured + both
    // hosts. The events user mints a code for client=events; we try
    // to exchange it using the lists API key.
    const env = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      SSO_EVENTS_HOST: 'localhost:5174',
      SSO_LISTS_HOST: 'localhost:5175',
      EVENTS_API_KEY: 'test-events-api-key-32chars-minimum!!',
      LISTS_API_KEY: 'test-lists-api-key-32chars-minimum!!!!',
    })
    const { app, repos } = buildTestApp(env)
    const userId = await createUser(repos)
    const sessionCookie = await signedInCookie(repos, userId)

    // Mint a code targeting client=events.
    const mintRes = await app.request('/api/v1/ui/sso/code', {
      method: 'POST',
      headers: {
        ...withCsrf(sessionCookie),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ client: 'events', return_to_host: 'localhost:5174' }),
    })
    expect(mintRes.status).toBe(200)
    const { code } = (await mintRes.json()) as { code: string }

    // Exchange using the lists key — should be rejected as 400
    // sso_code_invalid (opaque).
    const exRes = await app.request('/api/v1/sdk/sso/exchange', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.LISTS_API_KEY!}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code }),
    })
    expect(exRes.status).toBe(400)
    const body = (await exRes.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('sso_code_invalid')

    // The code is NOT marked consumed (the legitimate events key
    // could still exchange it). Verify by replaying with the events
    // key.
    const exOk = await app.request('/api/v1/sdk/sso/exchange', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.EVENTS_API_KEY!}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code }),
    })
    expect(exOk.status).toBe(200)
  })

  // Planner client registration (#255 slice 0). The 'planner' client is
  // allowlisted and its host is gated by SSO_PLANNER_HOST, exactly like
  // events/lists/money.
  it('mints a code for client=planner when SSO_PLANNER_HOST is configured', async () => {
    const env = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      SSO_PLANNER_HOST: 'localhost:5177',
      PLANNER_API_KEY: 'test-planner-api-key-32chars-minimum!',
    })
    const { app, repos } = buildTestApp(env)
    const userId = await createUser(repos)
    const sessionCookie = await signedInCookie(repos, userId)

    const res = await app.request('/api/v1/ui/sso/code', {
      method: 'POST',
      headers: { ...withCsrf(sessionCookie), 'content-type': 'application/json' },
      body: JSON.stringify({ client: 'planner', return_to_host: 'localhost:5177' }),
    })

    expect(res.status).toBe(200)
    const { code } = (await res.json()) as { code: string }
    expect(code.startsWith('rpsso_')).toBe(true)
  })

  // Per-app compartmentalisation for the planner key (#255 slice 0 /
  // #159). A PLANNER key must not be able to exchange a LISTS-issued
  // code — same opaque 400 sso_code_invalid as any other mismatch, and
  // the code stays unconsumed for its legitimate owner.
  it('rejects exchange of a LISTS code with a PLANNER key', async () => {
    const env = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      SSO_LISTS_HOST: 'localhost:5175',
      SSO_PLANNER_HOST: 'localhost:5177',
      LISTS_API_KEY: 'test-lists-api-key-32chars-minimum!!!!',
      PLANNER_API_KEY: 'test-planner-api-key-32chars-minimum!',
    })
    const { app, repos } = buildTestApp(env)
    const userId = await createUser(repos)
    const sessionCookie = await signedInCookie(repos, userId)

    // Mint a code targeting client=lists.
    const mintRes = await app.request('/api/v1/ui/sso/code', {
      method: 'POST',
      headers: { ...withCsrf(sessionCookie), 'content-type': 'application/json' },
      body: JSON.stringify({ client: 'lists', return_to_host: 'localhost:5175' }),
    })
    expect(mintRes.status).toBe(200)
    const { code } = (await mintRes.json()) as { code: string }

    // Exchange using the planner key — rejected as opaque 400.
    const exRes = await app.request('/api/v1/sdk/sso/exchange', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.PLANNER_API_KEY!}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code }),
    })
    expect(exRes.status).toBe(400)
    const body = (await exRes.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('sso_code_invalid')

    // The code is NOT consumed — the legitimate lists key still works.
    const exOk = await app.request('/api/v1/sdk/sso/exchange', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.LISTS_API_KEY!}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code }),
    })
    expect(exOk.status).toBe(200)
  })

  // Session-family linkage (#93 single-logout). The browser session
  // that mints the code is recorded on the sso_codes row, and the
  // consumer session issued at exchange records that browser session
  // as its parentSessionId — so a later signout can cascade the family.
  it('records the minting browser session and links the exchanged session as its child', async () => {
    const { app, repos } = buildTestApp()
    const userId = await createUser(repos)
    // Issue the browser session directly so we know its idHash.
    const browser = await issueSession(repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'a'.repeat(64),
      uaHash: 'b'.repeat(64),
    })
    const sessionCookie = `${SESSION_COOKIE_NAME}=${browser.rawToken}`

    const mintRes = await app.request('/api/v1/ui/sso/code', {
      method: 'POST',
      headers: { ...withCsrf(sessionCookie), 'content-type': 'application/json' },
      body: JSON.stringify({ client: 'events', return_to_host: 'localhost:5174' }),
    })
    expect(mintRes.status).toBe(200)
    const { code } = (await mintRes.json()) as { code: string }

    // The code row remembers which browser session minted it.
    const codeRow = await repos.ssoCodes.findByCodeHash(hashToken(code))
    expect(codeRow!.mintingSessionIdHash).toBe(browser.idHash)

    const exRes = await app.request('/api/v1/sdk/sso/exchange', {
      method: 'POST',
      headers: { authorization: EVENTS_BEARER, 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    expect(exRes.status).toBe(200)
    const { session_bearer: bearer } = (await exRes.json()) as { session_bearer: string }

    // The issued consumer session is a child of the browser session.
    const childRow = await repos.sessions.findByIdHash(hashToken(bearer))
    expect(childRow!.parentSessionId).toBe(browser.idHash)
    // The browser login itself stays a top-level (parentless) session.
    expect((await repos.sessions.findByIdHash(browser.idHash))!.parentSessionId).toBeNull()
  })

  // Legacy / pre-migration codes: migration 0008 adds
  // minting_session_id_hash as nullable, so sso_codes rows that
  // existed before the column have NULL. Exchange must still work,
  // issuing a parentless (own-family) consumer session — signing out
  // of it then only deletes itself.
  it('exchanges a code with no minting session into a parentless session', async () => {
    const { app, repos } = buildTestApp()
    const userId = await createUser(repos)
    const fakeRaw = TOKEN_PREFIXES.sso + 'B'.repeat(43)
    await repos.ssoCodes.create({
      codeHash: hashToken(fakeRaw),
      userId,
      tenantId: 'rallypoint',
      // mintingSessionIdHash omitted → null (legacy row).
      client: 'events',
      returnToHost: 'localhost:5174',
      expiresAt: new Date(Date.now() + 60_000),
    })

    const res = await app.request('/api/v1/sdk/sso/exchange', {
      method: 'POST',
      headers: { authorization: EVENTS_BEARER, 'content-type': 'application/json' },
      body: JSON.stringify({ code: fakeRaw }),
    })
    expect(res.status).toBe(200)
    const { session_bearer: bearer } = (await res.json()) as { session_bearer: string }
    expect((await repos.sessions.findByIdHash(hashToken(bearer)))!.parentSessionId).toBeNull()
  })
})
