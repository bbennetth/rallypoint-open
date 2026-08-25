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

// Integration tests for crew map pins (group member locations). The pin
// is self-placed (not GPS): PUT upserts the caller's row, DELETE removes
// it, GET lists the group's pins with display names.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

interface RecordingBus extends RealtimeBus {
  published: { channel: string; env: RealtimeEnvelope }[]
}
function makeRecordingBus(): RecordingBus {
  const published: { channel: string; env: RealtimeEnvelope }[] = []
  return {
    published,
    async publish(channel, env) {
      published.push({ channel, env })
    },
    subscribe(): Subscription {
      return { unsubscribe() {} }
    },
    async close() {},
  }
}

describe('D1 integration — crew map pins (member locations)', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>
  const bus = makeRecordingBus()

  const services: Services = {
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: async () => {},
      // Deterministic display names: "Name <last 4 of user id>".
      batchLookupUsers: async (userIds: string[]) =>
        userIds.map((userId) => ({ userId, displayName: `Name ${userId.slice(-4)}` })),
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
      origin: envVars.EVENTS_UI_ORIGIN,
    }
  }

  async function req(bearer: string, method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: headers(bearer),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  async function fixture() {
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const owner = `user_${stamp}_own`
    const member = `user_${stamp}_mem`
    const ownerBearer = await loginAs(owner)
    const memberBearer = await loginAs(member)
    const eventRes = await req(ownerBearer, 'POST', '/api/v1/ui/events', {
      name: `Pin Fest ${stamp}`,
      timezone: 'UTC',
    })
    const eventId = ((await eventRes.json()) as { id: string }).id
    const groupRes = await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, {
      name: 'Crew',
    })
    const group = (await groupRes.json()) as { id: string; join_code: string }
    const join = await req(memberBearer, 'POST', '/api/v1/ui/groups/join', {
      code: group.join_code,
    })
    expect(join.status).toBe(200)
    return { owner, member, ownerBearer, memberBearer, groupId: group.id }
  }

  it('places, moves, lists (with names), and removes a pin', async () => {
    const { owner, member, ownerBearer, memberBearer, groupId } = await fixture()
    bus.published.length = 0

    // Member places a pin.
    const put = await req(memberBearer, 'PUT', `/api/v1/ui/groups/${groupId}/locations/me`, {
      layer: 'site',
      xPct: 42.5,
      yPct: 61,
    })
    expect(put.status).toBe(200)
    expect((await put.json()) as object).toMatchObject({
      user_id: member,
      layer: 'site',
      x_pct: 42.5,
      y_pct: 61,
    })

    // Moving upserts the same row (no duplicate).
    await req(memberBearer, 'PUT', `/api/v1/ui/groups/${groupId}/locations/me`, {
      layer: 'camp',
      xPct: 10,
      yPct: 20,
    })
    // Owner places one too, then lists: both pins with display names.
    await req(ownerBearer, 'PUT', `/api/v1/ui/groups/${groupId}/locations/me`, {
      layer: 'site',
      xPct: 5,
      yPct: 5,
    })
    const list = await req(ownerBearer, 'GET', `/api/v1/ui/groups/${groupId}/locations`)
    expect(list.status).toBe(200)
    const items = ((await list.json()) as { items: Record<string, unknown>[] }).items
    expect(items).toHaveLength(2)
    const memberRow = items.find((i) => i.user_id === member)!
    expect(memberRow).toMatchObject({
      layer: 'camp',
      x_pct: 10,
      y_pct: 20,
      display_name: `Name ${member.slice(-4)}`,
    })

    // Member removes their pin.
    const del = await req(memberBearer, 'DELETE', `/api/v1/ui/groups/${groupId}/locations/me`)
    expect(del.status).toBe(204)
    const after = await req(ownerBearer, 'GET', `/api/v1/ui/groups/${groupId}/locations`)
    const afterItems = ((await after.json()) as { items: { user_id: string }[] }).items
    expect(afterItems.map((i) => i.user_id)).toEqual([owner])

    // Envelopes: member put ×2, owner put, member delete.
    const locEnvs = bus.published.filter((p) => p.env.resource === 'member_locations')
    expect(locEnvs.map((p) => p.env.operation)).toEqual(['update', 'update', 'update', 'delete'])
    for (const p of locEnvs) expect(p.channel).toContain(groupId)
  })

  it('400s an invalid pin body', async () => {
    const { memberBearer, groupId } = await fixture()
    for (const body of [
      { layer: 'site', xPct: 10 }, // missing yPct
      { layer: 'parking', xPct: 10, yPct: 20 }, // bogus layer
      { layer: 'site', xPct: 101, yPct: 20 }, // out of range
    ]) {
      const res = await req(memberBearer, 'PUT', `/api/v1/ui/groups/${groupId}/locations/me`, body)
      expect(res.status).toBe(400)
    }
  })

  it('404s all routes for a non-member (no existence leak)', async () => {
    const { groupId } = await fixture()
    const outsider = await loginAs(`user_${Date.now()}_out`)
    expect((await req(outsider, 'GET', `/api/v1/ui/groups/${groupId}/locations`)).status).toBe(404)
    expect(
      (
        await req(outsider, 'PUT', `/api/v1/ui/groups/${groupId}/locations/me`, {
          layer: 'site',
          xPct: 1,
          yPct: 1,
        })
      ).status,
    ).toBe(404)
    expect(
      (await req(outsider, 'DELETE', `/api/v1/ui/groups/${groupId}/locations/me`)).status,
    ).toBe(404)
  })
})
