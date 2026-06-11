import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type { Hono } from 'hono'
import type { RealtimeBus, RealtimeEnvelope, Subscription } from '@rallypoint/realtime'
import { createBindingObjectStore } from '@rallypoint/object-store'
import { MAP_MAX_BYTES } from '@rallypoint/events-shared'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for the map/POI/zone surface against real D1 + real
// Miniflare R2 (OBJECT_STORE binding). Upload, serve, and delete paths all
// hit the actual R2 in-process binding — no presign stubs, no mocks (#409).

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

// Recording bus captures publish() so we can assert the pointer envelope a
// map/POI/zone mutation fans onto the event's map channel (slice 10, #72).
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

describe('D1 integration — maps / POIs / no-go zones', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>
  const bus = makeRecordingBus()
  const deletedKeys: string[] = []

  // Wrap the real R2 binding with a spy so we can assert deleteObject was called.
  let services: Services

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })

    // Real R2 binding for upload/serve tests; spy on deleteObject.
    const realStore = createBindingObjectStore(env.OBJECT_STORE)
    const spyStore = {
      ...realStore,
      deleteObject: async (key: string) => {
        deletedKeys.push(key)
        return realStore.deleteObject(key)
      },
    }

    services = {
      idClient: {
        verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
        signoutRpidBearer: async () => {},
        batchLookupUsers: async () => [],
      },
      rpidSso: {
        exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
      },
      rpidReauth: {
        verify: async () => ({ ok: true as const }),
      },
      objectStore: spyStore,
      weather: {
        getEventWeather: async () => ({ forecast: null, airQuality: null, issuedAt: new Date().toISOString() }),
      },
      settings: {
        get: async () => ({}),
        patch: async (_u, _n, patch) => patch,
      },
    } as unknown as Services

    app = buildApp({ env: envVars, logger: undefined, repos, services, realtime: bus })
  })

  beforeEach(() => {
    deletedKeys.length = 0
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
    }
  }

  async function req(bearer: string, method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: headers(bearer),
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { ...headers(bearer), 'content-type': 'application/json' } } : {}),
    })
  }

  async function createEvent(bearer: string, name: string): Promise<string> {
    const res = await req(bearer, 'POST', '/api/v1/ui/events', { name, timezone: 'UTC' })
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }

  // Upload a map via multipart/form-data (the new single-request flow, #409).
  // Returns the created map row DTO.
  async function uploadMap(
    bearer: string,
    eventId: string,
    layer = 'site',
  ): Promise<{ id: string; object_key?: string; layer: string }> {
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
    return (await res.json()) as { id: string; object_key?: string; layer: string }
  }

  it('upload + serve: happy path stores bytes in R2 and streams them back', async () => {
    const bearer = await loginAs(`user_${Date.now()}_upload`)
    const eventId = await createEvent(bearer, 'Upload Fest')
    const map = await uploadMap(bearer, eventId, 'site')
    expect(map.id).toMatch(/^emp_/)

    // The object must be in R2 — headObject returns non-null.
    const row = await repos.maps.findById(map.id)
    expect(row).not.toBeNull()
    const obj = await env.OBJECT_STORE.head(row!.objectKey)
    expect(obj).not.toBeNull()
    expect(obj!.httpMetadata?.contentType).toBe('image/jpeg')

    // The serve route should return the image bytes.
    const serve = await app.request(
      `http://localhost/api/v1/ui/events/${eventId}/maps/${map.id}/image`,
      { method: 'GET', headers: headers(bearer) },
    )
    expect(serve.status).toBe(200)
    expect(serve.headers.get('Content-Type')).toBe('image/jpeg')
  })

  it('upload rejects unsupported mime type', async () => {
    const bearer = await loginAs(`user_${Date.now()}_badmime`)
    const eventId = await createEvent(bearer, 'BadMime Fest')

    const formData = new FormData()
    formData.append('file', new File([new Uint8Array([0])], 'map.gif', { type: 'image/gif' }))
    formData.append('layer', 'site')
    formData.append('widthPx', '1024')
    formData.append('heightPx', '768')

    const res = await app.request(`http://localhost/api/v1/ui/events/${eventId}/maps`, {
      method: 'POST',
      headers: headers(bearer),
      body: formData,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unsupported_image_type')
  })

  it('upload rejects an oversize file before storing anything', async () => {
    const bearer = await loginAs(`user_${Date.now()}_big`)
    const eventId = await createEvent(bearer, 'Oversize Fest')

    const before = (await env.OBJECT_STORE.list()).objects.length
    const formData = new FormData()
    // One byte over the 10 MB cap.
    formData.append('file', new File([new Uint8Array(MAP_MAX_BYTES + 1)], 'big.jpg', { type: 'image/jpeg' }))
    formData.append('layer', 'site')
    formData.append('widthPx', '1024')
    formData.append('heightPx', '768')

    const res = await app.request(`http://localhost/api/v1/ui/events/${eventId}/maps`, {
      method: 'POST',
      headers: headers(bearer),
      body: formData,
    })
    expect(res.status).toBe(400)
    // Validation runs before put — no object should have landed in R2.
    expect((await env.OBJECT_STORE.list()).objects.length).toBe(before)
  })

  it('upload rejects invalid dimensions', async () => {
    const bearer = await loginAs(`user_${Date.now()}_dims`)
    const eventId = await createEvent(bearer, 'Dims Fest')

    const formData = new FormData()
    // Valid JPEG header so this fixture exercises the DIMENSION check, not the
    // magic-byte gate — keeps the test failing for the right reason if the
    // validation order ever changes.
    formData.append('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], 'map.jpg', { type: 'image/jpeg' }))
    formData.append('layer', 'site')
    formData.append('widthPx', '100') // below 512px minimum
    formData.append('heightPx', '768')

    const res = await app.request(`http://localhost/api/v1/ui/events/${eventId}/maps`, {
      method: 'POST',
      headers: headers(bearer),
      body: formData,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('image_too_small')
  })

  it('409 on layer clash', async () => {
    const bearer = await loginAs(`user_${Date.now()}_clash`)
    const eventId = await createEvent(bearer, 'Clash Fest')
    await uploadMap(bearer, eventId, 'site')

    // Second 'site' map should 409.
    const formData = new FormData()
    formData.append('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], 'map2.jpg', { type: 'image/jpeg' }))
    formData.append('layer', 'site')
    formData.append('widthPx', '1024')
    formData.append('heightPx', '768')

    const clash = await app.request(`http://localhost/api/v1/ui/events/${eventId}/maps`, {
      method: 'POST',
      headers: headers(bearer),
      body: formData,
    })
    expect(clash.status).toBe(409)
    expect(((await clash.json()) as { error: { code: string } }).error.code).toBe('map_layer_taken')
  })

  it('delete reaps the R2 object before dropping the row', async () => {
    const bearer = await loginAs(`user_${Date.now()}_del`)
    const eventId = await createEvent(bearer, 'Delete Fest')
    const map = await uploadMap(bearer, eventId, 'site')

    const row = await repos.maps.findById(map.id)
    const objectKey = row!.objectKey

    const del = await req(bearer, 'DELETE', `/api/v1/ui/events/${eventId}/maps/${map.id}`)
    expect(del.status).toBe(204)
    expect(deletedKeys).toContain(objectKey)
    expect(await repos.maps.findById(map.id)).toBeNull()
    // Object should be gone from R2 too.
    expect(await env.OBJECT_STORE.head(objectKey)).toBeNull()
  })

  it('serve route 404s when the map belongs to a different event', async () => {
    const bearer = await loginAs(`user_${Date.now()}_idor`)
    const eventA = await createEvent(bearer, 'Event A')
    const eventB = await createEvent(bearer, 'Event B')
    const map = await uploadMap(bearer, eventA, 'site')

    const res = await req(bearer, 'GET', `/api/v1/ui/events/${eventB}/maps/${map.id}/image`)
    expect(res.status).toBe(404)
  })

  it('enforces role gates and does not leak foreign events', async () => {
    const owner = await loginAs(`user_${Date.now()}_owner`)
    const stranger = await loginAs(`user_${Date.now()}_stranger`)
    const eventId = await createEvent(owner, 'Gated Fest')

    // Stranger can't even see the event exists → 404, not 403.
    const list = await req(stranger, 'GET', `/api/v1/ui/events/${eventId}/maps`)
    expect(list.status).toBe(404)
    const formData = new FormData()
    formData.append('file', new File([new Uint8Array([0])], 'x.jpg', { type: 'image/jpeg' }))
    formData.append('layer', 'site')
    formData.append('widthPx', '1024')
    formData.append('heightPx', '768')
    const upload = await app.request(`http://localhost/api/v1/ui/events/${eventId}/maps`, {
      method: 'POST',
      headers: headers(stranger),
      body: formData,
    })
    expect(upload.status).toBe(404)
  })

  it('CRUDs POIs and scopes map_id to the event', async () => {
    const bearer = await loginAs(`user_${Date.now()}_poi`)
    const eventId = await createEvent(bearer, 'POI Fest')
    const map = await uploadMap(bearer, eventId, 'site')

    const created = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/pois`, {
      categoryId: 'water',
      name: 'Water Refill',
      mapId: map.id,
      xPct: 12.5,
      yPct: 80,
    })
    expect(created.status).toBe(201)
    const poi = (await created.json()) as { id: string; x_pct: string; map_id: string }
    expect(poi.map_id).toBe(map.id)
    expect(Number(poi.x_pct)).toBeCloseTo(12.5)

    // A POI referencing a map from another event → 404.
    const otherEvent = await createEvent(bearer, 'Other Fest')
    const foreign = await req(bearer, 'POST', `/api/v1/ui/events/${otherEvent}/pois`, {
      categoryId: 'water',
      name: 'Borrowed Map POI',
      mapId: map.id,
      xPct: 1,
      yPct: 1,
    })
    expect(foreign.status).toBe(404)

    const patched = await req(bearer, 'PATCH', `/api/v1/ui/events/${eventId}/pois/${poi.id}`, {
      xPct: 50,
      yPct: 50,
    })
    expect(patched.status).toBe(200)
    expect(Number(((await patched.json()) as { x_pct: string }).x_pct)).toBeCloseTo(50)

    const listed = (await (await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/pois`)).json()) as {
      items: Array<{ id: string }>
    }
    expect(listed.items.map((p) => p.id)).toContain(poi.id)

    const del = await req(bearer, 'DELETE', `/api/v1/ui/events/${eventId}/pois/${poi.id}`)
    expect(del.status).toBe(204)
  })

  it('publishes map pointer envelopes on map upload, POI, and zone mutations', async () => {
    const owner = `user_${Date.now()}_mappub`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Map Pub Fest')
    const channel = `events:event:${eventId}`
    const onChannel = () => bus.published.filter((p) => p.channel === channel)

    // Upload a map → maps/create on the event channel.
    const beforeUpload = onChannel().length
    const map = await uploadMap(bearer, eventId, 'site')
    let last = onChannel()[onChannel().length - 1]!
    expect(onChannel().length).toBe(beforeUpload + 1)
    expect(last.env.resource).toBe('maps')
    expect(last.env.operation).toBe('create')
    expect(last.env.payload.id).toBe(map.id)
    expect(last.env.authorId).toBe(owner)

    // POI create.
    const beforePoi = onChannel().length
    const poi = (await (await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/pois`, {
      categoryId: 'water',
      name: 'Pub Water',
      mapId: map.id,
      xPct: 10,
      yPct: 10,
    })).json()) as { id: string }
    last = onChannel()[onChannel().length - 1]!
    expect(onChannel().length).toBe(beforePoi + 1)
    expect(last.env.resource).toBe('pois')
    expect(last.env.operation).toBe('create')
    expect(last.env.payload.id).toBe(poi.id)

    // Zone create.
    const beforeZone = onChannel().length
    const zone = (await (await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/zones`, {
      mapId: map.id,
      polygon: [{ xPct: 0, yPct: 0 }, { xPct: 10, yPct: 0 }, { xPct: 10, yPct: 10 }],
    })).json()) as { id: string }
    last = onChannel()[onChannel().length - 1]!
    expect(onChannel().length).toBe(beforeZone + 1)
    expect(last.env.resource).toBe('no_go_zones')
    expect(last.env.operation).toBe('create')
    expect(last.env.payload.id).toBe(zone.id)
  })

  it('POI/zone repo update() returns null on a deleted row (concurrent-delete invariant)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_concurrent`)
    const eventId = await createEvent(bearer, 'Concurrent Delete Fest')
    const map = await uploadMap(bearer, eventId, 'site')

    const poiRes = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/pois`, {
      categoryId: 'water',
      name: 'Doomed POI',
      mapId: map.id,
      xPct: 10,
      yPct: 10,
    })
    expect(poiRes.status).toBe(201)
    const poi = (await poiRes.json()) as { id: string }
    await repos.pois.delete(poi.id)
    const poiUpdateResult = await repos.pois.update(poi.id, { xPct: 50, yPct: 50 })
    expect(poiUpdateResult).toBeNull()

    const zoneRes = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/zones`, {
      mapId: map.id,
      polygon: [{ xPct: 0, yPct: 0 }, { xPct: 10, yPct: 0 }, { xPct: 10, yPct: 10 }],
    })
    expect(zoneRes.status).toBe(201)
    const zone = (await zoneRes.json()) as { id: string }
    await repos.noGoZones.delete(zone.id)
    const zoneUpdateResult = await repos.noGoZones.update(zone.id, {
      polygon: [{ xPct: 0, yPct: 0 }, { xPct: 20, yPct: 0 }, { xPct: 20, yPct: 20 }],
    })
    expect(zoneUpdateResult).toBeNull()
  })

  it('CRUDs no-go zones and requires the map to belong to the event', async () => {
    const bearer = await loginAs(`user_${Date.now()}_zone`)
    const eventId = await createEvent(bearer, 'Zone Fest')
    const map = await uploadMap(bearer, eventId, 'site')

    const polygon = [
      { xPct: 10, yPct: 10 },
      { xPct: 40, yPct: 10 },
      { xPct: 40, yPct: 40 },
    ]
    const created = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/zones`, {
      mapId: map.id,
      polygon,
    })
    expect(created.status).toBe(201)
    const zone = (await created.json()) as { id: string; polygon: Array<{ xPct: number }> }
    expect(zone.polygon).toHaveLength(3)

    // Degenerate polygon (<3 points) → 400.
    const bad = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/zones`, {
      mapId: map.id,
      polygon: [{ xPct: 1, yPct: 1 }],
    })
    expect(bad.status).toBe(400)

    const patched = await req(bearer, 'PATCH', `/api/v1/ui/events/${eventId}/zones/${zone.id}`, {
      polygon: [...polygon, { xPct: 10, yPct: 40 }],
    })
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as { polygon: unknown[] }).polygon).toHaveLength(4)

    const del = await req(bearer, 'DELETE', `/api/v1/ui/events/${eventId}/zones/${zone.id}`)
    expect(del.status).toBe(204)

    const activity = (await repos.activity.listForEvent(eventId)).map((a) => a.eventType)
    expect(activity).toContain('event.map_uploaded')
    expect(activity).toContain('event.zone_created')
    expect(activity).toContain('event.zone_updated')
    expect(activity).toContain('event.zone_deleted')
  })

  // --- Magic-byte (file signature) gate ------------------------------------

  it('rejects HTML bytes declared as image/jpeg — polyglot attack (400)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_magic_jpeg`)
    const eventId = await createEvent(bearer, 'Magic Byte Fest')

    const htmlBytes = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]) // <html>
    const formData = new FormData()
    formData.append('file', new File([htmlBytes], 'evil.jpg', { type: 'image/jpeg' }))
    formData.append('layer', 'site')
    formData.append('widthPx', '1024')
    formData.append('heightPx', '768')

    const res = await app.request(`http://localhost/api/v1/ui/events/${eventId}/maps`, {
      method: 'POST',
      headers: headers(bearer),
      body: formData,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unsupported_image_type')
    // The route must have rejected before the R2 put — assert no map row was created.
    const maps = await repos.maps.listForEvent(eventId)
    expect(maps.length).toBe(0)
  })

  it('rejects HTML bytes declared as image/png (400)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_magic_png`)
    const eventId = await createEvent(bearer, 'Magic Byte PNG Fest')

    const htmlBytes = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]) // <html>
    const formData = new FormData()
    formData.append('file', new File([htmlBytes], 'evil.png', { type: 'image/png' }))
    formData.append('layer', 'site')
    formData.append('widthPx', '1024')
    formData.append('heightPx', '768')

    const res = await app.request(`http://localhost/api/v1/ui/events/${eventId}/maps`, {
      method: 'POST',
      headers: headers(bearer),
      body: formData,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unsupported_image_type')
  })

  it('accepts valid JPEG magic bytes declared as image/jpeg (control)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_magic_ok`)
    const eventId = await createEvent(bearer, 'Magic OK Fest')
    // uploadMap uses a valid JPEG header — it should still pass.
    const map = await uploadMap(bearer, eventId, 'site')
    expect(map.id).toMatch(/^emp_/)
  })
})
