import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { env as testEnv } from 'cloudflare:test'
import type { Hono } from 'hono'
import {
  type GroupDto,
  type ListDto,
  type ListItemSeriesDto,
  type ListsClient,
} from '@rallypoint/lists-client'
import { PERSONAL_GROUP_NAME_LEGACY } from '../lib/personal-scope.js'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { PLANNER_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for GET /api/v1/ui/recurring.
// Harness mirrors lists.d1.test.ts: real D1 planner session, in-memory Lists
// SDK fake injected at the services layer, eventsClient/profiles stubbed.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'
const ISO_BASE = '2026-06-08T00:00:00.000Z'

// --- in-memory fake Lists SDK (minimal surface for recurring tests) ----

interface FakeListsRecurring {
  client: ListsClient
  // Provision a personal group + task list for an actor; returns listId.
  seedPersonalList(actor: string, opts?: { listType?: 'tasks' | 'notes'; name?: string }): string
  // Add a series row to a list (no item materialization needed for this route).
  seedSeries(listId: string, s: Partial<ListItemSeriesDto> & { title: string; freq: 'daily' | 'weekly'; dtstart: string }): string
  reset(): void
}

function makeFakeListsRecurring(): FakeListsRecurring {
  let groups: GroupDto[] = []
  let lists: ListDto[] = []
  let seriesRows: ListItemSeriesDto[] = []
  let listCounter = 0
  let seriesCounter = 0

  function reset(): void {
    groups = []
    lists = []
    seriesRows = []
    listCounter = 0
    seriesCounter = 0
  }

  const client: ListsClient = {
    health: async () => ({ status: 'ok' }),
    listGroups: async (actor) => groups.filter((g) => g.createdBy === actor),
    createGroup: async (input, actor) => {
      const g: GroupDto = {
        id: `lgr_${groups.length + 1}`,
        name: input.name,
        description: input.description ?? null,
        createdBy: actor,
        createdAt: ISO_BASE,
        updatedAt: ISO_BASE,
      }
      groups.push(g)
      return g
    },
    listLists: async (scope) =>
      lists.filter((l) => l.scopeType === scope.scopeType && l.scopeId === scope.scopeId),
    createList: async (input, actor) => {
      const l: ListDto = {
        id: `lst_r${++listCounter}`,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        listType: input.listType,
        name: input.name,
        visibility: input.visibility,
        color: input.color ?? null,
        incompleteCount: 0,
        createdBy: actor,
        createdAt: ISO_BASE,
        updatedAt: ISO_BASE,
      }
      lists.push(l)
      return l
    },
    listSeries: async (listId) => seriesRows.filter((s) => s.listId === listId),
    // Minimal stubs for methods required by the interface that the recurring
    // route does not call.
    listItems: async () => [],
    createListItem: async () => { throw new Error('unexpected call') },
    updateListItem: async () => { throw new Error('unexpected call') },
    deleteListItem: async () => { throw new Error('unexpected call') },
    listFieldDefs: async () => [],
    createFieldDef: async () => { throw new Error('unexpected call') },
    updateFieldDef: async () => { throw new Error('unexpected call') },
    deleteFieldDef: async () => { throw new Error('unexpected call') },
    createListItemSeries: async () => { throw new Error('unexpected call') },
    updateSeries: async () => { throw new Error('unexpected call') },
    deleteSeries: async () => { throw new Error('unexpected call') },
  }

  return {
    client,
    seedPersonalList(actor, opts = {}) {
      const listType = opts.listType ?? 'tasks'
      const name = opts.name ?? (listType === 'notes' ? 'Notes' : 'My List')
      // Legacy name models the pre-migration rollout state; selectPersonalGroup
      // accepts either PERSONAL_GROUP_NAME_LEGACY or the new PERSONAL_GROUP_NAME.
      let group = groups.find((g) => g.createdBy === actor && g.name === PERSONAL_GROUP_NAME_LEGACY)
      if (!group) {
        group = {
          id: `lgr_${actor}`,
          name: PERSONAL_GROUP_NAME_LEGACY,
          description: null,
          createdBy: actor,
          createdAt: ISO_BASE,
          updatedAt: ISO_BASE,
        }
        groups.push(group)
      }
      const l: ListDto = {
        id: `lst_r${++listCounter}`,
        scopeType: 'list_group',
        scopeId: group.id,
        listType,
        name,
        visibility: 'all',
        color: null,
        incompleteCount: 0,
        createdBy: actor,
        createdAt: ISO_BASE,
        updatedAt: ISO_BASE,
      }
      lists.push(l)
      return l.id
    },
    seedSeries(listId, s) {
      const id = `lse_r${++seriesCounter}`
      const row: ListItemSeriesDto = {
        id,
        listId,
        title: s.title,
        notes: s.notes ?? null,
        assignedTo: s.assignedTo ?? null,
        priority: s.priority ?? null,
        freq: s.freq,
        interval: s.interval ?? 1,
        byDay: s.byDay ?? null,
        dtstart: s.dtstart,
        until: s.until ?? null,
        count: s.count ?? null,
        timeOfDay: s.timeOfDay ?? null,
        createdBy: s.createdBy ?? 'system',
        createdAt: ISO_BASE,
        updatedAt: ISO_BASE,
      }
      seriesRows.push(row)
      return id
    },
    reset,
  }
}

// --- test harness -------------------------------------------------------

describe('D1 integration — Planner Recurring Roll-up BFF', () => {
  let repos: Repos
  let env: Env
  let app: Hono<HonoApp>
  let fake: FakeListsRecurring

  const baseServices = (): Services => ({
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    },
    rpidSso: {
      exchange: vi.fn().mockResolvedValue({ ok: false, reason: 'invalid' }),
    },
    listsClient: fake.client,
    settings: {
      get: async () => ({}),
      patch: async () => ({}),
    },
  } as unknown as Services)

  beforeAll(() => {
    repos = buildD1Repos(createDb(testEnv.DB))
    env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
  })

  beforeEach(() => {
    fake = makeFakeListsRecurring()
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

  function headers(bearer: string, extra?: Record<string, string>): Record<string, string> {
    return {
      cookie: `${env.PLANNER_SESSION_COOKIE_NAME}=${bearer}; ${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      ...extra,
    }
  }

  interface RecurringItem {
    id: string
    listId: string
    listName: string
    title: string
    notes: string | null
    freq: string
    interval: number
    byDay: string[] | null
    dtstart: string
    until: string | null
    count: number | null
    timeOfDay: string | null
    priority: string | null
    next: string[]
  }

  interface RecurringResponse {
    date: string
    recurring: RecurringItem[]
  }

  // 1. Returns series across multiple personal task lists, each with `next`
  //    preview; ordering: earliest-next first; exhausted series sorts last.
  it('returns series from multiple task lists, correctly ordered', async () => {
    const actor = 'user_rc1'
    const bearer = await loginAs(actor)

    const list1 = fake.seedPersonalList(actor, { name: 'Habits' })
    const list2 = fake.seedPersonalList(actor, { name: 'Work' })

    // Series that fires on 2026-06-10 (next Wednesday)
    fake.seedSeries(list1, { title: 'Yoga', freq: 'weekly', interval: 1, byDay: ['WE'], dtstart: '2026-06-03' })
    // Series that fires on 2026-06-09 (tomorrow, Tuesday)
    fake.seedSeries(list2, { title: 'Standup', freq: 'weekly', interval: 1, byDay: ['TU'], dtstart: '2026-06-03' })
    // Exhausted series: until is in the past
    fake.seedSeries(list1, { title: 'Sprint', freq: 'daily', interval: 1, dtstart: '2026-01-01', until: '2026-01-31' })

    const res = await app.request('http://localhost/api/v1/ui/recurring?date=2026-06-08&tz=UTC', {
      headers: headers(bearer),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as RecurringResponse
    expect(body.date).toBe('2026-06-08')
    expect(body.recurring).toHaveLength(3)

    // First: Standup (2026-06-09), second: Yoga (2026-06-10), third: Sprint (exhausted)
    expect(body.recurring[0].title).toBe('Standup')
    expect(body.recurring[0].next[0]).toBe('2026-06-09')
    expect(body.recurring[0].listName).toBe('Work')

    expect(body.recurring[1].title).toBe('Yoga')
    expect(body.recurring[1].next[0]).toBe('2026-06-10')
    expect(body.recurring[1].listName).toBe('Habits')

    expect(body.recurring[2].title).toBe('Sprint')
    expect(body.recurring[2].next).toEqual([])
  })

  // 2. Does NOT include series from the notes list.
  it('excludes series from the notes list', async () => {
    const actor = 'user_rc2'
    const bearer = await loginAs(actor)

    const taskList = fake.seedPersonalList(actor, { name: 'Tasks', listType: 'tasks' })
    const notesList = fake.seedPersonalList(actor, { name: 'Notes', listType: 'notes' })

    fake.seedSeries(taskList, { title: 'Task Series', freq: 'daily', interval: 1, dtstart: '2026-06-08', count: 5 })
    fake.seedSeries(notesList, { title: 'Note Series', freq: 'daily', interval: 1, dtstart: '2026-06-08', count: 5 })

    const res = await app.request('http://localhost/api/v1/ui/recurring?date=2026-06-08&tz=UTC', {
      headers: headers(bearer),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as RecurringResponse
    // Only the task series should appear; notes list is excluded by listPersonalTaskLists
    expect(body.recurring).toHaveLength(1)
    expect(body.recurring[0].title).toBe('Task Series')
  })

  // 3. 400 on missing date.
  it('400s when date query param is missing', async () => {
    const actor = 'user_rc3'
    const bearer = await loginAs(actor)
    const res = await app.request('http://localhost/api/v1/ui/recurring?tz=UTC', {
      headers: headers(bearer),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('validation_failed')
  })

  // 4. 400 on invalid date format.
  it('400s when date query param is not a valid YYYY-MM-DD date', async () => {
    const actor = 'user_rc4'
    const bearer = await loginAs(actor)
    const res = await app.request('http://localhost/api/v1/ui/recurring?date=not-a-date&tz=UTC', {
      headers: headers(bearer),
    })
    expect(res.status).toBe(400)
  })

  // 5. Requires an authenticated session.
  it('401s without a session', async () => {
    const res = await app.request('http://localhost/api/v1/ui/recurring?date=2026-06-08&tz=UTC', {
      headers: {
        cookie: `${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`,
        'x-rp-csrf': CSRF,
      },
    })
    expect(res.status).toBe(401)
  })

  // 6. Returns empty recurring array when user has no series.
  it('returns empty recurring array when user has no lists', async () => {
    const actor = 'user_rc5'
    const bearer = await loginAs(actor)

    const res = await app.request('http://localhost/api/v1/ui/recurring?date=2026-06-08&tz=UTC', {
      headers: headers(bearer),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as RecurringResponse
    expect(body.recurring).toEqual([])
  })

  // 6b. IDOR: one user's series never leak into another user's roll-up.
  it('does not leak another user\'s series across actors', async () => {
    const owner = 'user_rc5a'
    const ownerBearer = await loginAs(owner)
    const ownerList = fake.seedPersonalList(owner, { name: 'Owner Habits' })
    fake.seedSeries(ownerList, {
      title: 'Owner Yoga',
      freq: 'daily',
      interval: 1,
      dtstart: '2026-06-08',
      count: 5,
    })

    // Owner sees their own series.
    const ownerRes = await app.request(
      'http://localhost/api/v1/ui/recurring?date=2026-06-08&tz=UTC',
      { headers: headers(ownerBearer) },
    )
    expect(ownerRes.status).toBe(200)
    expect(((await ownerRes.json()) as RecurringResponse).recurring).toHaveLength(1)

    // A different actor (with no lists of their own) sees nothing — not the
    // owner's series. The roll-up is scoped by actor via listPersonalTaskLists.
    const otherBearer = await loginAs('user_rc5b')
    const otherRes = await app.request(
      'http://localhost/api/v1/ui/recurring?date=2026-06-08&tz=UTC',
      { headers: headers(otherBearer) },
    )
    expect(otherRes.status).toBe(200)
    expect(((await otherRes.json()) as RecurringResponse).recurring).toEqual([])
  })

  // 7. Exhausted series (until in the past) has next: [] and sorts last;
  //    among multiple exhausted, they sort by title.
  it('exhausted series sort last alphabetically by title', async () => {
    const actor = 'user_rc6'
    const bearer = await loginAs(actor)

    const list = fake.seedPersonalList(actor)

    // Two exhausted series — "Beta" should sort before "Alpha"... wait, alpha before beta
    fake.seedSeries(list, { title: 'Zeta', freq: 'daily', interval: 1, dtstart: '2026-01-01', until: '2026-01-31' })
    fake.seedSeries(list, { title: 'Alpha', freq: 'daily', interval: 1, dtstart: '2026-01-01', until: '2026-01-31' })
    // One active series
    fake.seedSeries(list, { title: 'Active', freq: 'daily', interval: 1, dtstart: '2026-06-08', count: 3 })

    const res = await app.request('http://localhost/api/v1/ui/recurring?date=2026-06-08&tz=UTC', {
      headers: headers(bearer),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as RecurringResponse
    expect(body.recurring).toHaveLength(3)
    // Active first
    expect(body.recurring[0].title).toBe('Active')
    // Exhausted sorted by title
    expect(body.recurring[1].title).toBe('Alpha')
    expect(body.recurring[2].title).toBe('Zeta')
    expect(body.recurring[1].next).toEqual([])
    expect(body.recurring[2].next).toEqual([])
  })
})
