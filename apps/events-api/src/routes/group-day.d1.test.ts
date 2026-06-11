import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import type { ListDto, ListItemDto } from '@rallypoint/lists-client'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { makeNoopMoneyClient, makeStubObjectStore } from './_test-services.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for the My Day aggregator (GET /api/v1/ui/groups/:id/day,
// slice 9b #131). Real Postgres (testcontainers) for the events-side data
// (days, lineup, rallies); the lists-client is stubbed so we control which
// task items are "due" without standing up lists-api. We assert the
// aggregation (right day's rallies + lineup + tasks) and the conflict flags.


const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

function listDto(over: Partial<ListDto> & Pick<ListDto, 'id' | 'scopeId' | 'name'>): ListDto {
  return {
    scopeType: 'group',
    listType: 'tasks',
    visibility: 'all',
    color: null,
    createdBy: 'user_seed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function itemDto(
  over: Partial<ListItemDto> & Pick<ListItemDto, 'id' | 'listId' | 'title'>,
): ListItemDto {
  return {
    notes: null,
    assignedTo: null,
    completed: false,
    completedAt: null,
    status: null,
    priority: null,
    dueDate: null,
    position: 1,
    createdBy: 'user_seed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

describe('D1 integration — My Day aggregator', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  // Stubbed lists surface: one group list, items keyed by list id.
  let cannedLists: ListDto[] = []
  let cannedItemsByList: Record<string, ListItemDto[]> = {}

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
    listsClient: {
      health: async () => ({ status: 'ok' }),
      listLists: async () => cannedLists,
      listItems: async (listId) => cannedItemsByList[listId] ?? [],
      listFieldDefs: async () => [],
    },
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
    }
  }

  async function req(bearer: string, method: string, path: string, body?: unknown): Promise<Response> {
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

  async function createGroup(bearer: string, eventId: string, name: string): Promise<string> {
    const res = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name })
    return ((await res.json()) as { id: string }).id
  }

  async function seedDay(eventId: string, date: string): Promise<string> {
    const day = await repos.days.create({
      id: `evd_${ulid()}`,
      eventId,
      dayLabel: date,
      date,
    })
    return day.id
  }

  async function seedSlot(eventId: string, dayId: string, name: string, start: string, end: string): Promise<void> {
    const artist = await repos.artists.create({ id: `art_${ulid()}`, name })
    await repos.eventArtists.upsert({
      eventId,
      artistId: artist.id,
      dayId,
      stageId: null,
      tier: null,
      genre: null,
      startTime: start,
      endTime: end,
      displayName: null,
    })
  }

  async function seedRally(
    groupId: string,
    eventId: string,
    dayId: string,
    title: string,
    startTime: string,
  ): Promise<string> {
    const rally = await repos.rallies.create({
      id: `rally_${ulid()}`,
      groupId,
      eventId,
      title,
      dayId,
      startTime,
      createdBy: 'user_seed',
    })
    return rally.id
  }

  it('aggregates the day and flags a task + rally that fall inside a set', async () => {
    const owner = `user_${Date.now()}_day`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'My Day Event')
    const groupId = await createGroup(bearer, eventId, 'Day Group')

    const date = '2026-06-01'
    const dayId = await seedDay(eventId, date)
    await seedDay(eventId, '2026-06-02') // a second day that must not leak in
    await seedSlot(eventId, dayId, 'Headliner', '22:00:00', '23:00:00')
    const rallyId = await seedRally(groupId, eventId, dayId, 'Meet before headliner', '22:15:00')

    cannedLists = [listDto({ id: 'lst_tasks', scopeId: groupId, name: 'Group tasks' })]
    cannedItemsByList = {
      lst_tasks: [
        itemDto({ id: 'lit_clash', listId: 'lst_tasks', title: 'Grab merch', dueDate: '2026-06-01T22:30:00.000Z' }),
        itemDto({ id: 'lit_ok', listId: 'lst_tasks', title: 'Sunscreen', dueDate: '2026-06-01T10:00:00.000Z' }),
        itemDto({ id: 'lit_other', listId: 'lst_tasks', title: 'Next day', dueDate: '2026-06-02T22:30:00.000Z' }),
      ],
    }

    const res = await req(bearer, 'GET', `/api/v1/ui/groups/${groupId}/day?date=${date}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      date: string
      day: { id: string } | null
      rallies: Array<{ id: string; title: string }>
      lineup: Array<{ label: string; start_time: string }>
      tasks: Array<{ id: string; title: string }>
      conflicts: Array<{ kind: string; id: string; title: string; sets: string[] }>
    }

    expect(body.date).toBe(date)
    expect(body.day?.id).toBe(dayId)
    expect(body.rallies.map((r) => r.title)).toEqual(['Meet before headliner'])
    expect(body.lineup.map((l) => l.label)).toEqual(['Headliner'])
    // Only the two tasks due on the requested date appear (not the 06-02 one).
    expect(body.tasks.map((t) => t.id).sort()).toEqual(['lit_clash', 'lit_ok'])
    // The 22:30 task and 22:15 rally clash with the 22:00–23:00 set; the
    // 10:00 task does not.
    const clashes = body.conflicts
    expect(clashes.map((c) => c.id).sort()).toEqual([rallyId, 'lit_clash'].sort())
    const taskClash = clashes.find((c) => c.id === 'lit_clash')
    expect(taskClash?.kind).toBe('task')
    expect(taskClash?.sets).toEqual(['Headliner'])
    const rallyClash = clashes.find((c) => c.id === rallyId)
    expect(rallyClash?.kind).toBe('rally')
    expect(rallyClash?.title).toBe('Meet before headliner')
    expect(rallyClash?.sets).toEqual(['Headliner'])
  })

  it('returns tasks-due but empty lineup/rallies for a date with no configured day', async () => {
    const owner = `user_${Date.now()}_noday`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'No Day Event')
    const groupId = await createGroup(bearer, eventId, 'No Day Group')

    cannedLists = [listDto({ id: 'lst_nd', scopeId: groupId, name: 'Tasks' })]
    cannedItemsByList = {
      lst_nd: [itemDto({ id: 'lit_nd', listId: 'lst_nd', title: 'Pack', dueDate: '2026-07-04T09:00:00.000Z' })],
    }

    const res = await req(bearer, 'GET', `/api/v1/ui/groups/${groupId}/day?date=2026-07-04`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      day: unknown
      rallies: unknown[]
      lineup: unknown[]
      tasks: Array<{ id: string }>
      conflicts: unknown[]
    }
    expect(body.day).toBeNull()
    expect(body.rallies).toHaveLength(0)
    expect(body.lineup).toHaveLength(0)
    expect(body.tasks.map((t) => t.id)).toEqual(['lit_nd'])
    expect(body.conflicts).toHaveLength(0)
  })

  it('400s a missing or malformed date', async () => {
    const owner = `user_${Date.now()}_baddate`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Bad Date Event')
    const groupId = await createGroup(bearer, eventId, 'Bad Date Group')

    cannedLists = []
    cannedItemsByList = {}

    expect((await req(bearer, 'GET', `/api/v1/ui/groups/${groupId}/day`)).status).toBe(400)
    expect((await req(bearer, 'GET', `/api/v1/ui/groups/${groupId}/day?date=06-01-2026`)).status).toBe(400)
    expect((await req(bearer, 'GET', `/api/v1/ui/groups/${groupId}/day?date=2026-13-40`)).status).toBe(400)
  })

  it('404s a non-member (no existence leak)', async () => {
    const owner = `user_${Date.now()}_dayleak`
    const stranger = `${owner}_stranger`
    const ownerBearer = await loginAs(owner)
    const strangerBearer = await loginAs(stranger)
    const eventId = await createEvent(ownerBearer, 'Day Leak Event')
    const groupId = await createGroup(ownerBearer, eventId, 'Private Day Group')

    const res = await req(strangerBearer, 'GET', `/api/v1/ui/groups/${groupId}/day?date=2026-06-01`)
    expect(res.status).toBe(404)
  })

  it('requires authentication', async () => {
    const res = await app.request('http://localhost/api/v1/ui/groups/group_x/day?date=2026-06-01')
    expect(res.status).toBe(401)
  })
})
