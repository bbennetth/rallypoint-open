import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services, IdClientService, RpidSsoService } from '../services/types.js'
import { SettingsError, type UserBatchEntry } from '@rallypoint/id-client'
import { makeNoopMoneyClient, makeNoopListsClient, makeStubObjectStore } from './_test-services.js'
import { generateRawToken, hashToken, extractIp, dailySalt, hashIp } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// SSO exchange + the session-middleware revocation cascade, against a
// real Postgres. RPID is stubbed: rpidSso.exchange yields a canned
// result and idClient.verifyRpidBearer is flipped per-test to model
// a live vs. revoked RPID session.


const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

function cookieValue(setCookies: string[], name: string): string | null {
  for (const c of setCookies) {
    const m = c.match(new RegExp(`^${name}=([^;]*)`))
    if (m) return m[1] ?? null
  }
  return null
}

describe('D1 integration — SSO exchange + revocation cascade', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  let exchangeResult: Awaited<ReturnType<RpidSsoService['exchange']>> = {
    ok: false,
    reason: 'invalid',
  }
  let verifyResult: Awaited<ReturnType<IdClientService['verifyRpidBearer']>> = {
    ok: true,
    userId: 'user_sso',
  }
  // Single-logout spy (#93): record the RPID bearers the signout
  // handler propagates upstream, and let a test force an RPID outage.
  let signoutCalls: string[] = []
  let signoutShouldThrow = false

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

  const services: Services = {
    idClient: {
      verifyRpidBearer: async () => verifyResult,
      signoutRpidBearer: async (bearer: string) => {
        signoutCalls.push(bearer)
        if (signoutShouldThrow) throw new Error('rpid_transport_error')
      },
      batchLookupUsers: async () => [],
    },
    rpidSso: {
      exchange: async () => exchangeResult,
    },
    rpidReauth: {
      verify: async () => ({ ok: true as const }),
    },
    profiles: { lookup: profilesLookup },
    objectStore: makeStubObjectStore(),
    listsClient: makeNoopListsClient(),
    moneyClient: makeNoopMoneyClient(),
    weather: {
      getEventWeather: async () => ({ forecast: null, airQuality: null, issuedAt: new Date().toISOString() }),
    },
    settings: { get: settingsGet, patch: settingsPatch },
  }

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })


  beforeEach(() => {
    exchangeResult = { ok: false, reason: 'invalid' }
    verifyResult = { ok: true, userId: 'user_sso' }
    signoutCalls = []
    signoutShouldThrow = false
  })

  // Mint a real events session and return its cookie value.
  async function mintSession(opts: {
    userId: string
    sessionBearer: string
    state: string
  }): Promise<string> {
    exchangeResult = {
      ok: true,
      result: {
        userId: opts.userId,
        email: `${opts.userId}@example.com`,
        emailVerified: true,
        displayName: null,
        pictureUrl: null,
        username: opts.userId,
        sessionBearer: opts.sessionBearer,
        sessionAbsoluteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    }
    const minted = await app.request('http://localhost/api/v1/ui/sso/exchange', {
      method: 'POST',
      headers: exchangeHeaders(opts.state),
      body: JSON.stringify({ code: 'rpsso_code', state: opts.state }),
    })
    return cookieValue(minted.headers.getSetCookie(), envVars.EVENTS_SESSION_COOKIE_NAME)!
  }

  function signoutHeaders(sessionCookie: string): Record<string, string> {
    return {
      cookie: [
        `${envVars.EVENTS_SESSION_COOKIE_NAME}=${sessionCookie}`,
        `${envVars.EVENTS_CSRF_COOKIE_NAME}=${CSRF}`,
      ].join('; '),
      'x-rp-csrf': CSRF,
    }
  }

  function exchangeHeaders(state: string): Record<string, string> {
    return {
      cookie: [
        `${envVars.EVENTS_CSRF_COOKIE_NAME}=${CSRF}`,
        `${envVars.EVENTS_SSO_STATE_COOKIE_NAME}=${state}`,
      ].join('; '),
      'x-rp-csrf': CSRF,
      'content-type': 'application/json',
    }
  }

  it('exchanges a code, mints a session, and sets the session cookie', async () => {
    exchangeResult = {
      ok: true,
      result: {
        userId: 'user_happy',
        email: 'h@example.com',
        emailVerified: true,
        displayName: 'Happy',
        pictureUrl: null,
        username: 'happy',
        sessionBearer: 'rps_live_happy',
        sessionAbsoluteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    }
    const res = await app.request('http://localhost/api/v1/ui/sso/exchange', {
      method: 'POST',
      headers: exchangeHeaders('state_nonce_123'),
      body: JSON.stringify({ code: 'rpsso_code', state: 'state_nonce_123' }),
    })
    expect(res.status).toBe(204)
    const sessionCookie = cookieValue(res.headers.getSetCookie(), envVars.EVENTS_SESSION_COOKIE_NAME)
    expect(sessionCookie).toMatch(/^rpe_sess_/)
    const row = await repos.sessions.findByIdHash(hashToken(sessionCookie!))
    expect(row?.userId).toBe('user_happy')
  })

  it('stores a daily-salted ip_hash matching extractIp+hashIp for the request IP', async () => {
    const knownIp = '203.0.113.42'
    exchangeResult = {
      ok: true,
      result: {
        userId: 'user_iphash_events',
        email: 'iphash@example.com',
        emailVerified: true,
        displayName: null,
        pictureUrl: null,
        username: 'iphash_events',
        sessionBearer: 'rps_live_iphash_events',
        sessionAbsoluteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    }
    const res = await app.request('http://localhost/api/v1/ui/sso/exchange', {
      method: 'POST',
      headers: {
        ...exchangeHeaders('state_iphash_events'),
        'x-forwarded-for': knownIp,
      },
      body: JSON.stringify({ code: 'rpsso_code', state: 'state_iphash_events' }),
    })
    expect(res.status).toBe(204)
    const sessionCookie = cookieValue(res.headers.getSetCookie(), envVars.EVENTS_SESSION_COOKIE_NAME)!
    const row = await repos.sessions.findByIdHash(hashToken(sessionCookie))
    expect(row).not.toBeNull()
    const expectedIpHash = hashIp(
      extractIp({ headers: new Headers({ 'x-forwarded-for': knownIp }), policy: 'legacy' }),
      dailySalt(envVars.EVENTS_SESSION_KEY_V1),
    )
    expect(row!.ipHash).toBe(expectedIpHash)
  })

  it('rejects when the state nonce does not match the cookie', async () => {
    exchangeResult = {
      ok: true,
      result: {
        userId: 'user_x',
        email: 'x@example.com',
        emailVerified: true,
        displayName: 'X',
        pictureUrl: null,
        username: 'x',
        sessionBearer: 'rps_live_x',
        sessionAbsoluteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    }
    const res = await app.request('http://localhost/api/v1/ui/sso/exchange', {
      method: 'POST',
      headers: exchangeHeaders('cookie_state'),
      body: JSON.stringify({ code: 'rpsso_code', state: 'different_state' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('sso_state_mismatch')
  })

  it('maps an already-consumed code to 409', async () => {
    exchangeResult = { ok: false, reason: 'already_consumed' }
    const res = await app.request('http://localhost/api/v1/ui/sso/exchange', {
      method: 'POST',
      headers: exchangeHeaders('state_consumed'),
      body: JSON.stringify({ code: 'rpsso_code', state: 'state_consumed' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('sso_code_already_consumed')
  })

  it('GET /session returns the current user id for a live session', async () => {
    exchangeResult = {
      ok: true,
      result: {
        userId: 'user_session',
        email: 's@example.com',
        emailVerified: true,
        displayName: 'S',
        pictureUrl: null,
        username: 's',
        sessionBearer: 'rps_live_session',
        sessionAbsoluteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    }
    const minted = await app.request('http://localhost/api/v1/ui/sso/exchange', {
      method: 'POST',
      headers: exchangeHeaders('state_session'),
      body: JSON.stringify({ code: 'rpsso_code', state: 'state_session' }),
    })
    const sessionCookie = cookieValue(
      minted.headers.getSetCookie(),
      envVars.EVENTS_SESSION_COOKIE_NAME,
    )!
    verifyResult = { ok: true, userId: 'user_session' }
    const res = await app.request('http://localhost/api/v1/ui/session', {
      headers: { cookie: `${envVars.EVENTS_SESSION_COOKIE_NAME}=${sessionCookie}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user_id: string }
    expect(body.user_id).toBe('user_session')
  })

  it('GET /session is 401 without a session cookie', async () => {
    const res = await app.request('http://localhost/api/v1/ui/session')
    expect(res.status).toBe(401)
  })

  it('cascades a revoked RPID session: 401 + cookie cleared + row deleted', async () => {
    // First, mint a real session via a successful exchange.
    exchangeResult = {
      ok: true,
      result: {
        userId: 'user_revoke',
        email: 'r@example.com',
        emailVerified: true,
        displayName: 'R',
        pictureUrl: null,
        username: 'r',
        sessionBearer: 'rps_live_revoke',
        sessionAbsoluteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    }
    const minted = await app.request('http://localhost/api/v1/ui/sso/exchange', {
      method: 'POST',
      headers: exchangeHeaders('state_revoke'),
      body: JSON.stringify({ code: 'rpsso_code', state: 'state_revoke' }),
    })
    const sessionCookie = cookieValue(minted.headers.getSetCookie(), envVars.EVENTS_SESSION_COOKIE_NAME)!
    const idHash = hashToken(sessionCookie)
    expect(await repos.sessions.findByIdHash(idHash)).not.toBeNull()

    // Now RPID reports the underlying bearer as revoked.
    verifyResult = { ok: false, revoked: true }
    const res = await app.request('http://localhost/api/v1/ui/events', {
      headers: {
        cookie: `${envVars.EVENTS_SESSION_COOKIE_NAME}=${sessionCookie}; ${envVars.EVENTS_CSRF_COOKIE_NAME}=${CSRF}`,
        'x-rp-csrf': CSRF,
      },
    })
    expect(res.status).toBe(401)
    // The session row must be gone, and the cookie cleared.
    expect(await repos.sessions.findByIdHash(idHash)).toBeNull()
    expect(res.headers.get('set-cookie')).toContain(envVars.EVENTS_SESSION_COOKIE_NAME)
  })

  it('signout propagates the decrypted RPID bearer upstream, deletes the row, clears the cookie (#93)', async () => {
    const sessionCookie = await mintSession({
      userId: 'user_slo',
      sessionBearer: 'rps_live_slo',
      state: 'state_slo',
    })
    const idHash = hashToken(sessionCookie)
    expect(await repos.sessions.findByIdHash(idHash)).not.toBeNull()

    const res = await app.request('http://localhost/api/v1/ui/signout', {
      method: 'POST',
      headers: signoutHeaders(sessionCookie),
    })

    expect(res.status).toBe(204)
    // Upstream RPID signout was called with the bearer we sealed at
    // mint time — proving the handler decrypted the stored ciphertext.
    expect(signoutCalls).toEqual(['rps_live_slo'])
    // Local row gone + cookie cleared.
    expect(await repos.sessions.findByIdHash(idHash)).toBeNull()
    expect(res.headers.get('set-cookie')).toContain(envVars.EVENTS_SESSION_COOKIE_NAME)
  })

  it('signout still succeeds locally when the upstream RPID signout fails (best-effort, #93)', async () => {
    const sessionCookie = await mintSession({
      userId: 'user_slo_down',
      sessionBearer: 'rps_live_slo_down',
      state: 'state_slo_down',
    })
    const idHash = hashToken(sessionCookie)
    signoutShouldThrow = true

    const res = await app.request('http://localhost/api/v1/ui/signout', {
      method: 'POST',
      headers: signoutHeaders(sessionCookie),
    })

    // RPID was unreachable, but the local signout must not be blocked.
    expect(res.status).toBe(204)
    expect(signoutCalls).toEqual(['rps_live_slo_down'])
    expect(await repos.sessions.findByIdHash(idHash)).toBeNull()
    expect(res.headers.get('set-cookie')).toContain(envVars.EVENTS_SESSION_COOKIE_NAME)
  })

  // Helper: inject an events session row directly so tests don't need a
  // full SSO exchange round-trip. Bearer prefix used, then bearer hashed
  // to produce the id_hash that is the DB key. The stored plaintext is
  // the userId itself so the re-verify stub (bearer → userId) resolves it.
  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(EVENTS_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { EVENTS_SESSION_KEY_V1: envVars.EVENTS_SESSION_KEY_V1 },
      keyVersion: envVars.EVENTS_SESSION_KEY_VERSION,
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
    return `${envVars.EVENTS_CSRF_COOKIE_NAME}=${CSRF}`
  }

  function sessionCookieHeaders(bearer: string): Record<string, string> {
    return {
      cookie: `${envVars.EVENTS_SESSION_COOKIE_NAME}=${bearer}; ${csrfCookiePair()}`,
      'x-rp-csrf': CSRF,
    }
  }

  // --- /session settings fold-in ---

  it('GET /session folds the shared settings doc in for the session user', async () => {
    const userId = 'user_01HEVENTSTEST0000000010'
    const bearer = await loginAs(userId)
    settingsGet.mockResolvedValueOnce({ themeMode: 'light', themeColor: 'pink' })
    verifyResult = { ok: true, userId }

    const res = await app.request('http://localhost/api/v1/ui/session', {
      method: 'GET',
      headers: sessionCookieHeaders(bearer),
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
    const userId = 'user_01HEVENTSTEST0000000011'
    const bearer = await loginAs(userId)
    settingsGet.mockRejectedValueOnce(new SettingsError(503, 'upstream', 'down'))
    verifyResult = { ok: true, userId }

    const res = await app.request('http://localhost/api/v1/ui/session', {
      method: 'GET',
      headers: sessionCookieHeaders(bearer),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user_id: string; settings: unknown }
    expect(body.settings).toEqual({})
  })

  // --- /session folds in the RPID profile (user bar) ---

  it('GET /session folds the RPID profile in for the session user', async () => {
    const userId = 'user_01HEVENTSTEST0000000030'
    const bearer = await loginAs(userId)
    profilesLookup.mockResolvedValueOnce({
      user_id: userId,
      email: 'prof@example.com',
      email_verified: true,
      display_name: 'Prof User',
      first_name: 'Prof',
      last_name: 'User',
      picture_url: 'https://id.example/api/v1/avatars/' + userId,
    } as UserBatchEntry)
    verifyResult = { ok: true, userId }

    const res = await app.request('http://localhost/api/v1/ui/session', {
      method: 'GET',
      headers: sessionCookieHeaders(bearer),
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
      username: 'Prof User',
      first_name: 'Prof',
      last_name: 'User',
      picture_url: 'https://id.example/api/v1/avatars/' + userId,
      email: 'prof@example.com',
    })
    expect(profilesLookup).toHaveBeenCalledWith(userId)
  })

  it('GET /session degrades profile to null when the batch lookup throws', async () => {
    const userId = 'user_01HEVENTSTEST0000000031'
    const bearer = await loginAs(userId)
    profilesLookup.mockRejectedValueOnce(new Error('rpid down'))
    verifyResult = { ok: true, userId }

    const res = await app.request('http://localhost/api/v1/ui/session', {
      method: 'GET',
      headers: sessionCookieHeaders(bearer),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user_id: string; profile: unknown }
    expect(body.profile).toBeNull()
  })

  // --- /settings passthrough ---

  it('GET /settings/shared returns the namespace doc for the session user', async () => {
    const userId = 'user_01HEVENTSTEST0000000012'
    const bearer = await loginAs(userId)
    settingsGet.mockResolvedValueOnce({ themeMode: 'dark' })
    verifyResult = { ok: true, userId }

    const res = await app.request('http://localhost/api/v1/ui/settings/shared', {
      method: 'GET',
      headers: sessionCookieHeaders(bearer),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ settings: { themeMode: 'dark' } })
    expect(settingsGet).toHaveBeenLastCalledWith(userId, 'shared')
  })

  it('GET /settings/events (own client namespace) is allowed', async () => {
    const userId = 'user_01HEVENTSTEST0000000013'
    const bearer = await loginAs(userId)
    verifyResult = { ok: true, userId }

    const res = await app.request('http://localhost/api/v1/ui/settings/events', {
      method: 'GET',
      headers: sessionCookieHeaders(bearer),
    })
    expect(res.status).toBe(200)
    expect(settingsGet).toHaveBeenLastCalledWith(userId, 'events')
  })

  it('GET /settings/lists (foreign namespace) is 403 without hitting RPID', async () => {
    const userId = 'user_01HEVENTSTEST0000000014'
    const bearer = await loginAs(userId)
    verifyResult = { ok: true, userId }
    settingsGet.mockClear()

    const res = await app.request('http://localhost/api/v1/ui/settings/lists', {
      method: 'GET',
      headers: sessionCookieHeaders(bearer),
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
    const userId = 'user_01HEVENTSTEST0000000015'
    const bearer = await loginAs(userId)
    settingsPatch.mockResolvedValueOnce({ themeMode: 'light', themeColor: 'red' })
    verifyResult = { ok: true, userId }

    const res = await app.request('http://localhost/api/v1/ui/settings/shared', {
      method: 'PATCH',
      headers: { ...sessionCookieHeaders(bearer), 'content-type': 'application/json' },
      body: JSON.stringify({ themeMode: 'light' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ settings: { themeMode: 'light', themeColor: 'red' } })
    expect(settingsPatch).toHaveBeenLastCalledWith(userId, 'shared', { themeMode: 'light' })
  })

  it('PATCH /settings/shared with a non-object body is 400', async () => {
    const userId = 'user_01HEVENTSTEST0000000016'
    const bearer = await loginAs(userId)
    verifyResult = { ok: true, userId }
    settingsPatch.mockClear()

    const res = await app.request('http://localhost/api/v1/ui/settings/shared', {
      method: 'PATCH',
      headers: { ...sessionCookieHeaders(bearer), 'content-type': 'application/json' },
      body: JSON.stringify(['not', 'an', 'object']),
    })
    expect(res.status).toBe(400)
    expect(settingsPatch).not.toHaveBeenCalled()
  })

  it('PATCH /settings/lists (foreign namespace) is 403', async () => {
    const userId = 'user_01HEVENTSTEST0000000017'
    const bearer = await loginAs(userId)
    verifyResult = { ok: true, userId }
    settingsPatch.mockClear()

    const res = await app.request('http://localhost/api/v1/ui/settings/lists', {
      method: 'PATCH',
      headers: { ...sessionCookieHeaders(bearer), 'content-type': 'application/json' },
      body: JSON.stringify({ x: 1 }),
    })
    expect(res.status).toBe(403)
    expect(settingsPatch).not.toHaveBeenCalled()
  })

  it('maps an RPID SettingsError onto the events error envelope', async () => {
    const userId = 'user_01HEVENTSTEST0000000018'
    const bearer = await loginAs(userId)
    settingsPatch.mockRejectedValueOnce(new SettingsError(400, 'settings_too_large', 'too big'))
    verifyResult = { ok: true, userId }

    const res = await app.request('http://localhost/api/v1/ui/settings/shared', {
      method: 'PATCH',
      headers: { ...sessionCookieHeaders(bearer), 'content-type': 'application/json' },
      body: JSON.stringify({ x: 1 }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('settings_too_large')
  })
})
