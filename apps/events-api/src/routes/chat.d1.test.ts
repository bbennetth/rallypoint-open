import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import type { RealtimeBus, RealtimeEnvelope, Subscription } from '@rallypoint/realtime'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { makeNoopMoneyClient, makeNoopListsClient, makeStubObjectStore } from './_test-services.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 integration tests for the group chat surface (slice 10).
// Replaces chat.it.test.ts. Runs inside a workerd isolate (Miniflare D1),
// migrations applied by apps/events-api/test/apply-d1-migrations.ts.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

interface RecordingBus extends RealtimeBus {
  published: { channel: string; env: RealtimeEnvelope }[]
}

function makeRecordingBus(): RecordingBus {
  const published: { channel: string; env: RealtimeEnvelope }[] = []
  return {
    published,
    async publish(channel, e) {
      published.push({ channel, env: e })
    },
    subscribe(): Subscription {
      return { unsubscribe() {} }
    },
    async close() {},
  }
}

describe('D1 integration — group chat', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>
  const bus = makeRecordingBus()

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
      patch: async (_u, _n, patch) => patch,
    },
  }

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services, realtime: bus })
  })

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

  function headers(bearer: string): Record<string, string> {
    return {
      cookie: `${envVars.EVENTS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.EVENTS_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      'content-type': 'application/json',
    }
  }

  async function req(
    bearer: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: headers(bearer),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  async function createEvent(bearer: string, name: string): Promise<string> {
    const res = await req(bearer, 'POST', '/api/v1/ui/events', { name, timezone: 'UTC' })
    return ((await res.json()) as { id: string }).id
  }

  async function createGroup(
    ownerBearer: string,
    eventId: string,
    name: string,
  ): Promise<{ id: string; joinCode: string }> {
    const res = await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name })
    const body = (await res.json()) as { id: string; join_code: string }
    return { id: body.id, joinCode: body.join_code }
  }

  it('rejects an unauthenticated chat request', async () => {
    const res = await app.request('http://localhost/api/v1/ui/groups/group_x/chat', {
      method: 'GET',
      headers: { 'x-rp-csrf': CSRF, cookie: `${envVars.EVENTS_CSRF_COOKIE_NAME}=${CSRF}` },
    })
    expect(res.status).toBe(401)
  })

  it('posts a message, lists it, and publishes a pointer envelope', async () => {
    const owner = `user_${Date.now()}_chat`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Chat Event')
    const group = await createGroup(bearer, eventId, 'Owls')

    const before = bus.published.length
    const send = await req(bearer, 'POST', `/api/v1/ui/groups/${group.id}/chat`, { body: 'Hello group' })
    expect(send.status).toBe(201)
    const msg = (await send.json()) as Record<string, unknown>
    expect(msg.body).toBe('Hello group')
    expect(msg.group_id).toBe(group.id)
    expect(msg.user_id).toBe(owner)
    expect(typeof msg.id).toBe('string')
    expect((msg.id as string).startsWith('msg_')).toBe(true)

    // Publish: one new envelope on the group channel, authored by the sender.
    expect(bus.published.length).toBe(before + 1)
    const last = bus.published[bus.published.length - 1]!
    expect(last.channel).toBe(`events:group:${group.id}`)
    expect(last.env.resource).toBe('chat_messages')
    expect(last.env.operation).toBe('create')
    expect(last.env.payload.id).toBe(msg.id)
    expect(last.env.authorId).toBe(owner)

    const list = await req(bearer, 'GET', `/api/v1/ui/groups/${group.id}/chat`)
    expect(list.status).toBe(200)
    const page = (await list.json()) as { items: Array<{ id: string }>; next_before: string | null }
    expect(page.items.map((i) => i.id)).toContain(msg.id)
    expect(page.next_before).toBeNull()
  })

  it('paginates newest-first via the before cursor', async () => {
    const owner = `user_${Date.now()}_page`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Page Event')
    const group = await createGroup(bearer, eventId, 'Crows')

    const bodies = ['m1', 'm2', 'm3', 'm4', 'm5']
    for (const body of bodies) {
      const r = await req(bearer, 'POST', `/api/v1/ui/groups/${group.id}/chat`, { body })
      expect(r.status).toBe(201)
    }

    const first = await req(bearer, 'GET', `/api/v1/ui/groups/${group.id}/chat?limit=2`)
    const p1 = (await first.json()) as { items: { body: string }[]; next_before: string | null }
    expect(p1.items.map((i) => i.body)).toEqual(['m5', 'm4'])
    expect(p1.next_before).not.toBeNull()

    const second = await req(
      bearer,
      'GET',
      `/api/v1/ui/groups/${group.id}/chat?limit=2&before=${p1.next_before}`,
    )
    const p2 = (await second.json()) as { items: { body: string }[]; next_before: string | null }
    expect(p2.items.map((i) => i.body)).toEqual(['m3', 'm2'])
    expect(p2.next_before).not.toBeNull()

    const third = await req(
      bearer,
      'GET',
      `/api/v1/ui/groups/${group.id}/chat?limit=2&before=${p2.next_before}`,
    )
    const p3 = (await third.json()) as { items: { body: string }[]; next_before: string | null }
    expect(p3.items.map((i) => i.body)).toEqual(['m1'])
    expect(p3.next_before).toBeNull()
  })

  it('returns next_before=null when the page is exactly limit with nothing older', async () => {
    const owner = `user_${Date.now()}_exact`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Exact Event')
    const group = await createGroup(bearer, eventId, 'Larks')

    for (const body of ['a', 'b', 'c']) {
      expect((await req(bearer, 'POST', `/api/v1/ui/groups/${group.id}/chat`, { body })).status).toBe(201)
    }

    // Exactly three rows exist; ask for three.
    const res = await req(bearer, 'GET', `/api/v1/ui/groups/${group.id}/chat?limit=3`)
    const page = (await res.json()) as { items: { body: string }[]; next_before: string | null }
    expect(page.items.map((i) => i.body)).toEqual(['c', 'b', 'a'])
    expect(page.next_before).toBeNull()
  })

  it('ignores a before cursor from another group (no cross-group bleed)', async () => {
    const owner = `user_${Date.now()}_xgrp`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'XGroup Event')
    const groupA = await createGroup(bearer, eventId, 'AlphaGroup')
    const groupB = await createGroup(bearer, eventId, 'BetaGroup')

    await req(bearer, 'POST', `/api/v1/ui/groups/${groupA.id}/chat`, { body: 'a-only' })
    const bMsg = await req(bearer, 'POST', `/api/v1/ui/groups/${groupB.id}/chat`, { body: 'b-only' })
    const bId = ((await bMsg.json()) as { id: string }).id

    // groupB's message id must not bound groupA's page.
    const res = await req(bearer, 'GET', `/api/v1/ui/groups/${groupA.id}/chat?before=${bId}`)
    const page = (await res.json()) as { items: { body: string }[]; next_before: string | null }
    expect(page.items.map((i) => i.body)).toEqual(['a-only'])
  })

  it('rejects an empty message body (400)', async () => {
    const owner = `user_${Date.now()}_empty`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Empty Event')
    const group = await createGroup(bearer, eventId, 'Doves')

    const res = await req(bearer, 'POST', `/api/v1/ui/groups/${group.id}/chat`, { body: '   ' })
    expect(res.status).toBe(400)
  })

  it('404s chat for a missing group', async () => {
    const bearer = await loginAs(`user_${Date.now()}_missing`)
    const res = await req(bearer, 'GET', '/api/v1/ui/groups/group_missing/chat')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('group_not_found')
  })

  it('404s chat for a non-member (no existence leak)', async () => {
    const owner = `user_${Date.now()}_nm_owner`
    const ownerBearer = await loginAs(owner)
    const eventId = await createEvent(ownerBearer, 'NM Event')
    const group = await createGroup(ownerBearer, eventId, 'Hawks')

    const stranger = await loginAs(`user_${Date.now()}_stranger`)
    expect((await req(stranger, 'GET', `/api/v1/ui/groups/${group.id}/chat`)).status).toBe(404)
    expect(
      (await req(stranger, 'POST', `/api/v1/ui/groups/${group.id}/chat`, { body: 'hi' })).status,
    ).toBe(404)
  })

  it('lets a plain member read and post (member-level write)', async () => {
    const owner = `user_${Date.now()}_mem_owner`
    const ownerBearer = await loginAs(owner)
    const member = `${owner}_member`
    const memberBearer = await loginAs(member)
    const eventId = await createEvent(ownerBearer, 'Member Event')
    const group = await createGroup(ownerBearer, eventId, 'Jays')
    await req(memberBearer, 'POST', '/api/v1/ui/groups/join', { code: group.joinCode })

    expect((await req(memberBearer, 'GET', `/api/v1/ui/groups/${group.id}/chat`)).status).toBe(200)
    const send = await req(memberBearer, 'POST', `/api/v1/ui/groups/${group.id}/chat`, {
      body: 'member here',
    })
    expect(send.status).toBe(201)
    expect(((await send.json()) as { user_id: string }).user_id).toBe(member)
  })
})
