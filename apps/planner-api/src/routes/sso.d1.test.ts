import { env as testEnv } from 'cloudflare:test'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { SettingsError, type UserBatchEntry } from '@rallypoint/id-client'
import { generateRawToken, hashToken, extractIp, dailySalt, hashIp } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { PLANNER_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 integration tests for the planner SSO + session-lifecycle routes
// against a Miniflare D1 (planner-db). Replaces sso.it.test.ts. RPID is
// stubbed at the services layer: rpidSso.exchange returns a canned user
// record; idClient.verifyRpidBearer echoes the decrypted bearer as the
// user id, so a session row sealed with plaintext=<userId> resolves to
// that user. CSRF is satisfied with a matched cookie+header pair; no
// Origin header is sent (allowed — same as a same-origin GET).

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

const FAKE_USER = {
  userId: 'user_01HFAKEPLANNERUSERID000000',
  email: 'planner-test@example.com',
  emailVerified: true,
  displayName: 'Planner Tester',
  pictureUrl: null,
  username: 'plannertester',
  sessionBearer: 'rpid_session_bearer_stub_value_for_testing',
  sessionAbsoluteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
}

describe('D1 integration — planner SSO + session surface', () => {
  let repos: Repos
  let env: Env
  let app: Hono<HonoApp>

  // Stubbed services: the sso exchange returns a canned user; the
  // verifier trusts any bearer and returns it verbatim as the user id.
  // Spy-able settings stub so the fold-in + passthrough wiring is
  // assertable. `get` defaults to an empty doc, `patch` echoes the patch.
  const settingsGet =
    vi.fn<(userId: string, namespace: string) => Promise<Record<string, unknown>>>()
      .mockResolvedValue({})
  const settingsPatch =
    vi.fn<(userId: string, namespace: string, patch: Record<string, unknown>) => Promise<Record<string, unknown>>>()
      .mockImplementation(async (_u, _n, patch) => patch)

  // Spy-able profiles stub so the user-bar fold-in is assertable. Defaults
  // to null (no profile resolved); individual tests override per-call.
  const profilesLookup =
    vi.fn<(userId: string) => Promise<UserBatchEntry | null>>().mockResolvedValue(null)

  // Named so the SSO-passthrough tests can drive the failure branches
  // (#272): exchange → already_consumed, signout → upstream RPID hiccup.
  const signoutRpidBearer = vi.fn<(bearer: string) => Promise<void>>().mockResolvedValue(undefined)
  const exchange =
    vi.fn<(code: string) => Promise<{ ok: true; result: typeof FAKE_USER } | { ok: false; reason: 'invalid' | 'already_consumed' }>>()
      .mockResolvedValue({ ok: true as const, result: FAKE_USER })

  const services: Services = {
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer,
    },
    rpidSso: { exchange },
    settings: { get: settingsGet, patch: settingsPatch },
    profiles: { lookup: profilesLookup },
  }

  beforeAll(() => {
    repos = buildD1Repos(createDb(testEnv.DB))
    env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env, logger: undefined, repos, services })
  })

  // Mint a planner session in the DB and return the raw bearer.
  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(PLANNER_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { PLANNER_SESSION_KEY_V1: env.PLANNER_SESSION_KEY_V1 },
      keyVersion: env.PLANNER_SESSION_KEY_VERSION,
    })
    await repos.sessions.create({
      idHash,
      userId,
      rpidBearerCiphertext: sealed.ciphertext,
      rpidBearerNonce: sealed.nonce,
      rpidBearerKeyVersion: sealed.keyVersion,
      absoluteExpiresAt: new Date(Date.now() + 3_600_000),
      ipHash: '',
      uaHash: '',
    })
    return rawBearer
  }

  function csrfCookiePair(): string {
    return `${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`
  }

  function sessionHeaders(bearer: string): Record<string, string> {
    return {
      cookie: `${env.PLANNER_SESSION_COOKIE_NAME}=${bearer}; ${csrfCookiePair()}`,
      'x-rp-csrf': CSRF,
    }
  }

  // --- health (public) ---

  it('returns ok from the public health route', async () => {
    const res = await app.request('http://localhost/api/v1/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; service: string }
    expect(body.ok).toBe(true)
    expect(body.service).toBe('rallypoint-planner')
  })

  // --- csrf issue ---

  it('GET /csrf issues a token cookie and body', async () => {
    const res = await app.request('http://localhost/api/v1/ui/csrf', {
      method: 'GET',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; csrfToken: string }
    expect(body.ok).toBe(true)
    expect(typeof body.csrfToken).toBe('string')
    expect(body.csrfToken.length).toBeGreaterThan(20)
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toContain(env.PLANNER_CSRF_COOKIE_NAME)
  })

  // --- sso exchange happy path ---

  it('POST /sso/exchange sets session cookie and writes a session row', async () => {
    const stateNonce = 'test-state-nonce-12345'
    const res = await app.request('http://localhost/api/v1/ui/sso/exchange', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${env.PLANNER_SSO_STATE_COOKIE_NAME}=${stateNonce}; ${csrfCookiePair()}`,
        'x-rp-csrf': CSRF,
      },
      body: JSON.stringify({ code: 'test-code-123', state: stateNonce }),
    })
    expect(res.status).toBe(204)

    // Session cookie must be present in Set-Cookie
    const setCookieHeaders = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? '']
    const sessionCookie = setCookieHeaders.find((h) =>
      h.startsWith(env.PLANNER_SESSION_COOKIE_NAME + '='),
    )
    expect(sessionCookie).toBeTruthy()

    // Extract the bearer and confirm the row is in the DB
    const bearerMatch = sessionCookie!.match(
      new RegExp(`${env.PLANNER_SESSION_COOKIE_NAME}=([^;]+)`),
    )
    expect(bearerMatch).toBeTruthy()
    const bearer = bearerMatch![1]!
    const idHash = hashToken(bearer)
    const row = await repos.sessions.findByIdHash(idHash)
    expect(row).toBeTruthy()
    expect(row!.userId).toBe(FAKE_USER.userId)
  })

  // --- ip_hash is a daily-salted hash ---

  it('POST /sso/exchange stores a daily-salted ip_hash matching extractIp+hashIp', async () => {
    const knownIp = '203.0.113.11'
    const stateNonce = 'state_iphash_planner'
    const res = await app.request('http://localhost/api/v1/ui/sso/exchange', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${env.PLANNER_SSO_STATE_COOKIE_NAME}=${stateNonce}; ${csrfCookiePair()}`,
        'x-rp-csrf': CSRF,
        'x-forwarded-for': knownIp,
      },
      body: JSON.stringify({ code: 'test-code-iphash', state: stateNonce }),
    })
    expect(res.status).toBe(204)
    const setCookies = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? '']
    const sessionCookieEntry = setCookies.find((h) =>
      h.startsWith(env.PLANNER_SESSION_COOKIE_NAME + '='),
    )
    expect(sessionCookieEntry).toBeTruthy()
    const bearerMatch = sessionCookieEntry!.match(
      new RegExp(`${env.PLANNER_SESSION_COOKIE_NAME}=([^;]+)`),
    )
    const bearer = bearerMatch![1]!
    const row = await repos.sessions.findByIdHash(hashToken(bearer))
    expect(row).not.toBeNull()
    const expectedIpHash = hashIp(
      extractIp({ headers: new Headers({ 'x-forwarded-for': knownIp }), policy: 'legacy' }),
      dailySalt(env.PLANNER_SESSION_KEY_V1),
    )
    expect(row!.ipHash).toBe(expectedIpHash)
  })

  // --- sso exchange state mismatch ---

  it('POST /sso/exchange returns 400 on state mismatch', async () => {
    const res = await app.request('http://localhost/api/v1/ui/sso/exchange', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${env.PLANNER_SSO_STATE_COOKIE_NAME}=correct-state; ${csrfCookiePair()}`,
        'x-rp-csrf': CSRF,
      },
      body: JSON.stringify({ code: 'any-code', state: 'wrong-state' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('sso_state_mismatch')
  })

  // --- sso exchange already-consumed (#272) ---

  it('POST /sso/exchange maps an already-consumed code to 409', async () => {
    const stateNonce = 'state-already-consumed'
    // State matches so the handler proceeds to the RPID exchange, which
    // reports the one-time code was already spent.
    exchange.mockResolvedValueOnce({ ok: false as const, reason: 'already_consumed' })
    const res = await app.request('http://localhost/api/v1/ui/sso/exchange', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${env.PLANNER_SSO_STATE_COOKIE_NAME}=${stateNonce}; ${csrfCookiePair()}`,
        'x-rp-csrf': CSRF,
      },
      body: JSON.stringify({ code: 'consumed-code', state: stateNonce }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('sso_code_already_consumed')
  })

  // --- /session returns user id ---

  it('GET /session with a valid session cookie returns the user id', async () => {
    const userId = 'user_01HPLANNERTEST0000000001'
    const bearer = await loginAs(userId)

    const res = await app.request('http://localhost/api/v1/ui/session', {
      method: 'GET',
      headers: sessionHeaders(bearer),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user_id: string }
    expect(body.user_id).toBe(userId)
  })

  // --- /session folds in the shared settings doc ---

  it('GET /session folds the shared settings doc in for the session user', async () => {
    const userId = 'user_01HPLANNERTEST0000000010'
    const bearer = await loginAs(userId)
    settingsGet.mockResolvedValueOnce({ themeMode: 'light', themeColor: 'pink' })

    const res = await app.request('http://localhost/api/v1/ui/session', {
      method: 'GET',
      headers: sessionHeaders(bearer),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      user_id: string
      settings: Record<string, unknown>
    }
    expect(body.user_id).toBe(userId)
    expect(body.settings).toEqual({ themeMode: 'light', themeColor: 'pink' })
    expect(settingsGet).toHaveBeenCalledWith(userId, 'shared')
  })

  it('GET /session degrades to an empty settings doc when the fold-in fails', async () => {
    const userId = 'user_01HPLANNERTEST0000000011'
    const bearer = await loginAs(userId)
    settingsGet.mockRejectedValueOnce(new SettingsError(503, 'upstream', 'down'))

    const res = await app.request('http://localhost/api/v1/ui/session', {
      method: 'GET',
      headers: sessionHeaders(bearer),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user_id: string; settings: unknown }
    expect(body.settings).toEqual({})
  })

  // --- /session folds in the RPID profile (user bar) ---

  it('GET /session folds the RPID profile in for the session user', async () => {
    const userId = 'user_01HPLANNERTEST0000000020'
    const bearer = await loginAs(userId)
    profilesLookup.mockResolvedValueOnce({
      user_id: userId,
      email: 'bar@example.com',
      email_verified: true,
      display_name: 'Bar User',
      first_name: 'Bar',
      last_name: 'User',
      picture_url: 'https://id.example/api/v1/avatars/' + userId,
    } as UserBatchEntry)

    const res = await app.request('http://localhost/api/v1/ui/session', {
      method: 'GET',
      headers: sessionHeaders(bearer),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      user_id: string
      profile: {
        username: string | null
        first_name: string | null
        last_name: string | null
        picture_url: string | null
        email: string | null
      } | null
    }
    expect(body.profile).toEqual({
      username: 'Bar User',
      first_name: 'Bar',
      last_name: 'User',
      picture_url: 'https://id.example/api/v1/avatars/' + userId,
      email: 'bar@example.com',
    })
    expect(profilesLookup).toHaveBeenCalledWith(userId)
  })

  it('GET /session degrades profile to null when the batch lookup throws', async () => {
    const userId = 'user_01HPLANNERTEST0000000021'
    const bearer = await loginAs(userId)
    profilesLookup.mockRejectedValueOnce(new Error('rpid down'))

    const res = await app.request('http://localhost/api/v1/ui/session', {
      method: 'GET',
      headers: sessionHeaders(bearer),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user_id: string; profile: unknown }
    expect(body.profile).toBeNull()
  })

  // --- /settings passthrough ---

  it('GET /settings/shared returns the namespace doc for the session user', async () => {
    const userId = 'user_01HPLANNERTEST0000000012'
    const bearer = await loginAs(userId)
    settingsGet.mockResolvedValueOnce({ themeMode: 'dark' })

    const res = await app.request('http://localhost/api/v1/ui/settings/shared', {
      method: 'GET',
      headers: sessionHeaders(bearer),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ settings: { themeMode: 'dark' } })
    expect(settingsGet).toHaveBeenLastCalledWith(userId, 'shared')
  })

  it('GET /settings/planner (own client namespace) is allowed', async () => {
    const userId = 'user_01HPLANNERTEST0000000013'
    const bearer = await loginAs(userId)
    const res = await app.request('http://localhost/api/v1/ui/settings/planner', {
      method: 'GET',
      headers: sessionHeaders(bearer),
    })
    expect(res.status).toBe(200)
    expect(settingsGet).toHaveBeenLastCalledWith(userId, 'planner')
  })

  it('GET /settings/events (foreign namespace) is 403 without hitting RPID', async () => {
    const userId = 'user_01HPLANNERTEST0000000014'
    const bearer = await loginAs(userId)
    settingsGet.mockClear()
    const res = await app.request('http://localhost/api/v1/ui/settings/events', {
      method: 'GET',
      headers: sessionHeaders(bearer),
    })
    expect(res.status).toBe(403)
    expect(settingsGet).not.toHaveBeenCalled()
  })

  it('GET /settings without a session cookie returns 401', async () => {
    const res = await app.request('http://localhost/api/v1/ui/settings/shared', {
      method: 'GET',
      headers: { cookie: csrfCookiePair(), 'x-rp-csrf': CSRF },
    })
    expect(res.status).toBe(401)
  })

  it('PATCH /settings/shared forwards the patch and returns the merged doc', async () => {
    const userId = 'user_01HPLANNERTEST0000000015'
    const bearer = await loginAs(userId)
    settingsPatch.mockResolvedValueOnce({ themeMode: 'light', themeColor: 'red' })

    const res = await app.request('http://localhost/api/v1/ui/settings/shared', {
      method: 'PATCH',
      headers: { ...sessionHeaders(bearer), 'content-type': 'application/json' },
      body: JSON.stringify({ themeMode: 'light' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ settings: { themeMode: 'light', themeColor: 'red' } })
    expect(settingsPatch).toHaveBeenLastCalledWith(userId, 'shared', { themeMode: 'light' })
  })

  it('PATCH /settings/shared with a non-object body is 400', async () => {
    const userId = 'user_01HPLANNERTEST0000000016'
    const bearer = await loginAs(userId)
    settingsPatch.mockClear()
    const res = await app.request('http://localhost/api/v1/ui/settings/shared', {
      method: 'PATCH',
      headers: { ...sessionHeaders(bearer), 'content-type': 'application/json' },
      body: JSON.stringify(['not', 'an', 'object']),
    })
    expect(res.status).toBe(400)
    expect(settingsPatch).not.toHaveBeenCalled()
  })

  it('PATCH /settings/events (foreign namespace) is 403', async () => {
    const userId = 'user_01HPLANNERTEST0000000017'
    const bearer = await loginAs(userId)
    settingsPatch.mockClear()
    const res = await app.request('http://localhost/api/v1/ui/settings/events', {
      method: 'PATCH',
      headers: { ...sessionHeaders(bearer), 'content-type': 'application/json' },
      body: JSON.stringify({ x: 1 }),
    })
    expect(res.status).toBe(403)
    expect(settingsPatch).not.toHaveBeenCalled()
  })

  it('maps an RPID SettingsError onto the planner error envelope', async () => {
    const userId = 'user_01HPLANNERTEST0000000018'
    const bearer = await loginAs(userId)
    settingsPatch.mockRejectedValueOnce(new SettingsError(400, 'settings_too_large', 'too big'))
    const res = await app.request('http://localhost/api/v1/ui/settings/shared', {
      method: 'PATCH',
      headers: { ...sessionHeaders(bearer), 'content-type': 'application/json' },
      body: JSON.stringify({ x: 1 }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('settings_too_large')
  })

  // --- signout deletes row and clears cookie ---

  it('POST /signout deletes the session row and clears the cookie', async () => {
    const userId = 'user_01HPLANNERTEST0000000002'
    const bearer = await loginAs(userId)
    const idHash = hashToken(bearer)

    // Confirm row exists
    const before = await repos.sessions.findByIdHash(idHash)
    expect(before).toBeTruthy()

    const res = await app.request('http://localhost/api/v1/ui/signout', {
      method: 'POST',
      headers: sessionHeaders(bearer),
    })
    expect(res.status).toBe(204)

    // Row should be gone
    const after = await repos.sessions.findByIdHash(idHash)
    expect(after).toBeNull()

    // The response must clear the session cookie
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(env.PLANNER_SESSION_COOKIE_NAME)
    expect(setCookie).toMatch(/Max-Age=0|expires=Thu, 01 Jan 1970/i)
  })

  // --- signout / single-logout guard branches (#93, mirrors #217) ---

  it('POST /signout propagates the decrypted RPID bearer upstream, deletes the row, clears the cookie (#93)', async () => {
    signoutRpidBearer.mockClear()
    const userId = 'user_01HPLANNERTEST0000000004'
    const bearer = await loginAs(userId)
    const idHash = hashToken(bearer)
    expect(await repos.sessions.findByIdHash(idHash)).not.toBeNull()

    const res = await app.request('http://localhost/api/v1/ui/signout', {
      method: 'POST',
      headers: sessionHeaders(bearer),
    })
    expect(res.status).toBe(204)
    // The handler decrypted the sealed bearer (loginAs seals plaintext =
    // userId) and forwarded it to RPID's single-logout.
    expect(signoutRpidBearer).toHaveBeenCalledWith(userId)
    expect(await repos.sessions.findByIdHash(idHash)).toBeNull()
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(env.PLANNER_SESSION_COOKIE_NAME)
    expect(setCookie).toMatch(/Max-Age=0|expires=Thu, 01 Jan 1970/i)
  })

  it('POST /signout with no session cookie is a 204 no-op (cookie cleared, no upstream call)', async () => {
    signoutRpidBearer.mockClear()
    const res = await app.request('http://localhost/api/v1/ui/signout', {
      method: 'POST',
      headers: { cookie: csrfCookiePair(), 'x-rp-csrf': CSRF },
    })
    expect(res.status).toBe(204)
    expect(signoutRpidBearer).not.toHaveBeenCalled()
    expect(res.headers.get('set-cookie') ?? '').toContain(env.PLANNER_SESSION_COOKIE_NAME)
  })

  it('POST /signout with an already-deleted session row is a 204 no-op (no upstream call)', async () => {
    signoutRpidBearer.mockClear()
    const userId = 'user_01HPLANNERTEST0000000005'
    const bearer = await loginAs(userId)
    const idHash = hashToken(bearer)
    // Drop the row out from under the handler, then sign out with the
    // now-stale cookie: the inner `if (row)` guard must short-circuit.
    await repos.sessions.deleteByIdHash(idHash)
    expect(await repos.sessions.findByIdHash(idHash)).toBeNull()

    const res = await app.request('http://localhost/api/v1/ui/signout', {
      method: 'POST',
      headers: sessionHeaders(bearer),
    })
    expect(res.status).toBe(204)
    expect(signoutRpidBearer).not.toHaveBeenCalled()
    expect(res.headers.get('set-cookie') ?? '').toContain(env.PLANNER_SESSION_COOKIE_NAME)
  })

  // --- signout best-effort: RPID hiccup must not block local signout (#272) ---

  it('POST /signout still succeeds locally when the upstream RPID signout fails (best-effort, #93)', async () => {
    signoutRpidBearer.mockClear()
    signoutRpidBearer.mockRejectedValueOnce(new Error('rpid_transport_error'))
    const userId = 'user_01HPLANNERTEST0000000003'
    const bearer = await loginAs(userId)
    const idHash = hashToken(bearer)

    const res = await app.request('http://localhost/api/v1/ui/signout', {
      method: 'POST',
      headers: sessionHeaders(bearer),
    })

    // RPID was unreachable, but the local signout must not be blocked.
    expect(res.status).toBe(204)
    // The handler decrypted the sealed bearer (loginAs seals plaintext =
    // userId) and still attempted the upstream single-logout before
    // tearing down the local row.
    expect(signoutRpidBearer).toHaveBeenCalledWith(userId)
    expect(await repos.sessions.findByIdHash(idHash)).toBeNull()
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(env.PLANNER_SESSION_COOKIE_NAME)
    expect(setCookie).toMatch(/Max-Age=0|expires=Thu, 01 Jan 1970/i)
  })

  // --- /session without cookie returns 401 ---

  it('GET /session without a session cookie returns 401', async () => {
    const res = await app.request('http://localhost/api/v1/ui/session', {
      method: 'GET',
      headers: { cookie: csrfCookiePair(), 'x-rp-csrf': CSRF },
    })
    expect(res.status).toBe(401)
  })
})
