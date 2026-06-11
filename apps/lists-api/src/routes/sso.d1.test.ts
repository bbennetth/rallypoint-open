import { env } from 'cloudflare:test'
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
import { LISTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 integration tests for the lists SSO + session-lifecycle routes.
// Replaces sso.it.test.ts.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

const FAKE_USER = {
  userId: 'user_01HFAKELISTSUSERID0000000000',
  email: 'lists-test@example.com',
  emailVerified: true,
  displayName: 'Lists Tester',
  pictureUrl: null,
  username: 'liststester',
  sessionBearer: 'rpid_session_bearer_stub_value_for_testing',
  sessionAbsoluteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
}

describe('D1 integration — lists SSO + session surface', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

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

  // Named so the single-logout tests can assert the upstream call and
  // force an RPID outage on the best-effort path (#217).
  const signoutRpidBearer = vi.fn<(bearer: string) => Promise<void>>().mockResolvedValue(undefined)

  const services: Services = {
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer,
    },
    rpidSso: {
      exchange: vi.fn<(code: string) => Promise<{ ok: true; result: typeof FAKE_USER } | { ok: false; reason: 'invalid' | 'already_consumed' }>>()
        .mockResolvedValue({ ok: true as const, result: FAKE_USER }),
    },
    profiles: { lookup: profilesLookup },
    settings: { get: settingsGet, patch: settingsPatch },
  }

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })

  // Mint a lists session in the DB and return the raw bearer.
  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(LISTS_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { LISTS_SESSION_KEY_V1: envVars.LISTS_SESSION_KEY_V1 },
      keyVersion: envVars.LISTS_SESSION_KEY_VERSION,
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
    return `${envVars.LISTS_CSRF_COOKIE_NAME}=${CSRF}`
  }

  function sessionHeaders(bearer: string): Record<string, string> {
    return {
      cookie: `${envVars.LISTS_SESSION_COOKIE_NAME}=${bearer}; ${csrfCookiePair()}`,
      'x-rp-csrf': CSRF,
    }
  }

  // --- /session returns user id ---

  it('GET /session with a valid session cookie returns the user id', async () => {
    const userId = 'user_01HLISTSTEST00000000000001'
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
    const userId = 'user_01HLISTSTEST00000000000010'
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
    const userId = 'user_01HLISTSTEST00000000000011'
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
    const userId = 'user_01HLISTSTEST00000000000030'
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
    const userId = 'user_01HLISTSTEST00000000000031'
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
    const userId = 'user_01HLISTSTEST00000000000012'
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

  it('GET /settings/lists (own client namespace) is allowed', async () => {
    const userId = 'user_01HLISTSTEST00000000000013'
    const bearer = await loginAs(userId)
    const res = await app.request('http://localhost/api/v1/ui/settings/lists', {
      method: 'GET',
      headers: sessionHeaders(bearer),
    })
    expect(res.status).toBe(200)
    expect(settingsGet).toHaveBeenLastCalledWith(userId, 'lists')
  })

  it('GET /settings/events (foreign namespace) is 403 without hitting RPID', async () => {
    const userId = 'user_01HLISTSTEST00000000000014'
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
    const userId = 'user_01HLISTSTEST00000000000015'
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
    const userId = 'user_01HLISTSTEST00000000000016'
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
    const userId = 'user_01HLISTSTEST00000000000017'
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

  it('maps an RPID SettingsError onto the lists error envelope', async () => {
    const userId = 'user_01HLISTSTEST00000000000018'
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

  // --- ip_hash is a daily-salted hash ---

  it('POST /sso/exchange stores a daily-salted ip_hash matching extractIp+hashIp', async () => {
    const knownIp = '198.51.100.77'
    const stateNonce = 'state_iphash_lists'
    const res = await app.request('http://localhost/api/v1/ui/sso/exchange', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${envVars.LISTS_SSO_STATE_COOKIE_NAME}=${stateNonce}; ${csrfCookiePair()}`,
        'x-rp-csrf': CSRF,
        'x-forwarded-for': knownIp,
      },
      body: JSON.stringify({ code: 'test-code-iphash', state: stateNonce }),
    })
    expect(res.status).toBe(204)
    const setCookies = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? '']
    const sessionCookieEntry = setCookies.find((h) =>
      h.startsWith(envVars.LISTS_SESSION_COOKIE_NAME + '='),
    )
    expect(sessionCookieEntry).toBeTruthy()
    const bearerMatch = sessionCookieEntry!.match(
      new RegExp(`${envVars.LISTS_SESSION_COOKIE_NAME}=([^;]+)`),
    )
    const bearer = bearerMatch![1]!
    const row = await repos.sessions.findByIdHash(hashToken(bearer))
    expect(row).not.toBeNull()
    const expectedIpHash = hashIp(
      extractIp({ headers: new Headers({ 'x-forwarded-for': knownIp }), policy: 'legacy' }),
      dailySalt(envVars.LISTS_SESSION_KEY_V1),
    )
    expect(row!.ipHash).toBe(expectedIpHash)
  })

  // --- signout / single-logout (#93, #217) ---

  it('POST /signout propagates the decrypted RPID bearer upstream, deletes the row, clears the cookie (#93)', async () => {
    signoutRpidBearer.mockClear()
    const userId = 'user_01HLISTSTEST00000000000020'
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
    expect(setCookie).toContain(envVars.LISTS_SESSION_COOKIE_NAME)
    expect(setCookie).toMatch(/Max-Age=0|expires=Thu, 01 Jan 1970/i)
  })

  it('POST /signout still succeeds locally when the upstream RPID signout fails (best-effort, #93)', async () => {
    signoutRpidBearer.mockClear()
    signoutRpidBearer.mockRejectedValueOnce(new Error('rpid_transport_error'))
    const userId = 'user_01HLISTSTEST00000000000021'
    const bearer = await loginAs(userId)
    const idHash = hashToken(bearer)

    const res = await app.request('http://localhost/api/v1/ui/signout', {
      method: 'POST',
      headers: sessionHeaders(bearer),
    })
    // RPID was unreachable, but the local signout must not be blocked.
    expect(res.status).toBe(204)
    expect(signoutRpidBearer).toHaveBeenCalledWith(userId)
    expect(await repos.sessions.findByIdHash(idHash)).toBeNull()
    expect(res.headers.get('set-cookie') ?? '').toContain(envVars.LISTS_SESSION_COOKIE_NAME)
  })

  it('POST /signout with no session cookie is a 204 no-op (cookie cleared, no upstream call)', async () => {
    signoutRpidBearer.mockClear()
    const res = await app.request('http://localhost/api/v1/ui/signout', {
      method: 'POST',
      headers: { cookie: csrfCookiePair(), 'x-rp-csrf': CSRF },
    })
    expect(res.status).toBe(204)
    expect(signoutRpidBearer).not.toHaveBeenCalled()
    expect(res.headers.get('set-cookie') ?? '').toContain(envVars.LISTS_SESSION_COOKIE_NAME)
  })

  it('POST /signout with an already-deleted session row is a 204 no-op (no upstream call)', async () => {
    signoutRpidBearer.mockClear()
    const userId = 'user_01HLISTSTEST00000000000022'
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
    expect(res.headers.get('set-cookie') ?? '').toContain(envVars.LISTS_SESSION_COOKIE_NAME)
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
