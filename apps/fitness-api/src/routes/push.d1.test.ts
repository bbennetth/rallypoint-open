import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb, type Db } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { RestAlarmService, Services } from '../services/types.js'
import { encryptBearer } from '../crypto/encryption.js'
import { FITNESS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Rest-timer push routes over real D1: subscription registry CRUD and the
// PUT/DELETE rest-timer scheduling surface (queue rows + DO-alarm calls).
// The DO namespace is stubbed via services.restAlarms; Web Push delivery
// itself is covered in repos/d1/push.d1.test.ts.

const CSRF = 'csrf_token_value_push_routes_aaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — push routes', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>
  let _db: Db
  const alarmCalls: string[] = []
  const restAlarms: RestAlarmService = {
    async schedule(userId, dedupeKey, notificationId, fireAtMs) {
      alarmCalls.push(`schedule:${userId}:${dedupeKey}:${notificationId}:${fireAtMs}`)
    },
    async cancel(userId, dedupeKey) {
      alarmCalls.push(`cancel:${userId}:${dedupeKey}`)
    },
  }

  beforeAll(() => {
    _db = createDb(env.DB)
    repos = buildD1Repos(_db)
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    const services: Services = {
      idClient: {
        verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
        signoutRpidBearer: async () => {},
      },
      rpidSso: { exchange: async () => ({ ok: false as const, reason: 'invalid' as const }) },
      profiles: { lookup: async () => null },
      settings: { get: async () => ({}), patch: async (_u, _n, p) => p },
      offClient: { lookup: async () => null },
      webPush: { async send() { return { ok: true, statusCode: 201, expired: false } } },
      restAlarms,
    }
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })

  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(FITNESS_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { FITNESS_SESSION_KEY_V1: envVars.FITNESS_SESSION_KEY_V1 },
      keyVersion: envVars.FITNESS_SESSION_KEY_VERSION,
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

  async function req(
    bearer: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: {
        cookie: `${envVars.FITNESS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}`,
        'x-rp-csrf': CSRF,
        'content-type': 'application/json',
        origin: envVars.FITNESS_UI_ORIGIN,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  const SUBSCRIPTION = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    keys: { p256dh: 'p256dh_key', auth: 'auth_key' },
  }

  it('serves the VAPID public key without a session, CSRF, or origin header', async () => {
    const res = await app.request('http://localhost/api/v1/push/public-key')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ publicKey: envVars.VAPID_PUBLIC_KEY })
  })

  it('registers and removes a push subscription', async () => {
    const bearer = await loginAs('user_push_1')
    const res = await req(bearer, 'POST', '/api/v1/ui/push/subscription', SUBSCRIPTION)
    expect(res.status).toBe(204)
    expect(await repos.pushSubscriptions.listByUser('user_push_1')).toHaveLength(1)

    const del = await req(bearer, 'DELETE', '/api/v1/ui/push/subscription', {
      endpoint: SUBSCRIPTION.endpoint,
    })
    expect(del.status).toBe(204)
    expect(await repos.pushSubscriptions.listByUser('user_push_1')).toHaveLength(0)
  })

  it('rejects non-allowlisted push endpoints (SSRF guard)', async () => {
    const bearer = await loginAs('user_push_ssrf')
    const res = await req(bearer, 'POST', '/api/v1/ui/push/subscription', {
      endpoint: 'https://internal.metadata.example/latest',
      keys: { p256dh: 'k', auth: 'a' },
    })
    expect(res.status).toBe(400)
  })

  it('schedules, reschedules, and cancels a rest-timer notification', async () => {
    const bearer = await loginAs('user_push_rest')
    alarmCalls.length = 0
    const fireAtMs = Date.now() + 90_000
    const res = await req(bearer, 'PUT', '/api/v1/ui/push/rest-timer', {
      tag: 'ses_abc',
      fireAtMs,
      nextUp: 'Back Squat',
    })
    expect(res.status).toBe(200)
    const { id } = (await res.json()) as { id: string }
    const row = await repos.scheduledNotifications.getById(id)
    expect(row?.dedupeKey).toBe('rest:ses_abc')
    expect(row?.body).toBe('Next up: Back Squat')
    expect(alarmCalls[0]).toBe(`schedule:user_push_rest:rest:ses_abc:${id}:${fireAtMs}`)

    // Reschedule (adjusted timer) reuses the same row.
    const res2 = await req(bearer, 'PUT', '/api/v1/ui/push/rest-timer', {
      tag: 'ses_abc',
      fireAtMs: fireAtMs + 30_000,
    })
    expect(((await res2.json()) as { id: string }).id).toBe(id)

    const del = await req(bearer, 'DELETE', '/api/v1/ui/push/rest-timer/ses_abc')
    expect(del.status).toBe(204)
    expect((await repos.scheduledNotifications.getById(id))?.cancelledAt).not.toBeNull()
    expect(alarmCalls.at(-1)).toBe('cancel:user_push_rest:rest:ses_abc')
  })

  it('rejects a rest deadline too far in the future', async () => {
    const bearer = await loginAs('user_push_far')
    const res = await req(bearer, 'PUT', '/api/v1/ui/push/rest-timer', {
      tag: 'ses_far',
      fireAtMs: Date.now() + 2 * 60 * 60 * 1000,
    })
    expect(res.status).toBe(400)
  })
})
