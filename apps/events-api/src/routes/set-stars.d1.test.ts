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

// Integration tests for the set-star surface (issue #194).
// Tests run against a real Postgres (testcontainers, 120-second timeout).
// Covers:
//   - star is idempotent (double-star returns the same result, no dup row)
//   - unstar removes the row
//   - list returns only the authenticated user's stars (not other users')
//   - starring an event the user cannot view is denied (404)
//   - cross-event day rejected (day_not_in_event 400)
//   - viewer-level access is sufficient (attendee who is not an editor can star)
//   - migration applies cleanly (implicit — all tests run against a migrated DB)


const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — event_set_stars', () => {
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

  // A star can only point at a lineup slot that exists (event_set_stars
  // has a composite FK to event_artists). Seed the catalog artist + the
  // slot row directly through the repos so a star has something to hang on.
  async function createSlot(eventId: string, artistId: string, dayId: string): Promise<void> {
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

  it('stars a set and lists it back', async () => {
    const owner = `user_${Date.now()}_star_owner`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Star Fest')
    const dayId = await createDay(bearer, eventId, 'Day 1')
    const artistId = 'art_testartist0000000000001'
    await createSlot(eventId, artistId, dayId)

    // Star it.
    const starRes = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/stars`, {
      artistId,
      dayId,
    })
    expect(starRes.status).toBe(200)
    const starBody = (await starRes.json()) as {
      event_id: string
      artist_id: string
      day_id: string
      starred: boolean
    }
    expect(starBody.starred).toBe(true)
    expect(starBody.event_id).toBe(eventId)
    expect(starBody.artist_id).toBe(artistId)
    expect(starBody.day_id).toBe(dayId)

    // List confirms the star.
    const listRes = await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/lineup/stars`)
    expect(listRes.status).toBe(200)
    const listBody = (await listRes.json()) as {
      items: Array<{ event_id: string; artist_id: string; day_id: string }>
    }
    expect(listBody.items).toHaveLength(1)
    expect(listBody.items[0]).toMatchObject({
      event_id: eventId,
      artist_id: artistId,
      day_id: dayId,
    })
  })

  it('star is idempotent — double-star does not duplicate the row', async () => {
    const owner = `user_${Date.now()}_star_idem`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Idempotent Fest')
    const dayId = await createDay(bearer, eventId, 'Day 1')
    const artistId = 'art_testartist0000000000002'
    await createSlot(eventId, artistId, dayId)

    await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/stars`, { artistId, dayId })
    await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/stars`, { artistId, dayId })

    const listRes = await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/lineup/stars`)
    const listBody = (await listRes.json()) as {
      items: Array<{ artist_id: string; day_id: string }>
    }
    // Only one row despite two POSTs.
    const matches = listBody.items.filter(
      (s) => s.artist_id === artistId && s.day_id === dayId,
    )
    expect(matches).toHaveLength(1)
  })

  it('unstar removes the row', async () => {
    const owner = `user_${Date.now()}_unstar`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Unstar Fest')
    const dayId = await createDay(bearer, eventId, 'Day 1')
    const artistId = 'art_testartist0000000000003'
    await createSlot(eventId, artistId, dayId)

    // Star first.
    await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/stars`, { artistId, dayId })

    // Unstar.
    const unstarRes = await req(bearer, 'DELETE', `/api/v1/ui/events/${eventId}/lineup/stars`, {
      artistId,
      dayId,
    })
    expect(unstarRes.status).toBe(200)
    const unstarBody = (await unstarRes.json()) as { starred: boolean }
    expect(unstarBody.starred).toBe(false)

    // List is now empty.
    const listRes = await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/lineup/stars`)
    const listBody = (await listRes.json()) as { items: unknown[] }
    expect(listBody.items).toHaveLength(0)
  })

  it("list returns only the caller's stars, not other users'", async () => {
    const owner = `user_${Date.now()}_isolation_owner`
    const other = `user_${Date.now()}_isolation_other`
    const bearerOwner = await loginAs(owner)
    const bearerOther = await loginAs(other)
    const eventId = await createEvent(bearerOwner, 'Isolation Fest')
    const dayId = await createDay(bearerOwner, eventId, 'Day 1')

    // Add other user as viewer.
    await addMemberViewer(eventId, other)

    const artistA = 'art_testartist0000000000004'
    const artistB = 'art_testartist0000000000005'
    await createSlot(eventId, artistA, dayId)
    await createSlot(eventId, artistB, dayId)

    // Owner stars artist A.
    await req(bearerOwner, 'POST', `/api/v1/ui/events/${eventId}/lineup/stars`, {
      artistId: artistA,
      dayId,
    })
    // Other user stars artist B.
    await req(bearerOther, 'POST', `/api/v1/ui/events/${eventId}/lineup/stars`, {
      artistId: artistB,
      dayId,
    })

    // Owner only sees artist A.
    const ownerList = (await (
      await req(bearerOwner, 'GET', `/api/v1/ui/events/${eventId}/lineup/stars`)
    ).json()) as { items: Array<{ artist_id: string }> }
    expect(ownerList.items.map((s) => s.artist_id)).toEqual([artistA])

    // Other user only sees artist B.
    const otherList = (await (
      await req(bearerOther, 'GET', `/api/v1/ui/events/${eventId}/lineup/stars`)
    ).json()) as { items: Array<{ artist_id: string }> }
    expect(otherList.items.map((s) => s.artist_id)).toEqual([artistB])
  })

  it('viewer-level role is sufficient — attendee can star without editor role', async () => {
    const owner = `user_${Date.now()}_viewer_owner`
    const viewer = `user_${Date.now()}_viewer_user`
    const bearerOwner = await loginAs(owner)
    const bearerViewer = await loginAs(viewer)
    const eventId = await createEvent(bearerOwner, 'Viewer Star Fest')
    const dayId = await createDay(bearerOwner, eventId, 'Day 1')
    await addMemberViewer(eventId, viewer)
    await createSlot(eventId, 'art_testartist0000000000006', dayId)

    const starRes = await req(bearerViewer, 'POST', `/api/v1/ui/events/${eventId}/lineup/stars`, {
      artistId: 'art_testartist0000000000006',
      dayId,
    })
    expect(starRes.status).toBe(200)
  })

  it('starring an event the user cannot view is denied (404)', async () => {
    const owner = `user_${Date.now()}_deny_owner`
    const stranger = `user_${Date.now()}_deny_stranger`
    const bearerOwner = await loginAs(owner)
    const bearerStranger = await loginAs(stranger)
    const eventId = await createEvent(bearerOwner, 'Private Fest')
    const dayId = await createDay(bearerOwner, eventId, 'Day 1')

    // Stranger has no member row — should 404 (loadForAction with viewer).
    const starRes = await req(bearerStranger, 'POST', `/api/v1/ui/events/${eventId}/lineup/stars`, {
      artistId: 'art_testartist0000000000007',
      dayId,
    })
    expect(starRes.status).toBe(404)
  })

  it('rejects a day that belongs to a different event (day_not_in_event)', async () => {
    const owner = `user_${Date.now()}_cross_owner`
    const bearer = await loginAs(owner)
    const eventAId = await createEvent(bearer, 'Event A')
    const eventBId = await createEvent(bearer, 'Event B')
    // dayId belongs to event B.
    const dayIdB = await createDay(bearer, eventBId, 'Day 1')

    // Try to star on event A using event B's day.
    const starRes = await req(bearer, 'POST', `/api/v1/ui/events/${eventAId}/lineup/stars`, {
      artistId: 'art_testartist0000000000008',
      dayId: dayIdB,
    })
    expect(starRes.status).toBe(400)
    const body = (await starRes.json()) as { error: { code: string } }
    expect(body.error.code).toBe('day_not_in_event')
  })

  it('unstar of a non-existent star is graceful (200, starred=false)', async () => {
    const owner = `user_${Date.now()}_graceful_owner`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Graceful Fest')
    const dayId = await createDay(bearer, eventId, 'Day 1')

    // Unstar without having starred first.
    const res = await req(bearer, 'DELETE', `/api/v1/ui/events/${eventId}/lineup/stars`, {
      artistId: 'art_testartist0000000000009',
      dayId,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { starred: boolean }
    expect(body.starred).toBe(false)
  })

  it('migration creates the event_set_stars table and it accepts rows', async () => {
    // This test is implicit in the others, but we verify directly that the
    // repo layer round-trips a star record through PG.
    const userId = `user_${Date.now()}_migration`
    const owner = `user_${Date.now()}_mig_owner`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Migration Fest')
    const dayId = await createDay(bearer, eventId, 'Migration Day')
    await createSlot(eventId, 'art_testartist0000000000010', dayId)

    const didStar = await repos.eventSetStars.star(userId, {
      eventId,
      artistId: 'art_testartist0000000000010',
      dayId,
    })
    expect(didStar).toBe(true)

    const starred = await repos.eventSetStars.listForUserEvent(userId, eventId)
    expect(starred).toHaveLength(1)
    expect(starred[0]).toMatchObject({
      eventId,
      artistId: 'art_testartist0000000000010',
      dayId,
    })

    const isStarred = await repos.eventSetStars.isStarred(userId, {
      eventId,
      artistId: 'art_testartist0000000000010',
      dayId,
    })
    expect(isStarred).toBe(true)

    // Double-star returns false (already exists).
    const didStarAgain = await repos.eventSetStars.star(userId, {
      eventId,
      artistId: 'art_testartist0000000000010',
      dayId,
    })
    expect(didStarAgain).toBe(false)

    // Unstar.
    const didUnstar = await repos.eventSetStars.unstar(userId, {
      eventId,
      artistId: 'art_testartist0000000000010',
      dayId,
    })
    expect(didUnstar).toBe(true)

    const afterUnstar = await repos.eventSetStars.listForUserEvent(userId, eventId)
    expect(afterUnstar).toHaveLength(0)
  })

  it('rejects starring a slot that does not exist (set_not_in_event)', async () => {
    const owner = `user_${Date.now()}_noslot_owner`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'No Slot Fest')
    const dayId = await createDay(bearer, eventId, 'Day 1')
    // Day belongs to the event, but no lineup slot was ever added.
    const res = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/stars`, {
      artistId: 'art_testartist0000000000011',
      dayId,
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('set_not_in_event')
  })

  it('drops the star when its lineup slot is removed (FK cascade)', async () => {
    const owner = `user_${Date.now()}_cascade_owner`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Cascade Fest')
    const dayId = await createDay(bearer, eventId, 'Day 1')
    const artistId = 'art_testartist0000000000012'
    await createSlot(eventId, artistId, dayId)

    await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/stars`, { artistId, dayId })
    expect(await repos.eventSetStars.listForUserEvent(owner, eventId)).toHaveLength(1)

    // Removing the slot cascades the star away.
    await repos.eventArtists.delete(eventId, artistId, dayId)
    expect(await repos.eventSetStars.listForUserEvent(owner, eventId)).toHaveLength(0)
  })

  it('writes activity rows on star and unstar', async () => {
    const owner = `user_${Date.now()}_audit_owner`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Audit Fest')
    const dayId = await createDay(bearer, eventId, 'Day 1')
    const artistId = 'art_testartist0000000000013'
    await createSlot(eventId, artistId, dayId)

    await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/stars`, { artistId, dayId })
    await req(bearer, 'DELETE', `/api/v1/ui/events/${eventId}/lineup/stars`, { artistId, dayId })

    const types = (await repos.activity.listForEvent(eventId)).map((a) => a.eventType)
    expect(types).toContain('event.set_starred')
    expect(types).toContain('event.set_unstarred')
  })
})
