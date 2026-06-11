import { describe, it, expect, beforeEach } from 'vitest'
import type { Hono } from 'hono'
import { verifyChannelToken, type RealtimeHubNamespace } from '@rallypoint/realtime'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { buildApp } from '../build-app.js'
import { buildMemoryRepos } from '../repos/memory.js'
import { parseEnv, type Env } from '../env.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'
import { makeNoopListsClient, makeNoopMoneyClient, makeStubObjectStore } from './_test-services.js'

// Realtime route tests (Phase 4) — memory-repo backed so they run in the
// node pool without Docker. Covers the channel-token mint endpoints (which
// reuse the read-auth gates) and the WebSocket-upgrade forward to the
// channel DO. The DO mechanism itself is covered by
// packages/realtime/src/hub.workers.test.ts (Miniflare).

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

const services: Services = {
  idClient: {
    verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
    signoutRpidBearer: async () => {},
    batchLookupUsers: async () => [],
  },
  rpidSso: { exchange: async () => ({ ok: false as const, reason: 'invalid' as const }) },
  rpidReauth: { verify: async () => ({ ok: true as const }) },
  objectStore: makeStubObjectStore(),
  listsClient: makeNoopListsClient(),
  moneyClient: makeNoopMoneyClient(),
  weather: {
    getEventWeather: async () => ({ forecast: null, airQuality: null, issuedAt: new Date().toISOString() }),
  },
  settings: {
    get: async () => ({}),
    patch: async (_u: string, _n: string, p: Record<string, unknown>) => p,
  },
}

// Records what the WS-upgrade route forwarded to the hub: the channel
// idFromName was called with, and the forwarded request URL.
interface Forwarded {
  channel: string
  url: string
}

function fakeHub(sink: { last: Forwarded | null }): RealtimeHubNamespace {
  return {
    idFromName(name: string) {
      return { name }
    },
    get(id: unknown) {
      const channel = (id as { name: string }).name
      return {
        async fetch(input: string | URL | Request): Promise<Response> {
          const url = input instanceof Request ? input.url : String(input)
          sink.last = { channel, url }
          return new Response(null, { status: 200, headers: { 'x-forwarded-channel': channel } })
        },
      }
    },
  }
}

describe('realtime routes (memory)', () => {
  let repos: Repos
  let env: Env
  let app: Hono<HonoApp>
  let appNoHub: Hono<HonoApp>
  let hubSink: { last: Forwarded | null }

  beforeEach(() => {
    repos = buildMemoryRepos()
    env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    hubSink = { last: null }
    app = buildApp({ env, logger: undefined, repos, services, hub: fakeHub(hubSink) })
    appNoHub = buildApp({ env, logger: undefined, repos, services })
  })

  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(EVENTS_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { EVENTS_SESSION_KEY_V1: env.EVENTS_SESSION_KEY_V1 },
      keyVersion: env.EVENTS_SESSION_KEY_VERSION,
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

  function headers(bearer: string): Record<string, string> {
    return {
      cookie: `${env.EVENTS_SESSION_COOKIE_NAME}=${bearer}; ${env.EVENTS_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      'content-type': 'application/json',
    }
  }

  async function req(
    bearer: string,
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: { ...headers(bearer), ...extra },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  async function makeEvent(bearer: string): Promise<string> {
    const res = await req(bearer, 'POST', '/api/v1/ui/events', {
      name: `RT Event ${Date.now()}_${Math.random().toString(36).slice(2)}`,
      timezone: 'UTC',
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }

  async function makeGroup(bearer: string, eventId: string): Promise<string> {
    const res = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, {
      name: `RT Group ${Date.now()}_${Math.random().toString(36).slice(2)}`,
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }

  // ── event channel token ──────────────────────────────────────────────

  it('mints a token for a viewable event, bound to the event channel', async () => {
    const userId = `user_${Date.now()}_a`
    const bearer = await loginAs(userId)
    const eventId = await makeEvent(bearer)

    const res = await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/realtime-token`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; expiresAt: number; channel: string }
    expect(body.channel).toBe(`events:event:${eventId}`)
    expect(body.expiresAt).toBeGreaterThan(Date.now())

    const verdict = verifyChannelToken({ token: body.token, key: env.REALTIME_TOKEN_HMAC_KEY })
    expect(verdict).toMatchObject({ ok: true, channel: `events:event:${eventId}` })
  })

  it('401s an event token request with no session', async () => {
    const res = await app.request('http://localhost/api/v1/ui/events/event_x/realtime-token')
    expect(res.status).toBe(401)
  })

  it('404s an event token request for a non-member (no existence leak)', async () => {
    const owner = await loginAs(`user_${Date.now()}_owner`)
    const eventId = await makeEvent(owner)
    const outsider = await loginAs(`user_${Date.now()}_outsider`)

    const res = await req(outsider, 'GET', `/api/v1/ui/events/${eventId}/realtime-token`)
    expect(res.status).toBe(404)
  })

  // ── group channel token ──────────────────────────────────────────────

  it('mints a token for a group member, bound to the group channel', async () => {
    const userId = `user_${Date.now()}_b`
    const bearer = await loginAs(userId)
    const eventId = await makeEvent(bearer)
    const groupId = await makeGroup(bearer, eventId)

    const res = await req(bearer, 'GET', `/api/v1/ui/groups/${groupId}/realtime-token`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; expiresAt: number; channel: string }
    expect(body.channel).toBe(`events:group:${groupId}`)
    expect(body.expiresAt).toBeGreaterThan(Date.now())

    const verdict = verifyChannelToken({ token: body.token, key: env.REALTIME_TOKEN_HMAC_KEY })
    expect(verdict).toMatchObject({ ok: true, channel: `events:group:${groupId}` })
  })

  it('401s a group token request with no session', async () => {
    const res = await app.request('http://localhost/api/v1/ui/groups/grp_x/realtime-token')
    expect(res.status).toBe(401)
  })

  it('404s a group token request for a non-member (no existence leak)', async () => {
    const owner = await loginAs(`user_${Date.now()}_owner`)
    const eventId = await makeEvent(owner)
    const groupId = await makeGroup(owner, eventId)
    const outsider = await loginAs(`user_${Date.now()}_outsider`)

    const res = await req(outsider, 'GET', `/api/v1/ui/groups/${groupId}/realtime-token`)
    expect(res.status).toBe(404)
  })

  // ── WS upgrade forward ───────────────────────────────────────────────

  it('forwards a valid WS upgrade to the channel DO resolved from the event token', async () => {
    const userId = `user_${Date.now()}_c`
    const bearer = await loginAs(userId)
    const eventId = await makeEvent(bearer)
    const channel = `events:event:${eventId}`
    const token = (
      (await (
        await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/realtime-token`)
      ).json()) as { token: string }
    ).token

    const res = await app.request(
      `http://localhost/api/v1/ui/realtime?token=${encodeURIComponent(token)}`,
      { headers: { Upgrade: 'websocket' } },
    )

    expect(res.headers.get('x-forwarded-channel')).toBe(channel)
    expect(hubSink.last?.channel).toBe(channel)
  })

  it('forwards a valid WS upgrade to the channel DO resolved from the group token', async () => {
    const userId = `user_${Date.now()}_d`
    const bearer = await loginAs(userId)
    const eventId = await makeEvent(bearer)
    const groupId = await makeGroup(bearer, eventId)
    const channel = `events:group:${groupId}`
    const token = (
      (await (
        await req(bearer, 'GET', `/api/v1/ui/groups/${groupId}/realtime-token`)
      ).json()) as { token: string }
    ).token

    const res = await app.request(
      `http://localhost/api/v1/ui/realtime?token=${encodeURIComponent(token)}`,
      { headers: { Upgrade: 'websocket' } },
    )

    expect(res.headers.get('x-forwarded-channel')).toBe(channel)
    expect(hubSink.last?.channel).toBe(channel)
  })

  it('rejects a WS upgrade with a missing/invalid token (401) and never forwards', async () => {
    const res = await app.request('http://localhost/api/v1/ui/realtime?token=garbage', {
      headers: { Upgrade: 'websocket' },
    })
    expect(res.status).toBe(401)
    expect(hubSink.last).toBeNull()
  })

  it('rejects a non-websocket request to the upgrade route (426)', async () => {
    const res = await app.request('http://localhost/api/v1/ui/realtime?token=garbage')
    expect(res.status).toBe(426)
  })

  it('503s the upgrade route when no DO binding is present', async () => {
    const res = await appNoHub.request('http://localhost/api/v1/ui/realtime', {
      headers: { Upgrade: 'websocket' },
    })
    expect(res.status).toBe(503)
  })
})
