import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { env as testEnv } from 'cloudflare:test'
import type { Hono } from 'hono'
import type { EventsClient, PersonalEventDto, UserEventDto } from '@rallypoint/events-client'
import type { GroupDto, ListDto, ListItemDto, ListsClient } from '@rallypoint/lists-client'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { PLANNER_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for the Planner Upcoming BFF. Same harness shape as the My
// Day BFF test: a real planner session in a Miniflare D1, RPID
// stubbed, both SDKs in-memory fakes. Upcoming is open-ended forward, so the
// BFF passes NO from/to to the events client (recorded so a test asserts it)
// and composeUpcoming does the authoritative bucketing.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'
const ISO = '2026-06-01T00:00:00.000Z'

interface FakeLists {
  client: ListsClient
  seedTask(actor: string, item: { id: string; title?: string; dueDate: string | null }): void
  /** Seed a shared list flagged "show in planner" for the given actor. Returns the list id. */
  seedSharedList(actor: string, listId: string): string
  /** Seed a task item in a given (e.g. shared) list. */
  seedTaskInList(listId: string, item: { id: string; title?: string; dueDate: string | null }): void
  plannerPrefCalls: { listId: string; show: boolean; actor: string }[]
}

function makeFakeLists(): FakeLists {
  const groups: GroupDto[] = []
  const lists: ListDto[] = []
  const itemsByList = new Map<string, ListItemDto[]>()
  // Maps actor → set of list ids flagged show_in_planner=true
  const plannerPrefs = new Map<string, Set<string>>()
  const plannerPrefCalls: { listId: string; show: boolean; actor: string }[] = []

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
    listPlannerLists: async (actor: string) => {
      const flagged = plannerPrefs.get(actor) ?? new Set<string>()
      return lists.filter((l) => flagged.has(l.id))
    },
    setListPlannerPref: async (listId: string, show: boolean, actor: string) => {
      plannerPrefCalls.push({ listId, show, actor })
      let prefs = plannerPrefs.get(actor)
      if (!prefs) {
        prefs = new Set()
        plannerPrefs.set(actor, prefs)
      }
      if (show) prefs.add(listId)
      else prefs.delete(listId)
    },
  } as unknown as ListsClient

  return {
    client,
    plannerPrefCalls,
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
    seedSharedList(actor, listId) {
      // Create the list in a foreign group (not the actor's personal group).
      if (!lists.some((l) => l.id === listId)) {
        lists.push({
          id: listId,
          scopeType: 'group',
          scopeId: `grp_shared_${listId}`,
          listType: 'tasks',
          name: `Shared ${listId}`,
          visibility: 'all',
          color: null,
          incompleteCount: 0,
          createdBy: 'user_shared_owner',
          createdAt: ISO,
          updatedAt: ISO,
        })
        itemsByList.set(listId, [])
      }
      // Flag it in planner prefs for the actor.
      let prefs = plannerPrefs.get(actor)
      if (!prefs) {
        prefs = new Set()
        plannerPrefs.set(actor, prefs)
      }
      prefs.add(listId)
      return listId
    },
    seedTaskInList(listId, item) {
      if (!itemsByList.has(listId)) itemsByList.set(listId, [])
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
        createdBy: 'user_shared_owner',
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

function makeFakeEvents(): FakeEvents {
  const events: PersonalEventDto[] = []
  const userEvents: (UserEventDto & { actor: string })[] = []
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

type Item =
  | { kind: 'task'; task: { id: string }; shared?: boolean }
  | { kind: 'event'; event: { id: string } }
  | { kind: 'eventDay'; eventDay: { eventId: string; date: string; owned: boolean; shared?: boolean } }
interface UpcomingResponse {
  date: string
  timezone: string
  dated: Item[]
  undated: Item[]
}

function ids(items: Item[]): string[] {
  return items.map((i) => {
    if (i.kind === 'task') return i.task.id
    if (i.kind === 'event') return i.event.id
    return `${i.eventDay.eventId}@${i.eventDay.date}`
  })
}

describe('D1 integration — Planner Upcoming BFF', () => {
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
    return app.request(`http://localhost/api/v1/ui/upcoming?${query}`, { headers: headers(bearer) })
  }

  it('requires a session', async () => {
    const res = await app.request('http://localhost/api/v1/ui/upcoming?date=2026-06-03', {
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

  it('defaults to UTC and forwards no window to the events client', async () => {
    const bearer = await loginAs('user_a')
    const res = await get(bearer, 'date=2026-06-03')
    expect(res.status).toBe(200)
    const body = (await res.json()) as UpcomingResponse
    expect(body.timezone).toBe('UTC')
    expect(events.calls).toHaveLength(1)
    expect(events.calls[0]).toEqual({ actor: 'user_a', from: undefined, to: undefined })
  })

  it('returns empty buckets for a fresh user', async () => {
    const bearer = await loginAs('user_a')
    const res = await get(bearer, 'date=2026-06-03&tz=UTC')
    expect(res.status).toBe(200)
    const body = (await res.json()) as UpcomingResponse
    expect(body).toMatchObject({ date: '2026-06-03', timezone: 'UTC', dated: [], undated: [] })
  })

  it('buckets dated vs undated, drops the past, and merge-sorts dated', async () => {
    const bearer = await loginAs('user_b')
    lists.seedTask('user_b', { id: 't-past', dueDate: '2026-06-02T23:00:00.000Z' })
    lists.seedTask('user_b', { id: 't-today', dueDate: '2026-06-03T18:00:00.000Z' })
    lists.seedTask('user_b', { id: 't-future', dueDate: '2026-06-10T08:00:00.000Z' })
    lists.seedTask('user_b', { id: 't-undated', dueDate: null })
    events.seedEvent('user_b', { id: 'e-mid', startAt: '2026-06-05T20:00:00.000Z' })
    events.seedEvent('user_b', { id: 'e-undated', startAt: null })

    const res = await get(bearer, 'date=2026-06-03&tz=UTC')
    const body = (await res.json()) as UpcomingResponse
    expect(ids(body.dated)).toEqual(['t-today', 'e-mid', 't-future'])
    expect(ids(body.undated).sort()).toEqual(['e-undated', 't-undated'])
  })

  it('resolves the lower bound in the requested timezone', async () => {
    const bearer = await loginAs('user_c')
    // 02:00 UTC on 2026-06-03: at/after UTC's start-of-day (00:00Z) so dated,
    // but before New York's start-of-day (04:00Z) so dropped as past.
    lists.seedTask('user_c', { id: 'edge', dueDate: '2026-06-03T02:00:00.000Z' })

    const utc = (await (await get(bearer, 'date=2026-06-03&tz=UTC')).json()) as UpcomingResponse
    expect(ids(utc.dated)).toEqual(['edge'])

    const ny = (await (
      await get(bearer, 'date=2026-06-03&tz=America/New_York')
    ).json()) as UpcomingResponse
    expect(ids(ny.dated)).toEqual([])
    expect(ids(ny.undated)).toEqual([])
  })

  it("does not surface another user's tasks or events", async () => {
    lists.seedTask('user_other', { id: 'foreign-task', dueDate: '2026-06-10T09:00:00.000Z' })
    events.seedEvent('user_other', { id: 'foreign-event', startAt: '2026-06-10T09:00:00.000Z' })
    const bearer = await loginAs('user_e')
    const body = (await (await get(bearer, 'date=2026-06-03&tz=UTC')).json()) as UpcomingResponse
    expect(body.dated).toEqual([])
    expect(body.undated).toEqual([])
  })

  it('folds group event days into the dated stream, one item per day', async () => {
    const bearer = await loginAs('user_g')
    events.seedUserEvent('user_g', {
      eventId: 'event_fest',
      days: [
        { date: '2026-06-04', dayLabel: 'Day 1', startTime: '10:00', endTime: '18:00' },
        { date: '2026-06-05', dayLabel: 'Day 2', startTime: null, endTime: null },
      ],
    })
    const body = (await (await get(bearer, 'date=2026-06-03&tz=UTC')).json()) as UpcomingResponse
    expect(ids(body.dated)).toEqual(['event_fest@2026-06-04', 'event_fest@2026-06-05'])
    const day = body.dated.find((i) => i.kind === 'eventDay')
    expect(day?.kind).toBe('eventDay')
    if (day?.kind === 'eventDay') expect(day.eventDay.owned).toBe(true)
  })

  it('still renders tasks when the group-events call fails (best-effort)', async () => {
    const bearer = await loginAs('user_h')
    lists.seedTask('user_h', { id: 't-keep', dueDate: '2026-06-04T09:00:00.000Z' })
    vi.spyOn(events.client, 'listUserEvents').mockRejectedValueOnce(new Error('events down'))
    const body = (await (await get(bearer, 'date=2026-06-03&tz=UTC')).json()) as UpcomingResponse
    expect(ids(body.dated)).toEqual(['t-keep'])
  })

  // --- planner-flagged shared lists ------------------------------------

  it('includes items from a flagged shared list and stamps them shared:true', async () => {
    const bearer = await loginAs('user_sh1')
    // Personal task.
    lists.seedTask('user_sh1', { id: 't-personal', dueDate: '2026-06-04T09:00:00.000Z' })
    // Shared list flagged in planner for this actor.
    const sharedListId = lists.seedSharedList('user_sh1', 'lst_shared_1')
    lists.seedTaskInList(sharedListId, { id: 't-shared', dueDate: '2026-06-05T10:00:00.000Z' })

    const body = (await (await get(bearer, 'date=2026-06-03&tz=UTC')).json()) as UpcomingResponse
    const taskIds = ids(body.dated)
    expect(taskIds).toContain('t-personal')
    expect(taskIds).toContain('t-shared')

    // Personal task must NOT carry shared:true.
    const personalItem = body.dated.find((i) => i.kind === 'task' && i.task.id === 't-personal')
    expect(personalItem?.kind === 'task' && personalItem.shared).toBeFalsy()

    // Shared task MUST carry shared:true.
    const sharedItem = body.dated.find((i) => i.kind === 'task' && i.task.id === 't-shared')
    expect(sharedItem?.kind === 'task' && sharedItem.shared).toBe(true)
  })

  it('degrades gracefully when listPlannerLists fails (best-effort)', async () => {
    const bearer = await loginAs('user_sh2')
    lists.seedTask('user_sh2', { id: 't-safe', dueDate: '2026-06-04T09:00:00.000Z' })
    vi.spyOn(lists.client, 'listPlannerLists').mockRejectedValueOnce(new Error('lists-api down'))

    const body = (await (await get(bearer, 'date=2026-06-03&tz=UTC')).json()) as UpcomingResponse
    expect(ids(body.dated)).toEqual(['t-safe'])
  })

  // --- planner-flagged group events ------------------------------------

  it('includes a planner-flagged group event day and stamps it shared:true', async () => {
    const bearer = await loginAs('user_pg1')
    // Reachable event.
    events.seedUserEvent('user_pg1', {
      eventId: 'evt_reachable',
      days: [{ date: '2026-06-04', dayLabel: 'Day 1', startTime: null, endTime: null }],
    })
    // Flagged-only event (not in listUserEvents).
    events.seedPlannerGroupEvent('user_pg1', {
      eventId: 'evt_flagged',
      days: [{ date: '2026-06-05', dayLabel: 'Day A', startTime: '10:00', endTime: '18:00' }],
    })

    const body = (await (await get(bearer, 'date=2026-06-03&tz=UTC')).json()) as UpcomingResponse
    const eventDayIds = ids(body.dated)
    expect(eventDayIds).toContain('evt_reachable@2026-06-04')
    expect(eventDayIds).toContain('evt_flagged@2026-06-05')

    const reachableItem = body.dated.find(
      (i) => i.kind === 'eventDay' && i.eventDay.eventId === 'evt_reachable',
    )
    expect(reachableItem?.kind === 'eventDay' && reachableItem.eventDay.shared).toBeFalsy()

    const flaggedItem = body.dated.find(
      (i) => i.kind === 'eventDay' && i.eventDay.eventId === 'evt_flagged',
    )
    expect(flaggedItem?.kind === 'eventDay' && flaggedItem.eventDay.shared).toBe(true)
  })

  it('does not duplicate an event already reachable + flagged', async () => {
    const bearer = await loginAs('user_pg2')
    const days = [{ date: '2026-06-04', dayLabel: 'Day 1', startTime: null, endTime: null }]
    events.seedUserEvent('user_pg2', { eventId: 'evt_both', days })
    events.seedPlannerGroupEvent('user_pg2', { eventId: 'evt_both', days })

    const body = (await (await get(bearer, 'date=2026-06-03&tz=UTC')).json()) as UpcomingResponse
    const matching = body.dated.filter(
      (i) => i.kind === 'eventDay' && i.eventDay.eventId === 'evt_both',
    )
    expect(matching).toHaveLength(1)
    // Reachable wins: shared should NOT be true.
    expect(matching[0]?.kind === 'eventDay' && matching[0].eventDay.shared).toBeFalsy()
  })

  it('degrades gracefully when listPlannerGroupEvents fails (best-effort)', async () => {
    const bearer = await loginAs('user_pg3')
    events.seedUserEvent('user_pg3', {
      eventId: 'evt_safe',
      days: [{ date: '2026-06-04', dayLabel: 'Day 1', startTime: null, endTime: null }],
    })
    vi.spyOn(events.client, 'listPlannerGroupEvents').mockRejectedValueOnce(new Error('down'))

    const body = (await (await get(bearer, 'date=2026-06-03&tz=UTC')).json()) as UpcomingResponse
    expect(ids(body.dated)).toEqual(['evt_safe@2026-06-04'])
  })
})
