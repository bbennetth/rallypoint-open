import { describe, it, expect, beforeAll, vi } from 'vitest'
import { env as testEnv } from 'cloudflare:test'
import type { Hono } from 'hono'
import type { EventsClient } from '@rallypoint/events-client'
import type { ListsClient } from '@rallypoint/lists-client'
import type { SendPushResult, WebPushSubscription } from '@rallypoint/web-push'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services, WebPushService } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { PLANNER_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for POST /api/v1/ui/push/test (#675 bug sweep).
//
// The route used to return the raw deliverToUser() result — a
// {subscriptions, sent, reaped} object that leaks the count of the user's
// registered devices to the client. This proves the response is now a
// minimal summary ({ok, registered, delivered} — booleans only) regardless
// of how many devices are registered or how the send fares.

const CSRF = 'csrf_token_push_test_aaaaaaaaaaaaaaaaaaaaaaaaa'

function makeFakeWebPush(result: SendPushResult): WebPushService {
  return {
    send: vi.fn(async (_sub: WebPushSubscription, _payload: string) => result),
  }
}

function makeFakeLists(): ListsClient {
  return {
    health: async () => ({ status: 'stub' }),
    listLists: async () => [],
    listItems: async () => [],
    listFieldDefs: async () => [],
    listStatuses: async () => [],
    listLabels: async () => [],
    listGroups: async () => [],
    createGroup: async () => { throw new Error('not stubbed') },
    createList: async () => { throw new Error('not stubbed') },
    deleteList: async () => {},
    createListItem: async () => { throw new Error('not stubbed') },
    updateListItem: async () => { throw new Error('not stubbed') },
    moveListItem: async () => { throw new Error('not stubbed') },
    deleteListItem: async () => {},
    createListItemSeries: async () => { throw new Error('not stubbed') },
    listSeries: async () => [],
    updateSeries: async () => { throw new Error('not stubbed') },
    deleteSeries: async () => {},
    createFieldDef: async () => { throw new Error('not stubbed') },
    updateFieldDef: async () => { throw new Error('not stubbed') },
    deleteFieldDef: async () => {},
    listComments: async () => [],
    createComment: async () => { throw new Error('not stubbed') },
  } as unknown as ListsClient
}

function makeFakeEvents(): EventsClient {
  return {
    getEvent: async () => { throw new Error('not stubbed') },
    getLineup: async () => { throw new Error('not stubbed') },
    getSessions: async () => { throw new Error('not stubbed') },
    createPersonalEvent: async () => { throw new Error('not stubbed') },
    listPersonalEvents: async () => [],
    getPersonalEvent: async () => { throw new Error('not stubbed') },
    patchPersonalEvent: async () => { throw new Error('not stubbed') },
    deletePersonalEvent: async () => {},
    listUserEvents: async () => [],
    setGroupEventPlannerPref: async () => {},
    listPlannerGroupEvents: async () => [],
    uploadTicket: async () => { throw new Error('not stubbed') },
    listTickets: async () => [],
    downloadTicket: async () => { throw new Error('not stubbed') },
    listHolidays: async () => [],
  } as unknown as EventsClient
}

describe('D1 integration — Planner push /push/test route', () => {
  let repos: Repos
  let env: Env
  let app: Hono<HonoApp>

  function baseServices(webPush: WebPushService): Services {
    return {
      idClient: {
        verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
        signoutRpidBearer: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      },
      rpidSso: { exchange: vi.fn().mockResolvedValue({ ok: false, reason: 'invalid' }) },
      profiles: { lookup: async () => null },
      listsClient: makeFakeLists(),
      eventsClient: makeFakeEvents(),
      fitnessClient: {} as Services['fitnessClient'],
      settings: { get: async () => ({}), patch: async () => ({}) },
      webPush,
    } as unknown as Services
  }

  beforeAll(() => {
    repos = buildD1Repos(createDb(testEnv.DB))
    env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
  })

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

  function headers(bearer: string, extra?: Record<string, string>): Record<string, string> {
    return {
      cookie: `${env.PLANNER_SESSION_COOKIE_NAME}=${bearer}; ${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      origin: env.PLANNER_UI_ORIGIN,
      ...extra,
    }
  }

  it('serves the VAPID public key without a session, CSRF, or origin header', async () => {
    app = buildApp({ env, logger: undefined, repos, services: baseServices(makeFakeWebPush({ ok: true, statusCode: 201, expired: false })) })
    const res = await app.request('http://localhost/api/v1/push/public-key')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ publicKey: env.VAPID_PUBLIC_KEY })
  })

  it('requires a session', async () => {
    app = buildApp({ env, logger: undefined, repos, services: baseServices(makeFakeWebPush({ ok: true, statusCode: 201, expired: false })) })
    const res = await app.request('http://localhost/api/v1/ui/push/test', {
      method: 'POST',
      headers: {
        cookie: `${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`,
        'x-rp-csrf': CSRF,
        origin: env.PLANNER_UI_ORIGIN,
      },
    })
    expect(res.status).toBe(401)
  })

  it('returns a minimal {ok, registered:false, delivered:false} summary when the user has no subscriptions — never the raw device count', async () => {
    app = buildApp({ env, logger: undefined, repos, services: baseServices(makeFakeWebPush({ ok: true, statusCode: 201, expired: false })) })
    const bearer = await loginAs('user_push_1')
    const res = await app.request('http://localhost/api/v1/ui/push/test', {
      method: 'POST',
      headers: headers(bearer),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, registered: false, delivered: false })
  })

  it('returns delivered:true when at least one subscription accepts the push, without leaking subscription/reaped counts', async () => {
    const userId = 'user_push_2'
    await repos.pushSubscriptions.upsert({
      idHash: hashToken('endpoint-a'),
      userId,
      endpoint: 'https://fcm.googleapis.com/fcm/send/a',
      p256dh: 'p',
      auth: 'a',
    })
    app = buildApp({ env, logger: undefined, repos, services: baseServices(makeFakeWebPush({ ok: true, statusCode: 201, expired: false })) })
    const bearer = await loginAs(userId)
    const res = await app.request('http://localhost/api/v1/ui/push/test', {
      method: 'POST',
      headers: headers(bearer),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, registered: true, delivered: true })
    expect(body).not.toHaveProperty('subscriptions')
    expect(body).not.toHaveProperty('sent')
    expect(body).not.toHaveProperty('reaped')
  })

  it('returns delivered:false when every send fails (non-expired) even though a subscription is registered', async () => {
    const userId = 'user_push_3'
    await repos.pushSubscriptions.upsert({
      idHash: hashToken('endpoint-b'),
      userId,
      endpoint: 'https://fcm.googleapis.com/fcm/send/b',
      p256dh: 'p',
      auth: 'a',
    })
    app = buildApp({
      env,
      logger: undefined,
      repos,
      services: baseServices(makeFakeWebPush({ ok: false, statusCode: 500, expired: false })),
    })
    const bearer = await loginAs(userId)
    const res = await app.request('http://localhost/api/v1/ui/push/test', {
      method: 'POST',
      headers: headers(bearer),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, registered: true, delivered: false })
  })
})
