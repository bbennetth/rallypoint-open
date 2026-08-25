import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { createBindingObjectStore } from '@rallypoint/object-store'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for the group-scoped map mirror reads (attendee Map
// tab) + the widened event realtime-token gate. The central scenario: a
// user who joined a group BY CODE has group_members + event_attendees
// rows but NO event_members row, so the viewer-gated event GETs 404 for
// them — the group-scoped reads and the widened token mint must work.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — group-scoped map reads + widened realtime token', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    const services = {
      idClient: {
        verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
        signoutRpidBearer: async () => {},
        batchLookupUsers: async () => [],
      },
      rpidSso: { exchange: async () => ({ ok: false as const, reason: 'invalid' as const }) },
      rpidReauth: { verify: async () => ({ ok: true as const }) },
      objectStore: createBindingObjectStore(env.OBJECT_STORE),
      weather: {
        getEventWeather: async () => ({ forecast: null, airQuality: null, issuedAt: new Date().toISOString() }),
      },
      settings: {
        get: async () => ({}),
        patch: async (_u: unknown, _n: unknown, patch: unknown) => patch,
      },
    } as unknown as Services
    app = buildApp({ env: envVars, logger: undefined, repos, services })
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
      origin: envVars.EVENTS_UI_ORIGIN,
    }
  }

  async function req(bearer: string, method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      ...(body !== undefined
        ? {
            headers: { ...headers(bearer), 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        : { headers: headers(bearer) }),
    })
  }

  async function createEvent(bearer: string, name: string): Promise<string> {
    const res = await req(bearer, 'POST', '/api/v1/ui/events', { name, timezone: 'UTC' })
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }

  async function createGroup(
    ownerBearer: string,
    eventId: string,
    name: string,
  ): Promise<{ id: string; joinCode: string }> {
    const res = await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; join_code: string }
    return { id: body.id, joinCode: body.join_code }
  }

  async function uploadMap(
    bearer: string,
    eventId: string,
    layer = 'site',
  ): Promise<{ id: string }> {
    const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]) // minimal JPEG header
    const formData = new FormData()
    formData.append('file', new File([imageBytes], 'map.jpg', { type: 'image/jpeg' }))
    formData.append('layer', layer)
    formData.append('widthPx', '1024')
    formData.append('heightPx', '768')
    const res = await app.request(`http://localhost/api/v1/ui/events/${eventId}/maps`, {
      method: 'POST',
      headers: headers(bearer),
      body: formData,
    })
    expect(res.status).toBe(201)
    return (await res.json()) as { id: string }
  }

  // One fixture graph shared across the assertions: owner event with a map,
  // a POI and a zone; a member who joined the owner's group by code.
  async function fixture() {
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const ownerBearer = await loginAs(`user_${stamp}_own`)
    const memberId = `user_${stamp}_mem`
    const memberBearer = await loginAs(memberId)
    const eventId = await createEvent(ownerBearer, `GM Fest ${stamp}`)
    const group = await createGroup(ownerBearer, eventId, 'Crew')
    const map = await uploadMap(ownerBearer, eventId, 'site')
    const poiRes = await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/pois`, {
      categoryId: 'stage',
      name: 'Main Stage',
      mapId: map.id,
      xPct: 40,
      yPct: 60,
    })
    expect(poiRes.status).toBe(201)
    const zoneRes = await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/zones`, {
      mapId: map.id,
      polygon: [
        { xPct: 1, yPct: 1 },
        { xPct: 2, yPct: 1 },
        { xPct: 2, yPct: 2 },
      ],
    })
    expect(zoneRes.status).toBe(201)
    const join = await req(memberBearer, 'POST', '/api/v1/ui/groups/join', {
      code: group.joinCode,
    })
    expect(join.status).toBe(200)
    return { ownerBearer, memberBearer, memberId, eventId, group, map }
  }

  it('code-joined member reads maps/pois/zones/image via the group routes (no event_members row)', async () => {
    const { memberBearer, memberId, eventId, group, map } = await fixture()

    // Precondition: the member really has no event_members row, so the
    // event-scoped viewer GET 404s for them.
    expect(await repos.members.findByEventAndUser(eventId, memberId)).toBeNull()
    const direct = await req(memberBearer, 'GET', `/api/v1/ui/events/${eventId}/maps`)
    expect(direct.status).toBe(404)

    const maps = await req(memberBearer, 'GET', `/api/v1/ui/groups/${group.id}/maps`)
    expect(maps.status).toBe(200)
    const mapItems = ((await maps.json()) as { items: Record<string, unknown>[] }).items
    expect(mapItems).toHaveLength(1)
    expect(mapItems[0]!.id).toBe(map.id)
    // Viewer shape — never leak the bucket key.
    expect(mapItems[0]!).not.toHaveProperty('object_key')

    const pois = await req(memberBearer, 'GET', `/api/v1/ui/groups/${group.id}/pois`)
    expect(pois.status).toBe(200)
    const poiItems = ((await pois.json()) as { items: { name: string }[] }).items
    expect(poiItems.map((p) => p.name)).toContain('Main Stage')

    const zones = await req(memberBearer, 'GET', `/api/v1/ui/groups/${group.id}/zones`)
    expect(zones.status).toBe(200)
    expect(((await zones.json()) as { items: unknown[] }).items).toHaveLength(1)

    const image = await req(
      memberBearer,
      'GET',
      `/api/v1/ui/groups/${group.id}/maps/${map.id}/image`,
    )
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/jpeg')
    expect(image.headers.get('cache-control')).toContain('private')
  })

  it('404s all four reads for a non-member', async () => {
    const { group, map } = await fixture()
    const outsider = await loginAs(`user_${Date.now()}_out`)
    for (const path of [
      `/api/v1/ui/groups/${group.id}/maps`,
      `/api/v1/ui/groups/${group.id}/maps/${map.id}/image`,
      `/api/v1/ui/groups/${group.id}/pois`,
      `/api/v1/ui/groups/${group.id}/zones`,
    ]) {
      const res = await req(outsider, 'GET', path)
      expect(res.status).toBe(404)
    }
  })

  it("404s another event's map id on the image route", async () => {
    const { memberBearer, group } = await fixture()
    const otherOwner = await loginAs(`user_${Date.now()}_oth`)
    const otherEvent = await createEvent(otherOwner, `Other Fest ${Date.now()}`)
    const otherMap = await uploadMap(otherOwner, otherEvent, 'site')
    const res = await req(
      memberBearer,
      'GET',
      `/api/v1/ui/groups/${group.id}/maps/${otherMap.id}/image`,
    )
    expect(res.status).toBe(404)
  })

  it('mints an event realtime token for a code-joined group member (widened gate)', async () => {
    const { memberBearer, eventId } = await fixture()
    const res = await req(memberBearer, 'GET', `/api/v1/ui/events/${eventId}/realtime-token`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { channel: string; token: string }
    expect(body.channel).toContain(eventId)
    expect(body.token.length).toBeGreaterThan(10)
  })

  it('still 404s the event realtime token for a complete outsider', async () => {
    const { eventId } = await fixture()
    const outsider = await loginAs(`user_${Date.now()}_rtout`)
    const res = await req(outsider, 'GET', `/api/v1/ui/events/${eventId}/realtime-token`)
    expect(res.status).toBe(404)
  })
})
