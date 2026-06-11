import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { env as testEnv } from 'cloudflare:test'
import type { Hono } from 'hono'
import { EventsClientError, type EventsClient } from '@rallypoint/events-client'
import type { ListsClient } from '@rallypoint/lists-client'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { PLANNER_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for the Planner group-event planner-pref write-back route:
//   PUT /api/v1/ui/events/:eventId/planner-pref
// Mirrors the posture of lists.d1.test.ts for the list planner-pref route.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

interface FakeEvents {
  client: EventsClient
  plannerPrefCalls: { actor: string; eventId: string; show: boolean }[]
}

function makeFakeEvents(): FakeEvents {
  const plannerPrefCalls: { actor: string; eventId: string; show: boolean }[] = []

  const client = {
    setGroupEventPlannerPref: async (opts: { actor: string; eventId: string; show: boolean }) => {
      plannerPrefCalls.push({ actor: opts.actor, eventId: opts.eventId, show: opts.show })
    },
    // Stub everything else to avoid unintended calls in this test file.
    listPersonalEvents: async () => [],
    listUserEvents: async () => [],
    listPlannerGroupEvents: async () => [],
  } as unknown as EventsClient

  return { client, plannerPrefCalls }
}

// Lists SDK is not exercised by the planner-pref write-back; a throwing stub
// keeps the Services contract satisfied.
const unusedLists = new Proxy(
  {},
  {
    get() {
      return async () => {
        throw new Error('lists client unused in events-planner tests')
      }
    },
  },
) as ListsClient

describe('D1 integration — Planner group-event planner-pref write-back', () => {
  let repos: Repos
  let env: Env
  let app: Hono<HonoApp>
  let fake: FakeEvents

  const baseServices = (eventsClient: EventsClient): Services => ({
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    },
    rpidSso: { exchange: vi.fn().mockResolvedValue({ ok: false, reason: 'invalid' }) },
    listsClient: unusedLists,
    eventsClient,
    settings: {
      get: async () => ({}),
      patch: async () => ({}),
    },
  })

  beforeAll(() => {
    repos = buildD1Repos(createDb(testEnv.DB))
    env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
  })

  beforeEach(() => {
    fake = makeFakeEvents()
    app = buildApp({ env, logger: undefined, repos, services: baseServices(fake.client) })
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
      ...extra,
    }
  }

  function put(bearer: string, eventId: string, body: unknown) {
    return app.request(
      `http://localhost/api/v1/ui/events/${encodeURIComponent(eventId)}/planner-pref`,
      {
        method: 'PUT',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify(body),
      },
    )
  }

  it('requires a session', async () => {
    const res = await app.request(
      'http://localhost/api/v1/ui/events/evt_abc/planner-pref',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-rp-csrf': CSRF,
          cookie: `${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}` },
        body: JSON.stringify({ show: false }),
      },
    )
    expect(res.status).toBe(401)
    expect(fake.plannerPrefCalls).toHaveLength(0)
  })

  it('400s when body is missing `show`', async () => {
    const bearer = await loginAs('user_a')
    const res = await put(bearer, 'evt_abc', {})
    expect(res.status).toBe(400)
    expect(fake.plannerPrefCalls).toHaveLength(0)
  })

  it('400s when `show` is not a boolean', async () => {
    const bearer = await loginAs('user_a')
    const res = await put(bearer, 'evt_abc', { show: 'yes' })
    expect(res.status).toBe(400)
  })

  it('204s and calls setGroupEventPlannerPref with show:false (un-toggle)', async () => {
    const bearer = await loginAs('user_b')
    const res = await put(bearer, 'evt_xyz', { show: false })
    expect(res.status).toBe(204)
    expect(fake.plannerPrefCalls).toHaveLength(1)
    expect(fake.plannerPrefCalls[0]).toEqual({ actor: 'user_b', eventId: 'evt_xyz', show: false })
  })

  it('204s and calls setGroupEventPlannerPref with show:true (re-toggle)', async () => {
    const bearer = await loginAs('user_c')
    const res = await put(bearer, 'evt_abc', { show: true })
    expect(res.status).toBe(204)
    expect(fake.plannerPrefCalls[0]).toEqual({ actor: 'user_c', eventId: 'evt_abc', show: true })
  })

  it('proxies a 403 from events-api (access denied)', async () => {
    const bearer = await loginAs('user_d')
    vi.spyOn(fake.client, 'setGroupEventPlannerPref').mockRejectedValueOnce(
      new EventsClientError(403, 'forbidden', 'Access denied.'),
    )
    const res = await put(bearer, 'evt_private', { show: true })
    expect(res.status).toBe(403)
  })

  it('forwards the session actor (not a user-supplied actor) to the SDK', async () => {
    const bearer = await loginAs('user_e')
    await put(bearer, 'evt_test', { show: false })
    expect(fake.plannerPrefCalls[0]?.actor).toBe('user_e')
  })
})
