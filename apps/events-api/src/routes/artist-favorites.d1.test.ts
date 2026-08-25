import { env } from 'cloudflare:test'
import { makeStubObjectStore } from './_test-services.js'
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

// Integration tests for the day-agnostic artist-favorite surface.
// Favorites are per-user, per-ARTIST within an event (no day component),
// so they work even while the lineup is all-TBA (day_id null).
//
//   POST   /api/v1/ui/events/:id/lineup/favorites — favorite an artist (idempotent)
//   DELETE /api/v1/ui/events/:id/lineup/favorites — unfavorite
//   GET    /api/v1/ui/events/:id/lineup/favorites — list favorited artist keys


const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — event_artist_favorites', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  const services: Services = {
    idClient: {
      // Echo the bearer back as the userId — test tokens are just the userId string.
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
    objectStore: makeStubObjectStore(),
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


  // Mint a session and return the raw bearer token.
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
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }

  async function addMemberViewer(eventId: string, userId: string): Promise<void> {
    await repos.members.add({ id: `mem_${Date.now()}_${userId}`, eventId, userId, role: 'viewer' })
  }

  async function createDay(bearer: string, eventId: string, label: string): Promise<string> {
    const res = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/days`, {
      dayLabel: label,
      date: '2026-08-01',
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }

  // Seed a lineup slot for `artistId` — day-scheduled when `dayId` is
  // provided, TBA (day_id null) when omitted.
  async function createSlot(eventId: string, artistId: string, dayId: string | null = null): Promise<void> {
    if (!(await repos.artists.findById(artistId))) {
      await repos.artists.create({ id: artistId, name: `Artist ${artistId}` })
    }
    await repos.eventArtists.upsert({
      eventId,
      artistId,
      dayId,
      stageId: null,
      tier: null,
      genre: null,
      startTime: null,
      endTime: null,
      displayName: null,
    })
  }

  // --- tests -----------------------------------------------------------

  it('lists no favorites for a fresh event', async () => {
    const owner = `user_${Date.now()}_fav_empty`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Empty Fest')

    const res = await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/lineup/favorites`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[] }
    expect(body.items).toHaveLength(0)
  })

  it('favorites an artist and lists it back', async () => {
    const owner = `user_${Date.now()}_fav_owner`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Favorite Fest')
    const dayId = await createDay(bearer, eventId, 'Day 1')
    const artistId = 'art_favtestartist000000001'
    await createSlot(eventId, artistId, dayId)

    const favRes = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/favorites`, {
      artistId,
    })
    expect(favRes.status).toBe(200)
    const favBody = (await favRes.json()) as {
      event_id: string
      artist_id: string
      favorited: boolean
    }
    expect(favBody.favorited).toBe(true)
    expect(favBody.event_id).toBe(eventId)
    expect(favBody.artist_id).toBe(artistId)

    const listRes = await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/lineup/favorites`)
    expect(listRes.status).toBe(200)
    const listBody = (await listRes.json()) as {
      items: Array<{ event_id: string; artist_id: string }>
    }
    expect(listBody.items).toHaveLength(1)
    expect(listBody.items[0]).toMatchObject({ event_id: eventId, artist_id: artistId })
  })

  it('favorite is idempotent — double-favorite does not duplicate the row', async () => {
    const owner = `user_${Date.now()}_fav_idem`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Idempotent Fest')
    const dayId = await createDay(bearer, eventId, 'Day 1')
    const artistId = 'art_favtestartist000000002'
    await createSlot(eventId, artistId, dayId)

    const first = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/favorites`, { artistId })
    expect(first.status).toBe(200)
    const second = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/favorites`, { artistId })
    expect(second.status).toBe(200)

    const listRes = await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/lineup/favorites`)
    const listBody = (await listRes.json()) as { items: Array<{ artist_id: string }> }
    const matches = listBody.items.filter((f) => f.artist_id === artistId)
    expect(matches).toHaveLength(1)
  })

  it('unfavorite removes the row', async () => {
    const owner = `user_${Date.now()}_unfav`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Unfavorite Fest')
    const dayId = await createDay(bearer, eventId, 'Day 1')
    const artistId = 'art_favtestartist000000003'
    await createSlot(eventId, artistId, dayId)

    await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/favorites`, { artistId })

    const unfavRes = await req(bearer, 'DELETE', `/api/v1/ui/events/${eventId}/lineup/favorites`, {
      artistId,
    })
    expect(unfavRes.status).toBe(200)
    const unfavBody = (await unfavRes.json()) as { favorited: boolean }
    expect(unfavBody.favorited).toBe(false)

    const listRes = await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/lineup/favorites`)
    const listBody = (await listRes.json()) as { items: unknown[] }
    expect(listBody.items).toHaveLength(0)
  })

  it('favoriting works when the artist only has a TBA slot (day_id null)', async () => {
    const owner = `user_${Date.now()}_fav_tba`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'TBA Fest')
    const artistId = 'art_favtestartist000000004'
    // No day created at all — the slot's day_id is null.
    await createSlot(eventId, artistId, null)

    const res = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/favorites`, { artistId })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { favorited: boolean }
    expect(body.favorited).toBe(true)

    const listRes = await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/lineup/favorites`)
    const listBody = (await listRes.json()) as { items: Array<{ artist_id: string }> }
    expect(listBody.items.map((f) => f.artist_id)).toEqual([artistId])
  })

  it('rejects favoriting an artist not on the event lineup (artist_not_in_event)', async () => {
    const owner = `user_${Date.now()}_fav_noslot`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'No Slot Fest')

    const res = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/favorites`, {
      artistId: 'art_favtestartist000000005',
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('artist_not_in_event')
  })

  it("list returns only the caller's favorites, not other users'", async () => {
    const owner = `user_${Date.now()}_fav_isolation_owner`
    const other = `user_${Date.now()}_fav_isolation_other`
    const bearerOwner = await loginAs(owner)
    const bearerOther = await loginAs(other)
    const eventId = await createEvent(bearerOwner, 'Isolation Fest')
    const dayId = await createDay(bearerOwner, eventId, 'Day 1')

    await addMemberViewer(eventId, other)

    const artistA = 'art_favtestartist000000006'
    const artistB = 'art_favtestartist000000007'
    await createSlot(eventId, artistA, dayId)
    await createSlot(eventId, artistB, dayId)

    await req(bearerOwner, 'POST', `/api/v1/ui/events/${eventId}/lineup/favorites`, {
      artistId: artistA,
    })
    await req(bearerOther, 'POST', `/api/v1/ui/events/${eventId}/lineup/favorites`, {
      artistId: artistB,
    })

    const ownerList = (await (
      await req(bearerOwner, 'GET', `/api/v1/ui/events/${eventId}/lineup/favorites`)
    ).json()) as { items: Array<{ artist_id: string }> }
    expect(ownerList.items.map((f) => f.artist_id)).toEqual([artistA])

    const otherList = (await (
      await req(bearerOther, 'GET', `/api/v1/ui/events/${eventId}/lineup/favorites`)
    ).json()) as { items: Array<{ artist_id: string }> }
    expect(otherList.items.map((f) => f.artist_id)).toEqual([artistB])
  })

  it('requires authentication', async () => {
    const eventId = 'evt_doesnotmatter00000001'
    const res = await app.request(`http://localhost/api/v1/ui/events/${eventId}/lineup/favorites`)
    expect(res.status).toBe(401)
  })

  it('400s a malformed body (missing artistId)', async () => {
    const owner = `user_${Date.now()}_fav_badbody`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Bad Body Fest')

    const res = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/favorites`, {})
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('validation_failed')
  })

  it('writes activity rows on favorite and unfavorite', async () => {
    const owner = `user_${Date.now()}_fav_audit`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Audit Fest')
    const dayId = await createDay(bearer, eventId, 'Day 1')
    const artistId = 'art_favtestartist000000008'
    await createSlot(eventId, artistId, dayId)

    await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/favorites`, { artistId })
    await req(bearer, 'DELETE', `/api/v1/ui/events/${eventId}/lineup/favorites`, { artistId })

    const types = (await repos.activity.listForEvent(eventId)).map((a) => a.eventType)
    expect(types).toContain('event.artist_favorited')
    expect(types).toContain('event.artist_unfavorited')
  })
})
