import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { env as testEnv } from 'cloudflare:test'
import type { Hono } from 'hono'
import {
  ListsClientError,
  type GroupDto,
  type ListDto,
  type ListItemDto,
  type ListItemSeriesDto,
  type ListsClient,
} from '@rallypoint/lists-client'
import { materializeOccurrences, occurrenceDueDate } from '@rallypoint/lists-shared'
import type { EventsClient } from '@rallypoint/events-client'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { PLANNER_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for the Planner Chores BFF (#546).
// A real planner session lives in a Miniflare D1 (planner-db); RPID is stubbed
// and the Lists SDK is an in-memory fake that emulates the relevant lists-api
// behaviors: chores-type item create keeps priority + dueDate (tasks-shaped),
// and a series create materializes occurrence items carrying a dueDate.
// Exercised:
// - GET /chores/list auto-provisions the single chores list (resolveChoresList).
// - Repeated GETs return the SAME list id (idempotence).
// - The chores list does NOT appear on the Tasks rail (GET /lists).
// - Items CRUD round-trips; chores items keep priority + dueDate.
// - Series create materializes occurrences with a dueDate.
// - IDOR + cross-type guards on the items / series paths.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

function isoNow(): string {
  return new Date().toISOString()
}

function makeFakeLists(): { client: ListsClient } {
  const groups: GroupDto[] = []
  const lists: ListDto[] = []
  const items: ListItemDto[] = []
  const series: ListItemSeriesDto[] = []

  function ownsGroup(actor: string, scopeId: string): boolean {
    return groups.some((g) => g.id === scopeId && g.createdBy === actor)
  }
  function listOf(listId: string): ListDto | undefined {
    return lists.find((l) => l.id === listId)
  }
  // Mirror lists-api: tasks + chores keep priority/dueDate; others null them.
  function keepsScheduling(listType: string): boolean {
    return listType === 'tasks' || listType === 'chores'
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
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      groups.push(g)
      return g
    },
    listLists: async (scope) =>
      lists.filter((l) => l.scopeType === scope.scopeType && l.scopeId === scope.scopeId),
    listItems: async (listId) => items.filter((i) => i.listId === listId),
    createList: async (input, actor) => {
      if (input.scopeType === 'list_group' && !ownsGroup(actor, input.scopeId)) {
        throw new ListsClientError(404, 'not_found', 'List group not found.')
      }
      const l: ListDto = {
        id: `lst_${lists.length + 1}`,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        listType: input.listType,
        name: input.name,
        visibility: input.visibility,
        color: input.color ?? null,
        incompleteCount: 0,
        createdBy: actor,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      lists.push(l)
      return l
    },
    createListItem: async (listId, input, actor) => {
      const list = listOf(listId)
      if (!list || (list.scopeType === 'list_group' && !ownsGroup(actor, list.scopeId))) {
        throw new ListsClientError(404, 'not_found', 'List not found.')
      }
      const sched = keepsScheduling(list.listType)
      const it: ListItemDto = {
        id: `lit_${items.length + 1}`,
        listId,
        title: input.title,
        notes: input.notes ?? null,
        assignedTo: input.assignedTo ?? null,
        completed: false,
        completedAt: null,
        status: null,
        priority: sched ? (input.priority ?? 'medium') : null,
        dueDate: sched ? (input.dueDate ?? null) : null,
        position: input.position ?? 0,
        customFields: input.customFields ?? {},
        seriesId: null,
        createdBy: actor,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      items.push(it)
      return it
    },
    updateListItem: async (listId, itemId, patch, _actor) => {
      const it = items.find((x) => x.id === itemId && x.listId === listId)
      if (!it) throw new ListsClientError(404, 'item_not_found', 'Item not found.')
      if (patch.completed !== undefined) it.completed = patch.completed
      if (patch.title !== undefined) it.title = patch.title
      if (patch.dueDate !== undefined) it.dueDate = patch.dueDate
      if (patch.priority !== undefined) it.priority = patch.priority
      if (patch.customFields !== undefined)
        it.customFields = { ...it.customFields, ...patch.customFields }
      return it
    },
    deleteListItem: async (listId, itemId, _actor) => {
      const idx = items.findIndex((x) => x.id === itemId && x.listId === listId)
      if (idx === -1) throw new ListsClientError(404, 'item_not_found', 'Item not found.')
      items.splice(idx, 1)
    },
    deleteList: async (listId, _actor) => {
      const idx = lists.findIndex((l) => l.id === listId)
      if (idx === -1) throw new ListsClientError(404, 'not_found', 'List not found.')
      lists.splice(idx, 1)
    },
    listFieldDefs: async () => [],
    createFieldDef: async () => { throw new Error('not stubbed') },
    updateFieldDef: async () => { throw new Error('not stubbed') },
    deleteFieldDef: async () => {},
    listSeries: async (listId) => series.filter((s) => s.listId === listId),
    createListItemSeries: async (listId, input, actor) => {
      const list = listOf(listId)
      if (!list) throw new ListsClientError(404, 'not_found', 'List not found.')
      const s: ListItemSeriesDto = {
        id: `lse_${series.length + 1}`,
        listId,
        title: input.title,
        notes: input.notes ?? null,
        assignedTo: input.assignedTo ?? null,
        priority: input.priority ?? null,
        freq: input.freq,
        interval: input.interval ?? 1,
        byDay: input.byDay ?? null,
        dtstart: input.dtstart,
        until: input.until ?? null,
        count: input.count ?? null,
        timeOfDay: input.timeOfDay ?? null,
        createdBy: actor,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      series.push(s)
      // Materialize occurrence items carrying a dueDate (emulates lists-api).
      const dates = materializeOccurrences(
        {
          freq: s.freq,
          interval: s.interval,
          ...(s.byDay != null ? { byDay: s.byDay } : {}),
          dtstart: s.dtstart,
          ...(s.until != null ? { until: s.until } : {}),
          ...(s.count != null ? { count: s.count } : {}),
        },
        { from: s.dtstart, limit: 10 },
      )
      for (const d of dates) {
        items.push({
          id: `lit_${items.length + 1}`,
          listId,
          title: s.title,
          notes: s.notes,
          assignedTo: s.assignedTo,
          completed: false,
          completedAt: null,
          status: null,
          priority: s.priority,
          // Mirror lists-api: stamp the series' wall-clock timeOfDay AS UTC (a
          // floating local due). occurrenceDueDate(d, null) → `${d}T00:00:00.000Z`.
          dueDate: occurrenceDueDate(d, s.timeOfDay),
          position: 0,
          customFields: {},
          seriesId: s.id,
          createdBy: actor,
          createdAt: isoNow(),
          updatedAt: isoNow(),
        })
      }
      return s
    },
    updateSeries: async (seriesId, patch, _actor) => {
      const s = series.find((x) => x.id === seriesId)
      if (!s) throw new ListsClientError(404, 'not_found', 'Series not found.')
      if (patch.title !== undefined) s.title = patch.title
      return s
    },
    deleteSeries: async (seriesId, _actor) => {
      const idx = series.findIndex((x) => x.id === seriesId)
      if (idx === -1) throw new ListsClientError(404, 'not_found', 'Series not found.')
      series.splice(idx, 1)
    },
  }

  return { client }
}

function makeFakeEvents(): { client: EventsClient } {
  const client = {
    listPersonalEvents: async () => [],
    listUserEvents: async () => [],
  } as unknown as EventsClient
  return { client }
}

describe('D1 integration — Planner Chores BFF', () => {
  let repos: Repos
  let env: Env
  let app: Hono<HonoApp>

  const baseServices = (): Services => ({
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    },
    rpidSso: { exchange: vi.fn().mockResolvedValue({ ok: false, reason: 'invalid' }) },
    listsClient: makeFakeLists().client,
    eventsClient: makeFakeEvents().client,
    settings: { get: async () => ({}), patch: async () => ({}) },
  })

  beforeAll(() => {
    repos = buildD1Repos(createDb(testEnv.DB))
    env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
  })

  beforeEach(() => {
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
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  }

  it('GET /chores/list auto-provisions and returns the single chores list', async () => {
    const bearer = await loginAs('user_chore_new')
    const res = await req(bearer, 'GET', '/api/v1/ui/chores/list')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(typeof body.id).toBe('string')
    expect(body.listType).toBe('chores')
  })

  it('GET /chores/list is idempotent — repeated calls return the same list id', async () => {
    const bearer = await loginAs('user_chore_idem')
    const id1 = ((await (await req(bearer, 'GET', '/api/v1/ui/chores/list')).json()) as Record<string, unknown>).id
    const id2 = ((await (await req(bearer, 'GET', '/api/v1/ui/chores/list')).json()) as Record<string, unknown>).id
    expect(id1).toBe(id2)
  })

  it('the chores list does NOT appear on the Tasks rail (GET /lists)', async () => {
    const bearer = await loginAs('user_chore_rail')
    await req(bearer, 'GET', '/api/v1/ui/chores/list')
    await req(bearer, 'GET', '/api/v1/ui/lists')
    const tasksRes = await req(bearer, 'GET', '/api/v1/ui/lists')
    const taskLists = (await tasksRes.json()) as Array<Record<string, unknown>>
    expect(taskLists.every((l) => l.listType !== 'chores')).toBe(true)
  })

  it('creates a chores item keeping priority + dueDate', async () => {
    const bearer = await loginAs('user_chore_item')
    const listId = ((await (await req(bearer, 'GET', '/api/v1/ui/chores/list')).json()) as Record<string, unknown>).id as string
    const itemRes = await req(bearer, 'POST', `/api/v1/ui/chores/${listId}/items`, {
      title: 'Take out trash',
      priority: 'high',
      dueDate: '2026-06-15T00:00:00.000Z',
    })
    expect(itemRes.status).toBe(201)
    const item = (await itemRes.json()) as Record<string, unknown>
    expect(item.priority).toBe('high')
    expect(item.dueDate).toBe('2026-06-15T00:00:00.000Z')
  })

  it('can check off and delete a chores item', async () => {
    const bearer = await loginAs('user_chore_toggle')
    const listId = ((await (await req(bearer, 'GET', '/api/v1/ui/chores/list')).json()) as Record<string, unknown>).id as string
    const itemId = ((await (await req(bearer, 'POST', `/api/v1/ui/chores/${listId}/items`, { title: 'Vacuum' })).json()) as Record<string, unknown>).id as string
    const patchRes = await req(bearer, 'PATCH', `/api/v1/ui/chores/${listId}/items/${itemId}`, { completed: true })
    expect(patchRes.status).toBe(200)
    expect(((await patchRes.json()) as Record<string, unknown>).completed).toBe(true)
    const delRes = await req(bearer, 'DELETE', `/api/v1/ui/chores/${listId}/items/${itemId}`)
    expect(delRes.status).toBe(204)
  })

  it('series create on the chores list materializes occurrences carrying a dueDate', async () => {
    const bearer = await loginAs('user_chore_series')
    const listId = ((await (await req(bearer, 'GET', '/api/v1/ui/chores/list')).json()) as Record<string, unknown>).id as string
    const seriesRes = await req(bearer, 'POST', `/api/v1/ui/chores/${listId}/series`, {
      title: 'Water plants',
      freq: 'weekly',
      interval: 1,
      byDay: ['MO'],
      dtstart: '2026-06-08',
    })
    expect(seriesRes.status).toBe(201)
    // tz=UTC: the floating-due resolver is the identity, so this asserts the
    // base materialization shape (tz-specific resolution is covered below).
    const itemsRes = await req(bearer, 'GET', `/api/v1/ui/chores/${listId}/items?tz=UTC`)
    const items = (await itemsRes.json()) as Array<Record<string, unknown>>
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((i) => i.seriesId !== null)).toBe(true)
    expect(items.every((i) => typeof i.dueDate === 'string')).toBe(true)
  })

  // The BFF is the SINGLE resolver of a recurring occurrence's floating local
  // wall-clock due: GET items reinterprets the UTC-stamped wall-clock in the
  // request tz. This prevents the client double-converting (the reported
  // "6:30 PM shows as 1:30 AM" bug). UTC is the identity.
  it('GET items resolves each occurrence floating due into the request tz', async () => {
    const bearer = await loginAs('user_chore_tz')
    const listId = ((await (await req(bearer, 'GET', '/api/v1/ui/chores/list')).json()) as Record<string, unknown>).id as string
    // A daily chore set for 18:30 wall-clock, starting on a fixed date.
    const seriesRes = await req(bearer, 'POST', `/api/v1/ui/chores/${listId}/series`, {
      title: 'Evening walk',
      freq: 'daily',
      interval: 1,
      dtstart: '2026-06-08',
      timeOfDay: '18:30',
    })
    expect(seriesRes.status).toBe(201)

    const getDues = async (tz: string): Promise<string[]> => {
      const res = await req(bearer, 'GET', `/api/v1/ui/chores/${listId}/items?tz=${encodeURIComponent(tz)}`)
      expect(res.status).toBe(200)
      const rows = (await res.json()) as Array<Record<string, unknown>>
      return rows.map((r) => r.dueDate as string)
    }

    // Under UTC the floating wall-clock is the identity: stays 18:30Z.
    const utcDues = await getDues('UTC')
    expect(utcDues.length).toBeGreaterThan(0)
    expect(utcDues.every((d) => d.endsWith('T18:30:00.000Z'))).toBe(true)

    // Under Pacific (UTC-7 in June) the same 18:30 wall-clock resolves to the
    // genuine instant 01:30Z the NEXT day — what the client then renders as 6:30 PM.
    const laDues = await getDues('America/Los_Angeles')
    expect(laDues.length).toBe(utcDues.length)
    expect(laDues.every((d) => d.endsWith('T01:30:00.000Z'))).toBe(true)
    // 2026-06-08 18:30 Pacific → 2026-06-09T01:30:00.000Z (date rolled forward).
    expect(laDues).toContain('2026-06-09T01:30:00.000Z')
  })

  it('lists, updates and deletes a chores series', async () => {
    const bearer = await loginAs('user_chore_series_crud')
    const listId = ((await (await req(bearer, 'GET', '/api/v1/ui/chores/list')).json()) as Record<string, unknown>).id as string
    const seriesId = ((await (await req(bearer, 'POST', `/api/v1/ui/chores/${listId}/series`, {
      title: 'Mop',
      freq: 'weekly',
      interval: 1,
      dtstart: '2026-06-08',
    })).json()) as Record<string, unknown>).id as string

    const listRes = await req(bearer, 'GET', `/api/v1/ui/chores/${listId}/series`)
    expect(((await listRes.json()) as unknown[]).length).toBe(1)

    const patchRes = await req(bearer, 'PATCH', `/api/v1/ui/chores/${listId}/series/${seriesId}`, { title: 'Mop floors' })
    expect(patchRes.status).toBe(200)
    expect(((await patchRes.json()) as Record<string, unknown>).title).toBe('Mop floors')

    const delRes = await req(bearer, 'DELETE', `/api/v1/ui/chores/${listId}/series/${seriesId}`)
    expect(delRes.status).toBe(204)
  })

  it('404s on item read for a list the actor does not own', async () => {
    const bearer = await loginAs('user_chore_idor')
    const res = await req(bearer, 'GET', '/api/v1/ui/chores/lst_foreign_nobody/items')
    expect(res.status).toBe(404)
  })

  it('404s when the chores items path targets the actor’s tasks list (cross-type guard)', async () => {
    const bearer = await loginAs('user_chore_typeguard')
    // Resolve the canonical tasks list (#543: GET provisions + returns it).
    const listsRes = await req(bearer, 'GET', '/api/v1/ui/lists')
    const tasksList = ((await listsRes.json()) as Array<Record<string, unknown>>)[0]
    expect(tasksList?.listType).toBe('tasks')
    const res = await req(bearer, 'GET', `/api/v1/ui/chores/${tasksList!.id}/items`)
    expect(res.status).toBe(404)
  })

  // --- feed toggle (showChoresInFeeds) ---------------------------------
  // Build a dedicated app whose Lists fake + settings are shared across the
  // provisioning call and the feed call, so we can flip the toggle per-test.
  function appWith(settings: { get: () => Promise<Record<string, unknown>> }): {
    app: Hono<HonoApp>
    listsClient: ListsClient
  } {
    const listsClient = makeFakeLists().client
    const services: Services = {
      idClient: {
        verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
        signoutRpidBearer: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      },
      rpidSso: { exchange: vi.fn().mockResolvedValue({ ok: false, reason: 'invalid' }) },
      listsClient,
      eventsClient: makeFakeEvents().client,
      settings: { get: settings.get, patch: async () => ({}) },
    }
    return { app: buildApp({ env, logger: undefined, repos, services }), listsClient }
  }

  async function reqOn(
    a: Hono<HonoApp>,
    bearer: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return a.request(`http://localhost${path}`, {
      method,
      headers: headers(bearer),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  }

  it('Upcoming INCLUDES chores items when showChoresInFeeds is on (default)', async () => {
    const { app: a } = appWith({ get: async () => ({}) })
    const bearer = await loginAs('user_chore_feed_on')
    const listId = ((await (await reqOn(a, bearer, 'GET', '/api/v1/ui/chores/list')).json()) as Record<string, unknown>).id as string
    await reqOn(a, bearer, 'POST', `/api/v1/ui/chores/${listId}/items`, {
      title: 'Clean gutters',
      dueDate: '2026-12-31T00:00:00.000Z',
    })
    const res = await reqOn(a, bearer, 'GET', '/api/v1/ui/upcoming?date=2026-06-08&tz=UTC')
    expect(res.status).toBe(200)
    const body = JSON.stringify(await res.json())
    expect(body).toContain('Clean gutters')
  })

  it('Upcoming EXCLUDES chores items when showChoresInFeeds is off', async () => {
    const { app: a } = appWith({ get: async () => ({ showChoresInFeeds: false }) })
    const bearer = await loginAs('user_chore_feed_off')
    const listId = ((await (await reqOn(a, bearer, 'GET', '/api/v1/ui/chores/list')).json()) as Record<string, unknown>).id as string
    await reqOn(a, bearer, 'POST', `/api/v1/ui/chores/${listId}/items`, {
      title: 'Clean gutters',
      dueDate: '2026-12-31T00:00:00.000Z',
    })
    const res = await reqOn(a, bearer, 'GET', '/api/v1/ui/upcoming?date=2026-06-08&tz=UTC')
    expect(res.status).toBe(200)
    const body = JSON.stringify(await res.json())
    expect(body).not.toContain('Clean gutters')
  })

  it('My Day INCLUDES chores items due today when the toggle is on', async () => {
    const { app: a } = appWith({ get: async () => ({}) })
    const bearer = await loginAs('user_chore_myday_on')
    const listId = ((await (await reqOn(a, bearer, 'GET', '/api/v1/ui/chores/list')).json()) as Record<string, unknown>).id as string
    await reqOn(a, bearer, 'POST', `/api/v1/ui/chores/${listId}/items`, {
      title: 'Feed cat',
      dueDate: '2026-06-08T09:00:00.000Z',
    })
    const res = await reqOn(a, bearer, 'GET', '/api/v1/ui/my-day?date=2026-06-08&tz=UTC')
    expect(res.status).toBe(200)
    const body = JSON.stringify(await res.json())
    expect(body).toContain('Feed cat')
  })

  it('My Day EXCLUDES chores items when the toggle is off', async () => {
    const { app: a } = appWith({ get: async () => ({ showChoresInFeeds: false }) })
    const bearer = await loginAs('user_chore_myday_off')
    const listId = ((await (await reqOn(a, bearer, 'GET', '/api/v1/ui/chores/list')).json()) as Record<string, unknown>).id as string
    await reqOn(a, bearer, 'POST', `/api/v1/ui/chores/${listId}/items`, {
      title: 'Feed cat',
      dueDate: '2026-06-08T09:00:00.000Z',
    })
    const res = await reqOn(a, bearer, 'GET', '/api/v1/ui/my-day?date=2026-06-08&tz=UTC')
    expect(res.status).toBe(200)
    const body = JSON.stringify(await res.json())
    expect(body).not.toContain('Feed cat')
  })
})
