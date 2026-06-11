import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { env as testEnv } from 'cloudflare:test'
import type { Hono } from 'hono'
import type {
  EventsClient,
  PersonalEventDto,
  UserEventDto,
} from '@rallypoint/events-client'
import type {
  GroupDto,
  ListDto,
  ListItemDto,
  ListsClient,
} from '@rallypoint/lists-client'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { PLANNER_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for the Planner My Day BFF. A real planner session lives in
// a Miniflare D1; RPID is stubbed, and BOTH the Lists and Events SDKs
// are in-memory fakes injected at the services layer. The fakes return every
// item/event for the actor (ignoring any window the BFF passes), so the tests
// prove the BFF itself resolves the timezone window and composeMyDay filters
// both inputs to the day.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'
const ISO = '2026-06-01T00:00:00.000Z'

interface FakeLists {
  client: ListsClient
  seedTask(actor: string, item: { id: string; title?: string; dueDate: string | null }): void
}

// A minimal Lists SDK: one personal `list_group` ("My Tasks") per actor and a
// single list under it, materialised lazily as tasks are seeded. Only the read
// methods My Day touches are implemented.
function makeFakeLists(): FakeLists {
  const groups: GroupDto[] = []
  const lists: ListDto[] = []
  const itemsByList = new Map<string, ListItemDto[]>()

  function ensureList(actor: string): string {
    let group = groups.find((g) => g.createdBy === actor && g.name === 'My Tasks')
    if (!group) {
      group = {
        id: `grp_${actor}`,
        name: 'My Tasks',
        description: null,
        createdBy: actor,
        createdAt: ISO,
        updatedAt: ISO,
      }
      groups.push(group)
      const list: ListDto = {
        id: `list_${actor}`,
        scopeType: 'list_group',
        scopeId: group.id,
        listType: 'tasks',
        name: 'Tasks',
        visibility: 'all',
        color: null,
        incompleteCount: 0,
        createdBy: actor,
        createdAt: ISO,
        updatedAt: ISO,
      }
      lists.push(list)
      itemsByList.set(list.id, [])
    }
    return `list_${actor}`
  }

  const client = {
    listGroups: async (actor: string) => groups.filter((g) => g.createdBy === actor),
    listLists: async (scope: { scopeType: string; scopeId: string }) =>
      lists.filter((l) => l.scopeType === scope.scopeType && l.scopeId === scope.scopeId),
    listItems: async (listId: string) => itemsByList.get(listId) ?? [],
  } as unknown as ListsClient

  return {
    client,
    seedTask(actor, item) {
      const listId = ensureList(actor)
      const items = itemsByList.get(listId)!
      items.push({
        id: item.id,
        listId,
        title: item.title ?? item.id,
        notes: null,
        assignedTo: null,
        completed: false,
        completedAt: null,
        status: null,
        priority: null,
        dueDate: item.dueDate,
        position: items.length,
        customFields: {},
        createdBy: actor,
        createdAt: ISO,
        updatedAt: ISO,
      })
    },
  }
}

interface FakeEvents {
  client: EventsClient
  calls: { actor: string; from?: string; to?: string }[]
  seedEvent(actor: string, ev: { id: string; name?: string; startAt: string | null }): void
  seedUserEvent(actor: string, ev: { eventId: string; days: UserEventDto['days'] }): void
  /** Seed a group event flagged "show in planner" for the given actor. */
  seedPlannerGroupEvent(actor: string, ev: { eventId: string; days: UserEventDto['days'] }): void
}

// A minimal Events SDK: listPersonalEvents returns every event for the actor,
// ignoring the from/to window (recorded so a test can assert the BFF forwards
// it) — proving composeMyDay does the authoritative day filtering.
// listUserEvents returns the actor's seeded group events for the eventDay fold.
function makeFakeEvents(): FakeEvents {
  const events: PersonalEventDto[] = []
  const userEvents: (UserEventDto & { actor: string })[] = []
  // actor → set of event ids flagged show_in_planner=true (not in userEvents)
  const plannerGroupEvents: (UserEventDto & { actor: string })[] = []
  const calls: { actor: string; from?: string; to?: string }[] = []

  const client = {
    listPersonalEvents: async (opts: { actor: string; from?: string; to?: string }) => {
      calls.push({ actor: opts.actor, from: opts.from, to: opts.to })
      return events.filter((e) => e.ownerUserId === opts.actor)
    },
    listUserEvents: async (opts: { actor: string }) =>
      userEvents
        .filter((e) => e.actor === opts.actor)
        .map(({ actor: _a, ...dto }) => dto),
    listPlannerGroupEvents: async (opts: { actor: string }) =>
      plannerGroupEvents
        .filter((e) => e.actor === opts.actor)
        .map(({ actor: _a, ...dto }) => dto),
  } as unknown as EventsClient

  return {
    client,
    calls,
    seedEvent(actor, ev) {
      events.push({
        id: ev.id,
        scopeType: 'personal',
        ownerUserId: actor,
        slug: ev.id,
        name: ev.name ?? ev.id,
        description: null,
        startAt: ev.startAt,
        endAt: null,
        timezone: 'UTC',
        locationLabel: null,
        privacyMode: 'private',
        ticketCount: 0,
        createdAt: ISO,
        updatedAt: ISO,
      })
    },
    seedUserEvent(actor, ev) {
      userEvents.push({
        actor,
        eventId: ev.eventId,
        slug: ev.eventId,
        name: ev.eventId,
        scopeType: 'group',
        owned: true,
        startDate: ev.days[0]?.date ?? null,
        endDate: ev.days[ev.days.length - 1]?.date ?? null,
        days: ev.days,
      })
    },
    seedPlannerGroupEvent(actor, ev) {
      plannerGroupEvents.push({
        actor,
        eventId: ev.eventId,
        slug: ev.eventId,
        name: ev.eventId,
        scopeType: 'group',
        owned: false,
        startDate: ev.days[0]?.date ?? null,
        endDate: ev.days[ev.days.length - 1]?.date ?? null,
        days: ev.days,
      })
    },
  }
}

interface MyDayResponse {
  date: string
  timezone: string
  tasks: { id: string }[]
  events: { id: string }[]
  eventDays: { eventId: string; date: string; owned: boolean; shared?: boolean }[]
}

describe('D1 integration — Planner My Day BFF', () => {
  let repos: Repos
  let env: Env
  let app: Hono<HonoApp>
  let lists: FakeLists
  let events: FakeEvents

  const baseServices = (): Services => ({
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    },
    rpidSso: { exchange: vi.fn().mockResolvedValue({ ok: false, reason: 'invalid' }) },
    listsClient: lists.client,
    eventsClient: events.client,
    settings: {
      get: async () => ({}),
      patch: async () => ({}),
    },
  })

  beforeAll(() => {
    repos = buildD1Repos(createDb(testEnv.DB))
    env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
  })

  beforeEach(() => {
    lists = makeFakeLists()
    events = makeFakeEvents()
    app = buildApp({ env, logger: undefined, repos, services: baseServices() })
  })

  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(PLANNER_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { PLANNER_SESSION_KEY_V1: env.PLANNER_SESSION_KEY_V1 },
      keyVersion: env.PLANNER_SESSION_KEY_VERSION,
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
      cookie: `${env.PLANNER_SESSION_COOKIE_NAME}=${bearer}; ${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
    }
  }

  function get(bearer: string, query: string) {
    return app.request(`http://localhost/api/v1/ui/my-day?${query}`, { headers: headers(bearer) })
  }

  it('requires a session', async () => {
    const res = await app.request('http://localhost/api/v1/ui/my-day?date=2026-06-03', {
      headers: { cookie: `${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`, 'x-rp-csrf': CSRF },
    })
    expect(res.status).toBe(401)
  })

  it('400s when date is missing', async () => {
    const bearer = await loginAs('user_a')
    const res = await get(bearer, 'tz=UTC')
    expect(res.status).toBe(400)
  })

  it('400s on a malformed date', async () => {
    const bearer = await loginAs('user_a')
    const res = await get(bearer, 'date=not-a-date&tz=UTC')
    expect(res.status).toBe(400)
  })

  it('400s on an unrecognised timezone', async () => {
    const bearer = await loginAs('user_a')
    const res = await get(bearer, 'date=2026-06-03&tz=Not/AZone')
    expect(res.status).toBe(400)
  })

  it('defaults to UTC when tz is omitted', async () => {
    const bearer = await loginAs('user_a')
    const res = await get(bearer, 'date=2026-06-03')
    expect(res.status).toBe(200)
    const body = (await res.json()) as MyDayResponse
    expect(body.timezone).toBe('UTC')
    expect(events.calls[0]).toMatchObject({
      from: '2026-06-03T00:00:00.000Z',
      to: '2026-06-04T00:00:00.000Z',
    })
  })

  it('returns empty buckets for a fresh user', async () => {
    const bearer = await loginAs('user_a')
    const res = await get(bearer, 'date=2026-06-03&tz=UTC')
    expect(res.status).toBe(200)
    const body = (await res.json()) as MyDayResponse
    expect(body).toMatchObject({ date: '2026-06-03', timezone: 'UTC', tasks: [], events: [] })
  })

  it('merges only the tasks and events that fall on the day, sorted', async () => {
    const bearer = await loginAs('user_b')
    lists.seedTask('user_b', { id: 'yesterday', dueDate: '2026-06-02T23:00:00.000Z' })
    lists.seedTask('user_b', { id: 't-late', dueDate: '2026-06-03T18:00:00.000Z' })
    lists.seedTask('user_b', { id: 't-early', dueDate: '2026-06-03T08:00:00.000Z' })
    lists.seedTask('user_b', { id: 'undated', dueDate: null })
    events.seedEvent('user_b', { id: 'e-pm', startAt: '2026-06-03T20:00:00.000Z' })
    events.seedEvent('user_b', { id: 'e-am', startAt: '2026-06-03T09:00:00.000Z' })
    events.seedEvent('user_b', { id: 'e-next', startAt: '2026-06-04T09:00:00.000Z' })

    const res = await get(bearer, 'date=2026-06-03&tz=UTC')
    const body = (await res.json()) as MyDayResponse
    expect(body.tasks.map((t) => t.id)).toEqual(['t-early', 't-late'])
    expect(body.events.map((e) => e.id)).toEqual(['e-am', 'e-pm'])
  })

  it('resolves the day window in the requested timezone', async () => {
    const bearer = await loginAs('user_c')
    // 02:00 UTC on the 4th: outside UTC's 2026-06-03 day, but inside
    // New York's (window [06-03T04:00Z, 06-04T04:00Z)).
    lists.seedTask('user_c', { id: 'edge', dueDate: '2026-06-04T02:00:00.000Z' })

    const utc = (await (await get(bearer, 'date=2026-06-03&tz=UTC')).json()) as MyDayResponse
    expect(utc.tasks.map((t) => t.id)).toEqual([])

    const ny = (await (
      await get(bearer, 'date=2026-06-03&tz=America/New_York')
    ).json()) as MyDayResponse
    expect(ny.tasks.map((t) => t.id)).toEqual(['edge'])
  })

  it('forwards the actor and the resolved UTC window to the events client', async () => {
    const bearer = await loginAs('user_d')
    await get(bearer, 'date=2026-06-03&tz=America/Chicago')
    expect(events.calls).toHaveLength(1)
    expect(events.calls[0]).toEqual({
      actor: 'user_d',
      from: '2026-06-03T05:00:00.000Z',
      to: '2026-06-04T05:00:00.000Z',
    })
  })

  it("does not surface another user's tasks or events", async () => {
    lists.seedTask('user_other', { id: 'foreign-task', dueDate: '2026-06-03T09:00:00.000Z' })
    events.seedEvent('user_other', { id: 'foreign-event', startAt: '2026-06-03T09:00:00.000Z' })
    const bearer = await loginAs('user_e')
    const body = (await (await get(bearer, 'date=2026-06-03&tz=UTC')).json()) as MyDayResponse
    expect(body.tasks).toEqual([])
    expect(body.events).toEqual([])
  })

  it('folds the group event day that falls on the day, carrying owned', async () => {
    const bearer = await loginAs('user_g')
    events.seedUserEvent('user_g', {
      eventId: 'event_fest',
      days: [
        { date: '2026-06-02', dayLabel: 'Before', startTime: null, endTime: null },
        { date: '2026-06-03', dayLabel: 'Today', startTime: '10:00', endTime: '18:00' },
        { date: '2026-06-04', dayLabel: 'After', startTime: null, endTime: null },
      ],
    })
    const body = (await (await get(bearer, 'date=2026-06-03&tz=UTC')).json()) as MyDayResponse
    expect(body.eventDays.map((d) => d.date)).toEqual(['2026-06-03'])
    expect(body.eventDays[0]?.owned).toBe(true)
  })

  it('still renders tasks when the group-events call fails (best-effort)', async () => {
    const bearer = await loginAs('user_h')
    lists.seedTask('user_h', { id: 't-keep', dueDate: '2026-06-03T09:00:00.000Z' })
    vi.spyOn(events.client, 'listUserEvents').mockRejectedValueOnce(new Error('events down'))
    const body = (await (await get(bearer, 'date=2026-06-03&tz=UTC')).json()) as MyDayResponse
    expect(body.tasks.map((t) => t.id)).toEqual(['t-keep'])
    expect(body.eventDays).toEqual([])
  })

  // --- planner-flagged group events -----------------------------------

  it('includes a planner-flagged group event day and stamps it shared:true', async () => {
    const bearer = await loginAs('user_pg1')
    // Reachable event (not flagged) — owned:true from listUserEvents.
    events.seedUserEvent('user_pg1', {
      eventId: 'evt_reachable',
      days: [{ date: '2026-06-03', dayLabel: 'Day 1', startTime: null, endTime: null }],
    })
    // Flagged-only event (not in listUserEvents) — shows in Planner.
    events.seedPlannerGroupEvent('user_pg1', {
      eventId: 'evt_flagged',
      days: [{ date: '2026-06-03', dayLabel: 'Day A', startTime: '10:00', endTime: '18:00' }],
    })

    const body = (await (await get(bearer, 'date=2026-06-03&tz=UTC')).json()) as MyDayResponse
    const eventIds = body.eventDays.map((d) => d.eventId)
    expect(eventIds).toContain('evt_reachable')
    expect(eventIds).toContain('evt_flagged')

    const reachableDay = body.eventDays.find((d) => d.eventId === 'evt_reachable')
    expect(reachableDay?.shared).toBeFalsy()

    const flaggedDay = body.eventDays.find((d) => d.eventId === 'evt_flagged')
    expect(flaggedDay?.shared).toBe(true)
  })

  it('does not duplicate an event already reachable + flagged', async () => {
    const bearer = await loginAs('user_pg2')
    const days = [{ date: '2026-06-03', dayLabel: 'Day 1', startTime: null, endTime: null }]
    events.seedUserEvent('user_pg2', { eventId: 'evt_both', days })
    events.seedPlannerGroupEvent('user_pg2', { eventId: 'evt_both', days })

    const body = (await (await get(bearer, 'date=2026-06-03&tz=UTC')).json()) as MyDayResponse
    const matching = body.eventDays.filter((d) => d.eventId === 'evt_both')
    expect(matching).toHaveLength(1)
    // Reachable wins: shared should NOT be true
    expect(matching[0]?.shared).toBeFalsy()
  })

  it('degrades gracefully when listPlannerGroupEvents fails (best-effort)', async () => {
    const bearer = await loginAs('user_pg3')
    events.seedUserEvent('user_pg3', {
      eventId: 'evt_safe',
      days: [{ date: '2026-06-03', dayLabel: 'Day 1', startTime: null, endTime: null }],
    })
    vi.spyOn(events.client, 'listPlannerGroupEvents').mockRejectedValueOnce(new Error('down'))

    const body = (await (await get(bearer, 'date=2026-06-03&tz=UTC')).json()) as MyDayResponse
    expect(body.eventDays.map((d) => d.eventId)).toEqual(['evt_safe'])
  })
})
