import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { SYSTEM_USER_ID } from '@rallypoint/shared'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'
import { makeNoopMoneyClient, makeNoopListsClient, makeStubObjectStore } from './_test-services.js'

// D1 integration tests for the Browse surface (#browse-tab): the
// browsable listing, the pre-join preview, and invite-free self-join.
// Runs inside a workerd isolate (Miniflare D1), migrations applied by
// apps/events-api/test/apply-d1-migrations.ts.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — browse listing + preview + self-join', () => {
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

  // Direct-repo event seed. The UI create route always assigns ownership
  // to the caller, so system-owned rows have to be planted repo-side
  // (same as the admin RPC would).
  async function seedEvent(over: {
    ownerUserId: string
    privacyMode: 'public' | 'unlisted' | 'private'
    name?: string
  }): Promise<{ id: string; slug: string }> {
    const id = `event_${ulid()}`
    const slug = `browse-${ulid().toLowerCase()}`
    await repos.events.create({
      id,
      tenantId: 'rallypoint',
      ownerUserId: over.ownerUserId,
      slug,
      name: over.name ?? 'Browse Seed',
      timezone: 'UTC',
      privacyMode: over.privacyMode,
      scopeType: 'group',
    })
    return { id, slug }
  }

  interface BrowseItem {
    id: string
    slug: string
    viewer_role: string | null
    viewer_attending: boolean
  }

  async function listAllBrowsable(bearer: string): Promise<BrowseItem[]> {
    const items: BrowseItem[] = []
    let cursor: string | null = null
    do {
      const qs: string = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : '?limit=100'
      const res = await req(bearer, 'GET', `/api/v1/ui/events/browse${qs}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { items: BrowseItem[]; next_cursor: string | null }
      items.push(...body.items)
      cursor = body.next_cursor
    } while (cursor)
    return items
  }

  it('rejects an unauthenticated browse request', async () => {
    const res = await app.request('http://localhost/api/v1/ui/events/browse', {
      headers: { 'x-rp-csrf': CSRF, cookie: `${envVars.EVENTS_CSRF_COOKIE_NAME}=${CSRF}` },
    })
    expect(res.status).toBe(401)
  })

  it('lists system events under every privacy mode + public user events; hides unlisted/private/deleted', async () => {
    const sysPublic = await seedEvent({ ownerUserId: SYSTEM_USER_ID, privacyMode: 'public' })
    const sysUnlisted = await seedEvent({ ownerUserId: SYSTEM_USER_ID, privacyMode: 'unlisted' })
    const sysPrivate = await seedEvent({ ownerUserId: SYSTEM_USER_ID, privacyMode: 'private' })
    const userPublic = await seedEvent({ ownerUserId: 'user_pub_owner', privacyMode: 'public' })
    const userUnlisted = await seedEvent({ ownerUserId: 'user_pub_owner', privacyMode: 'unlisted' })
    const userPrivate = await seedEvent({ ownerUserId: 'user_pub_owner', privacyMode: 'private' })
    const sysDeleted = await seedEvent({ ownerUserId: SYSTEM_USER_ID, privacyMode: 'public' })
    await repos.events.softDelete(sysDeleted.id, new Date())

    const bearer = await loginAs(`user_${Date.now()}_lister`)
    const ids = new Set((await listAllBrowsable(bearer)).map((e) => e.id))
    expect(ids.has(sysPublic.id)).toBe(true)
    expect(ids.has(sysUnlisted.id)).toBe(true)
    expect(ids.has(sysPrivate.id)).toBe(true)
    expect(ids.has(userPublic.id)).toBe(true)
    expect(ids.has(userUnlisted.id)).toBe(false)
    expect(ids.has(userPrivate.id)).toBe(false)
    expect(ids.has(sysDeleted.id)).toBe(false)
  })

  it('reports viewer_role null for strangers and the real role for members', async () => {
    const sys = await seedEvent({ ownerUserId: SYSTEM_USER_ID, privacyMode: 'unlisted' })
    const stranger = await loginAs(`user_${Date.now()}_stranger`)
    const strangerRow = (await listAllBrowsable(stranger)).find((e) => e.id === sys.id)
    expect(strangerRow).toBeDefined()
    expect(strangerRow!.viewer_role).toBeNull()
    expect(strangerRow!.viewer_attending).toBe(false)

    const memberId = `user_${Date.now()}_member`
    const memberBearer = await loginAs(memberId)
    const join = await req(memberBearer, 'POST', `/api/v1/ui/events/${sys.id}/join`, {})
    expect(join.status).toBe(200)
    const memberRow = (await listAllBrowsable(memberBearer)).find((e) => e.id === sys.id)
    expect(memberRow!.viewer_role).toBe('viewer')
    expect(memberRow!.viewer_attending).toBe(true)
  })

  it('rejects an undecodable cursor with 400', async () => {
    const bearer = await loginAs(`user_${Date.now()}_cursor`)
    const res = await req(bearer, 'GET', '/api/v1/ui/events/browse?cursor=%%%garbage')
    expect(res.status).toBe(400)
  })

  it('paginates without dropping or duplicating rows across pages', async () => {
    for (let i = 0; i < 3; i++) {
      await seedEvent({ ownerUserId: SYSTEM_USER_ID, privacyMode: 'unlisted' })
    }
    const bearer = await loginAs(`user_${Date.now()}_pager`)
    const seen = new Set<string>()
    let cursor: string | null = null
    do {
      const qs: string = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2'
      const res = await req(bearer, 'GET', `/api/v1/ui/events/browse${qs}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { items: BrowseItem[]; next_cursor: string | null }
      for (const item of body.items) {
        expect(seen.has(item.id)).toBe(false)
        seen.add(item.id)
      }
      cursor = body.next_cursor
    } while (cursor)
    expect(seen.size).toBeGreaterThanOrEqual(3)
  })

  it('preview returns event + lineup for a browsable event without membership', async () => {
    const sys = await seedEvent({ ownerUserId: SYSTEM_USER_ID, privacyMode: 'unlisted' })
    const stage = await repos.stages.create({ id: `evs_${ulid()}`, eventId: sys.id, name: 'Main' })
    const day = await repos.days.create({
      id: `evd_${ulid()}`,
      eventId: sys.id,
      dayLabel: 'Day 1',
      date: '2026-09-01',
    })
    const artist = await repos.artists.create({ id: `art_${ulid()}`, name: `Act ${ulid()}` })
    await repos.eventArtists.upsert({
      eventId: sys.id,
      artistId: artist.id,
      dayId: day.id,
      stageId: stage.id,
      tier: null,
      genre: null,
      startTime: null,
      endTime: null,
      displayName: null,
    })

    const bearer = await loginAs(`user_${Date.now()}_previewer`)
    const res = await req(bearer, 'GET', `/api/v1/ui/events/browse/${sys.slug}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      event: BrowseItem
      lineup: { stages: unknown[]; days: unknown[]; slots: { artist_name: string }[] } | null
    }
    expect(body.event.id).toBe(sys.id)
    expect(body.event.viewer_role).toBeNull()
    expect(body.lineup).not.toBeNull()
    expect(body.lineup!.stages).toHaveLength(1)
    expect(body.lineup!.days).toHaveLength(1)
    expect(body.lineup!.slots).toHaveLength(1)
    expect(body.lineup!.slots[0]!.artist_name).toBe(artist.name)
  })

  it('preview omits the lineup section when the feature is toggled off', async () => {
    const sys = await seedEvent({ ownerUserId: SYSTEM_USER_ID, privacyMode: 'unlisted' })
    await repos.events.patch(sys.id, { features: { lineup: false } })
    const bearer = await loginAs(`user_${Date.now()}_nolineup`)
    const res = await req(bearer, 'GET', `/api/v1/ui/events/browse/${sys.slug}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { lineup: unknown }
    expect(body.lineup).toBeNull()
  })

  it('preview 404s for non-browsable, deleted, and unknown events', async () => {
    const unlisted = await seedEvent({ ownerUserId: 'user_x', privacyMode: 'unlisted' })
    const priv = await seedEvent({ ownerUserId: 'user_x', privacyMode: 'private' })
    const deleted = await seedEvent({ ownerUserId: SYSTEM_USER_ID, privacyMode: 'public' })
    await repos.events.softDelete(deleted.id, new Date())

    const bearer = await loginAs(`user_${Date.now()}_probe`)
    for (const slug of [unlisted.slug, priv.slug, deleted.slug, 'no-such-slug']) {
      const res = await req(bearer, 'GET', `/api/v1/ui/events/browse/${slug}`)
      expect(res.status).toBe(404)
    }
  })

  it('self-join creates a viewer member + attendee, records activity, and surfaces in /me/events', async () => {
    const sys = await seedEvent({ ownerUserId: SYSTEM_USER_ID, privacyMode: 'unlisted' })
    const userId = `user_${Date.now()}_joiner`
    const bearer = await loginAs(userId)

    const res = await req(bearer, 'POST', `/api/v1/ui/events/${sys.id}/join`, {})
    expect(res.status).toBe(200)
    const body = (await res.json()) as { event_slug: string; role: string }
    expect(body.event_slug).toBe(sys.slug)
    expect(body.role).toBe('viewer')

    expect((await repos.members.findByEventAndUser(sys.id, userId))?.role).toBe('viewer')
    expect((await repos.attendees.findByEventAndUser(sys.id, userId))?.removedAt).toBeNull()
    const activity = await repos.activity.listForEvent(sys.id)
    expect(activity.map((a) => a.eventType)).toContain('event.browse_joined')

    const mine = await req(bearer, 'GET', '/api/v1/ui/events?limit=100')
    const mineBody = (await mine.json()) as { items: { id: string }[] }
    expect(mineBody.items.map((e) => e.id)).toContain(sys.id)
  })

  it('second join 409s already_member; join after soft-remove readmits as viewer', async () => {
    const sys = await seedEvent({ ownerUserId: SYSTEM_USER_ID, privacyMode: 'unlisted' })
    const userId = `user_${Date.now()}_rejoin`
    const bearer = await loginAs(userId)

    expect((await req(bearer, 'POST', `/api/v1/ui/events/${sys.id}/join`, {})).status).toBe(200)
    const dup = await req(bearer, 'POST', `/api/v1/ui/events/${sys.id}/join`, {})
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe('already_member')

    // Soft-remove (revoke) then rejoin — the re-admission path.
    await repos.attendees.softRemove(sys.id, userId, new Date())
    const rejoin = await req(bearer, 'POST', `/api/v1/ui/events/${sys.id}/join`, {})
    expect(rejoin.status).toBe(200)
    expect((await repos.attendees.findByEventAndUser(sys.id, userId))?.removedAt).toBeNull()
    expect((await repos.members.findByEventAndUser(sys.id, userId))?.role).toBe('viewer')
  })

  it('re-admission via self-join downgrades a soft-removed editor to viewer', async () => {
    const owner = `user_${Date.now()}_downowner`
    const bearer = await loginAs(owner)
    const created = await req(bearer, 'POST', '/api/v1/ui/events', {
      name: 'Downgrade Fest',
      timezone: 'UTC',
      privacyMode: 'public',
    })
    const event = (await created.json()) as { id: string; slug: string }

    const exEditor = `user_${Date.now()}_exeditor`
    await repos.members.add({
      id: `evm_${ulid()}`,
      eventId: event.id,
      userId: exEditor,
      role: 'editor',
    })
    await repos.attendees.upsert({ id: `eva_${ulid()}`, eventId: event.id, userId: exEditor })
    await repos.attendees.softRemove(event.id, exEditor, new Date())

    const editorBearer = await loginAs(exEditor)
    const rejoin = await req(editorBearer, 'POST', `/api/v1/ui/events/${event.id}/join`, {})
    expect(rejoin.status).toBe(200)
    expect((await repos.members.findByEventAndUser(event.id, exEditor))?.role).toBe('viewer')
  })

  it('join 404s for non-browsable and missing events, 409s for the owner', async () => {
    const unlisted = await seedEvent({ ownerUserId: 'user_ub', privacyMode: 'unlisted' })
    const bearer = await loginAs(`user_${Date.now()}_denied`)
    expect((await req(bearer, 'POST', `/api/v1/ui/events/${unlisted.id}/join`, {})).status).toBe(404)
    expect(
      (await req(bearer, 'POST', `/api/v1/ui/events/event_${ulid()}/join`, {})).status,
    ).toBe(404)
    // Stale prefix guard.
    expect((await req(bearer, 'POST', '/api/v1/ui/events/evt_nope/join', {})).status).toBe(404)

    const ownerId = `user_${Date.now()}_selfown`
    const ownerBearer = await loginAs(ownerId)
    const created = await req(ownerBearer, 'POST', '/api/v1/ui/events', {
      name: 'Own Join Fest',
      timezone: 'UTC',
      privacyMode: 'public',
    })
    const event = (await created.json()) as { id: string }
    const selfJoin = await req(ownerBearer, 'POST', `/api/v1/ui/events/${event.id}/join`, {})
    expect(selfJoin.status).toBe(409)
    expect(((await selfJoin.json()) as { error: { code: string } }).error.code).toBe(
      'already_owner',
    )
  })
})
