import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'
import { createBindingObjectStore } from '@rallypoint/object-store'
import type { R2Bucket } from '@cloudflare/workers-types'
import { makeNoopMoneyClient, makeNoopListsClient } from './_test-services.js'

// Integration tests for the /api/v1/sdk/events surface — the truly
// public, cookieless one (slice 11). Authenticated PATCH calls set up
// `public_page_config` via the existing /api/v1/ui/events PATCH; the
// SDK calls then verify gating, hidden_fields, cache headers, and the
// flat camelCase DTO shape.


const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — SDK public events', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  const services: Services = {
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
    // Real Miniflare R2 binding so the public image serve routes can
    // actually stream stored bytes (#409).
    objectStore: createBindingObjectStore(env.OBJECT_STORE as unknown as R2Bucket),
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

  function authHeaders(bearer: string): Record<string, string> {
    return {
      cookie: `${envVars.EVENTS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.EVENTS_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      'content-type': 'application/json',
    }
  }

  async function authedReq(
    bearer: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: authHeaders(bearer),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  // Truly public request — no cookies, no CSRF header.
  async function publicReq(method: string, path: string): Promise<Response> {
    return app.request(`http://localhost${path}`, { method })
  }

  // Slugs are server-generated post-#16-follow-up; callers pass a
  // name and receive the resulting slug back so tests that need to
  // hit `/api/v1/sdk/events/:slug/...` can use the canonical value.
  async function createEvent(
    bearer: string,
    name: string,
    privacyMode: 'public' | 'unlisted' | 'private' = 'public',
  ): Promise<{ id: string; slug: string }> {
    const res = await authedReq(bearer, 'POST', '/api/v1/ui/events', {
      name,
      timezone: 'UTC',
      privacyMode,
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; slug: string }
    return { id: body.id, slug: body.slug }
  }

  async function enablePublicPage(
    bearer: string,
    eventId: string,
    config: Record<string, unknown> = { enabled: true },
  ): Promise<void> {
    const res = await authedReq(bearer, 'PATCH', `/api/v1/ui/events/${eventId}`, {
      publicPageConfig: config,
    })
    expect(res.status).toBe(200)
  }

  it('404s a slug that does not exist', async () => {
    const res = await publicReq('GET', '/api/v1/sdk/events/nope')
    expect(res.status).toBe(404)
  })

  it('404s when public_page_config is missing / enabled is false', async () => {
    const owner = `user_${Date.now()}_off`
    const bearer = await loginAs(owner)
    const { slug } = await createEvent(bearer, 'Off Event')
    const res = await publicReq('GET', `/api/v1/sdk/events/${slug}`)
    expect(res.status).toBe(404)
  })

  it('200s a public event when enabled:true + privacy:public', async () => {
    const owner = `user_${Date.now()}_pub`
    const bearer = await loginAs(owner)
    const { id, slug } = await createEvent(bearer, 'Public Event', 'public')
    await enablePublicPage(bearer, id, { enabled: true, theme: { accent_color: '#ff00aa' } })

    const res = await publicReq('GET', `/api/v1/sdk/events/${slug}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe(
      'public, max-age=60, stale-while-revalidate=300',
    )
    const body = (await res.json()) as Record<string, unknown>
    expect(body.slug).toBe(slug)
    expect(body.name).toBe('Public Event')
    expect(body.privacyMode).toBe('public')
    expect((body.theme as Record<string, unknown>).accentColor).toBe('#ff00aa')
  })

  it('200s when privacy:unlisted (link-only access)', async () => {
    const owner = `user_${Date.now()}_unl`
    const bearer = await loginAs(owner)
    const { id, slug } = await createEvent(bearer, 'Unlisted Event', 'unlisted')
    await enablePublicPage(bearer, id, { enabled: true })
    const res = await publicReq('GET', `/api/v1/sdk/events/${slug}`)
    expect(res.status).toBe(200)
  })

  it('404s when privacy:private even with enabled:true', async () => {
    const owner = `user_${Date.now()}_pri`
    const bearer = await loginAs(owner)
    const { id, slug } = await createEvent(bearer, 'Private Event', 'private')
    await enablePublicPage(bearer, id, { enabled: true })
    const res = await publicReq('GET', `/api/v1/sdk/events/${slug}`)
    expect(res.status).toBe(404)
  })

  it('404s when enabled flips to false', async () => {
    const owner = `user_${Date.now()}_flip`
    const bearer = await loginAs(owner)
    const { id, slug } = await createEvent(bearer, 'Toggle Event', 'public')
    await enablePublicPage(bearer, id, { enabled: true })
    expect((await publicReq('GET', `/api/v1/sdk/events/${slug}`)).status).toBe(200)
    await enablePublicPage(bearer, id, { enabled: false })
    expect((await publicReq('GET', `/api/v1/sdk/events/${slug}`)).status).toBe(404)
  })

  it('hidden_fields strips matching keys from the response', async () => {
    const owner = `user_${Date.now()}_hide`
    const bearer = await loginAs(owner)
    const { id, slug } = await createEvent(bearer, 'Hide Event', 'public')
    await authedReq(bearer, 'PATCH', `/api/v1/ui/events/${id}`, {
      description: 'Visible description',
      locationLabel: 'Visible location',
      publicPageConfig: {
        enabled: true,
        hidden_fields: ['description', 'location_label'],
      },
    })
    const body = (await (await publicReq('GET', `/api/v1/sdk/events/${slug}`)).json()) as Record<
      string,
      unknown
    >
    expect(body.description).toBeNull()
    expect(body.locationLabel).toBeNull()
    // dates not hidden → either both null (we never set them) or set; this test
    // only asserts on the keys that were configured to be hidden.
  })

  it('lineup endpoint returns 404 under the same gating', async () => {
    const owner = `user_${Date.now()}_lupgate`
    const bearer = await loginAs(owner)
    const { slug } = await createEvent(bearer, 'No Lineup', 'public')
    // No enablePublicPage call → 404.
    const res = await publicReq('GET', `/api/v1/sdk/events/${slug}/lineup`)
    expect(res.status).toBe(404)
  })

  it('lineup endpoint returns the flat shape on a public event', async () => {
    const owner = `user_${Date.now()}_lup`
    const bearer = await loginAs(owner)
    const { id, slug } = await createEvent(bearer, 'Lineup Event', 'public')
    await enablePublicPage(bearer, id, { enabled: true })
    const res = await publicReq('GET', `/api/v1/sdk/events/${slug}/lineup`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown[]>
    expect(Array.isArray(body.stages)).toBe(true)
    expect(Array.isArray(body.days)).toBe(true)
    expect(Array.isArray(body.artists)).toBe(true)
    expect(Array.isArray(body.eventArtists)).toBe(true)
  })

  it('sessions endpoint returns items:[] when no approved sessions exist', async () => {
    const owner = `user_${Date.now()}_sess`
    const bearer = await loginAs(owner)
    const { id, slug } = await createEvent(bearer, 'Sessions Event', 'public')
    await enablePublicPage(bearer, id, { enabled: true })
    const res = await publicReq('GET', `/api/v1/sdk/events/${slug}/sessions`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[] }
    expect(body.items).toEqual([])
  })

  // --- public image serve routes (#409) -----------------------------
  // These stream bytes from the real Miniflare R2 binding, gated by the
  // same public-page-config check as the JSON route.
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  async function seedMap(eventId: string): Promise<{ mapId: string; objectKey: string }> {
    const mapId = `emp_${Date.now()}${Math.floor(Math.random() * 1e6)}`
    const objectKey = `event-maps/${eventId}/${mapId}.png`
    await (env.OBJECT_STORE as unknown as R2Bucket).put(objectKey, PNG, {
      httpMetadata: { contentType: 'image/png' },
    })
    await repos.maps.create({
      id: mapId,
      eventId,
      layer: 'site',
      objectKey,
      contentType: 'image/png',
      bytes: PNG.byteLength,
      widthPx: 1000,
      heightPx: 1000,
      uploadedByUserId: 'user_seed',
    })
    return { mapId, objectKey }
  }

  it('public map image route streams bytes for an enabled public event', async () => {
    const bearer = await loginAs(`user_${Date.now()}_mapimg`)
    const { id } = await createEvent(bearer, 'Map Image Event', 'public')
    await enablePublicPage(bearer, id, { enabled: true })
    const { mapId } = await seedMap(id)

    const res = await publicReq('GET', `/api/v1/sdk/events/${id}/maps/${mapId}/image`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
  })

  it('public map image route 404s when the page is not enabled', async () => {
    const bearer = await loginAs(`user_${Date.now()}_mapoff`)
    const { id } = await createEvent(bearer, 'Map Image Off', 'public')
    const { mapId } = await seedMap(id)
    // No enablePublicPage → gate() rejects.
    const res = await publicReq('GET', `/api/v1/sdk/events/${id}/maps/${mapId}/image`)
    expect(res.status).toBe(404)
  })

  it('public map image route 404s a map id from another event', async () => {
    const bearer = await loginAs(`user_${Date.now()}_mapx`)
    const { id } = await createEvent(bearer, 'Map Image Pub', 'public')
    await enablePublicPage(bearer, id, { enabled: true })
    const { id: otherId } = await createEvent(bearer, 'Other Event', 'public')
    const { mapId: foreignMapId } = await seedMap(otherId)

    const res = await publicReq('GET', `/api/v1/sdk/events/${id}/maps/${foreignMapId}/image`)
    expect(res.status).toBe(404)
  })

  it('public background-image route 404s when no background key is configured', async () => {
    const bearer = await loginAs(`user_${Date.now()}_bgnone`)
    const { id } = await createEvent(bearer, 'No BG Event', 'public')
    await enablePublicPage(bearer, id, { enabled: true })
    const res = await publicReq('GET', `/api/v1/sdk/events/${id}/background-image`)
    expect(res.status).toBe(404)
  })
})
