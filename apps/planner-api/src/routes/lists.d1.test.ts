import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { env as testEnv } from 'cloudflare:test'
import type { Hono } from 'hono'
import {
  ListsClientError,
  type FieldDefDto,
  type GroupDto,
  type ListDto,
  type ListItemDto,
  type ListItemSeriesDto,
  type ListsClient,
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

// Integration tests for the Planner Task Lists BFF. A real planner session
// lives in a Miniflare D1 (planner-db); RPID is stubbed, and the
// Lists SDK is an in-memory fake injected at the services layer. The point
// is to exercise the BFF's planner-specific behaviour — scope injection
// (listType='tasks', the caller's personal list_group), the item-read IDOR
// guard, and SDK-error → envelope mapping — without standing up lists-api.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'
const PERSONAL_NAME = 'My Tasks'

// A mutable in-memory Lists SDK. Models the slices-6a contract the BFF
// relies on: createGroup auto-owns the actor; createList/createListItem
// require the actor to own the list's group (404 otherwise, mirroring
// lists-api's membership gate); listItems is UNGATED (the read surface
// trusts its caller) — which is exactly why the BFF must guard reads.
interface FakeLists {
  client: ListsClient
  calls: { method: string; actor?: string; args: unknown[] }[]
  seedForeignList(): string
  // A list_group-scoped list owned by another user's group. Unlike
  // seedForeignList (opaque `group` scope, trusted to the caller), this is
  // the shape a Planner personal list actually takes — so the Lists SDK
  // membership gate (loadListForActor) rejects writes from a non-member.
  seedForeignPersonalList(): string
  // Seed a notes list inside the given actor's personal group (provisioning the
  // group if it doesn't exist yet). Returns the notes list id.
  seedNotesListForActor(actor: string): string
}

function isoNow(): string {
  return new Date().toISOString()
}

function makeFakeLists(): FakeLists {
  const groups: GroupDto[] = []
  const lists: ListDto[] = []
  const items: ListItemDto[] = []
  const series: ListItemSeriesDto[] = []
  const fieldDefs: FieldDefDto[] = []
  const calls: { method: string; actor?: string; args: unknown[] }[] = []

  function ownsGroup(actor: string, scopeId: string): boolean {
    return groups.some((g) => g.id === scopeId && g.createdBy === actor)
  }
  function listOf(listId: string): ListDto | undefined {
    return lists.find((l) => l.id === listId)
  }

  const client: ListsClient = {
    health: async () => ({ status: 'ok' }),
    // UNGATED on purpose — matches sdk-lists.ts (caller authorizes scope),
    // which is exactly why the BFF must guard field reads.
    listFieldDefs: async (listId) => {
      calls.push({ method: 'listFieldDefs', args: [listId] })
      return fieldDefs.filter((d) => d.listId === listId)
    },
    createFieldDef: async (listId, input, actor) => {
      calls.push({ method: 'createFieldDef', actor, args: [listId, input] })
      const list = listOf(listId)
      if (!list || (list.scopeType === 'list_group' && !ownsGroup(actor, list.scopeId))) {
        throw new ListsClientError(404, 'not_found', 'List not found.')
      }
      const d: FieldDefDto = {
        id: `lfd_${fieldDefs.length + 1}`,
        listId,
        key: input.label.toLowerCase().replace(/\s+/g, '_'),
        label: input.label,
        fieldType: input.fieldType,
        options: {
          ...(input.multiline !== undefined ? { multiline: input.multiline } : {}),
          ...(input.choices
            ? { choices: input.choices.map((c, i) => ({ id: `opt_${i + 1}`, label: c.label })) }
            : {}),
        },
        required: input.required ?? false,
        defaultValue: null,
        position: input.position ?? fieldDefs.length,
        createdBy: actor,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      fieldDefs.push(d)
      return d
    },
    updateFieldDef: async (listId, fieldId, patch, actor) => {
      calls.push({ method: 'updateFieldDef', actor, args: [listId, fieldId, patch] })
      // Mirror the real SDK: loadListForActor runs the membership gate before
      // the def lookup, so a non-member 404s without learning the def exists.
      const list = listOf(listId)
      if (!list || (list.scopeType === 'list_group' && !ownsGroup(actor, list.scopeId))) {
        throw new ListsClientError(404, 'not_found', 'List not found.')
      }
      const d = fieldDefs.find((x) => x.id === fieldId && x.listId === listId)
      if (!d) throw new ListsClientError(404, 'field_def_not_found', 'Field not found.')
      if (patch.label !== undefined) d.label = patch.label
      if (patch.required !== undefined) d.required = patch.required
      return d
    },
    deleteFieldDef: async (listId, fieldId, actor) => {
      calls.push({ method: 'deleteFieldDef', actor, args: [listId, fieldId] })
      const list = listOf(listId)
      if (!list || (list.scopeType === 'list_group' && !ownsGroup(actor, list.scopeId))) {
        throw new ListsClientError(404, 'not_found', 'List not found.')
      }
      const idx = fieldDefs.findIndex((x) => x.id === fieldId && x.listId === listId)
      if (idx === -1) throw new ListsClientError(404, 'field_def_not_found', 'Field not found.')
      fieldDefs.splice(idx, 1)
    },
    listSeries: async (listId) => {
      calls.push({ method: 'listSeries', args: [listId] })
      return series.filter((s) => s.listId === listId)
    },
    createListItemSeries: async (listId, input, actor) => {
      calls.push({ method: 'createListItemSeries', actor, args: [listId, input] })
      const list = listOf(listId)
      if (!list || (list.scopeType === 'list_group' && !ownsGroup(actor, list.scopeId))) {
        throw new ListsClientError(404, 'not_found', 'List not found.')
      }
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
      // Mirror lists-api: materialize two occurrence items carrying seriesId.
      for (let n = 0; n < 2; n++) {
        items.push({
          id: `lit_${items.length + 1}`,
          listId,
          title: input.title,
          notes: null,
          assignedTo: null,
          completed: false,
          completedAt: null,
          status: 'todo',
          priority: input.priority ?? 'medium',
          dueDate: input.dtstart,
          position: items.length,
          customFields: {},
          seriesId: s.id,
          createdBy: actor,
          createdAt: isoNow(),
          updatedAt: isoNow(),
        })
      }
      return s
    },
    updateSeries: async (seriesId, patch, actor) => {
      calls.push({ method: 'updateSeries', actor, args: [seriesId, patch] })
      const s = series.find((x) => x.id === seriesId)
      if (!s) throw new ListsClientError(404, 'not_found', 'Series not found.')
      if (patch.title !== undefined) s.title = patch.title
      if (patch.notes !== undefined) s.notes = patch.notes
      if (patch.priority !== undefined) s.priority = patch.priority ?? null
      if (patch.freq !== undefined) s.freq = patch.freq
      if (patch.interval !== undefined) s.interval = patch.interval
      if (patch.byDay !== undefined) s.byDay = patch.byDay ?? null
      if (patch.dtstart !== undefined) s.dtstart = patch.dtstart
      if (patch.until !== undefined) s.until = patch.until ?? null
      if (patch.count !== undefined) s.count = patch.count ?? null
      if (patch.timeOfDay !== undefined) s.timeOfDay = patch.timeOfDay ?? null
      s.updatedAt = isoNow()
      return s
    },
    deleteSeries: async (seriesId, actor) => {
      calls.push({ method: 'deleteSeries', actor, args: [seriesId] })
      const idx = series.findIndex((s) => s.id === seriesId)
      if (idx === -1) throw new ListsClientError(404, 'not_found', 'Series not found.')
      series.splice(idx, 1)
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].seriesId === seriesId) items.splice(i, 1)
      }
    },
    listGroups: async (actor) => {
      calls.push({ method: 'listGroups', actor, args: [] })
      return groups.filter((g) => g.createdBy === actor)
    },
    createGroup: async (input, actor) => {
      calls.push({ method: 'createGroup', actor, args: [input] })
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
    listLists: async (scope) => {
      calls.push({ method: 'listLists', args: [scope] })
      return lists.filter(
        (l) => l.scopeType === scope.scopeType && l.scopeId === scope.scopeId,
      )
    },
    listItems: async (listId) => {
      // UNGATED on purpose — matches sdk-lists.ts (caller authorizes scope).
      calls.push({ method: 'listItems', args: [listId] })
      return items.filter((i) => i.listId === listId)
    },
    createList: async (input, actor) => {
      calls.push({ method: 'createList', actor, args: [input] })
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
      calls.push({ method: 'createListItem', actor, args: [listId, input] })
      const list = listOf(listId)
      if (!list || (list.scopeType === 'list_group' && !ownsGroup(actor, list.scopeId))) {
        throw new ListsClientError(404, 'not_found', 'List not found.')
      }
      const isTasks = list.listType === 'tasks'
      const it: ListItemDto = {
        id: `lit_${items.length + 1}`,
        listId,
        title: input.title,
        notes: input.notes ?? null,
        assignedTo: input.assignedTo ?? null,
        completed: false,
        completedAt: null,
        status: isTasks ? (input.status ?? 'todo') : null,
        // Mirror lists-api post-#430: explicit null = no-priority (null stored);
        // omitted (undefined) = default medium; else use the value. ?? coerces
        // null→'medium', so use a conditional to distinguish null from undefined.
        priority: isTasks ? (input.priority === undefined ? 'medium' : input.priority) : null,
        dueDate: input.dueDate ?? null,
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
    updateListItem: async (listId, itemId, patch, actor) => {
      calls.push({ method: 'updateListItem', actor, args: [listId, itemId, patch] })
      const it = items.find((x) => x.id === itemId && x.listId === listId)
      if (!it) throw new ListsClientError(404, 'item_not_found', 'Item not found.')
      if (patch.completed !== undefined) it.completed = patch.completed
      if (patch.title !== undefined) it.title = patch.title
      if (patch.status !== undefined) it.status = patch.status
      return it
    },
    deleteListItem: async (listId, itemId, actor) => {
      calls.push({ method: 'deleteListItem', actor, args: [listId, itemId] })
      const idx = items.findIndex((x) => x.id === itemId && x.listId === listId)
      if (idx === -1) throw new ListsClientError(404, 'item_not_found', 'Item not found.')
      items.splice(idx, 1)
    },
    deleteList: async (listId, actor) => {
      calls.push({ method: 'deleteList', actor, args: [listId] })
      const idx = lists.findIndex((l) => l.id === listId)
      if (idx === -1) throw new ListsClientError(404, 'not_found', 'List not found.')
      lists.splice(idx, 1)
    },
  }

  return {
    client,
    calls,
    // Seed a non-personal list nobody on the planner side owns, to drive
    // the item-read IDOR guard.
    seedForeignList() {
      const l: ListDto = {
        id: 'lst_foreign',
        scopeType: 'group',
        scopeId: 'grp_someone_else',
        listType: 'tasks',
        name: 'Foreign',
        visibility: 'all',
        color: null,
        incompleteCount: 0,
        createdBy: 'user_someone_else',
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      lists.push(l)
      items.push({
        id: 'lit_foreign',
        listId: 'lst_foreign',
        title: 'secret',
        notes: null,
        assignedTo: null,
        completed: false,
        completedAt: null,
        status: 'todo',
        priority: 'medium',
        dueDate: null,
        position: 0,
        customFields: {},
        seriesId: null,
        createdBy: 'user_someone_else',
        createdAt: isoNow(),
        updatedAt: isoNow(),
      })
      return l.id
    },
    seedForeignPersonalList() {
      groups.push({
        id: 'grp_foreign_personal',
        name: 'My Tasks',
        description: null,
        createdBy: 'user_someone_else',
        createdAt: isoNow(),
        updatedAt: isoNow(),
      })
      const l: ListDto = {
        id: 'lst_foreign_personal',
        scopeType: 'list_group',
        scopeId: 'grp_foreign_personal',
        listType: 'tasks',
        name: 'Foreign personal',
        visibility: 'all',
        color: null,
        incompleteCount: 0,
        createdBy: 'user_someone_else',
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      lists.push(l)
      fieldDefs.push({
        id: 'lfd_1',
        listId: l.id,
        key: 'secret',
        label: 'Secret',
        fieldType: 'text',
        options: {},
        required: false,
        defaultValue: null,
        position: 0,
        createdBy: 'user_someone_else',
        createdAt: isoNow(),
        updatedAt: isoNow(),
      })
      return l.id
    },
    seedNotesListForActor(actor: string): string {
      // Find or create the actor's personal group.
      let group = groups.find((g) => g.createdBy === actor && g.name === 'My Tasks')
      if (!group) {
        group = {
          id: `lgr_notes_${actor}`,
          name: 'My Tasks',
          description: null,
          createdBy: actor,
          createdAt: isoNow(),
          updatedAt: isoNow(),
        }
        groups.push(group)
      }
      const l: ListDto = {
        id: `lst_notes_${actor}`,
        scopeType: 'list_group',
        scopeId: group.id,
        listType: 'notes',
        name: 'Notes',
        visibility: 'all',
        color: null,
        incompleteCount: 0,
        createdBy: actor,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      lists.push(l)
      return l.id
    },
  }
}

describe('D1 integration — Planner Task Lists BFF', () => {
  let repos: Repos
  let env: Env
  let app: Hono<HonoApp>
  let fake: FakeLists

  const baseServices = (listsClient: ListsClient): Services => ({
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    },
    rpidSso: {
      exchange: vi.fn().mockResolvedValue({ ok: false, reason: 'invalid' }),
    },
    listsClient,
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
    fake = makeFakeLists()
    app = buildApp({ env, logger: undefined, repos, services: baseServices(fake.client) })
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

  it('requires a session for every list route', async () => {
    const res = await app.request('http://localhost/api/v1/ui/lists', {
      headers: { cookie: `${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`, 'x-rp-csrf': CSRF },
    })
    expect(res.status).toBe(401)
  })

  it('GET /lists returns [] before the personal group is provisioned', async () => {
    const bearer = await loginAs('user_a')
    const res = await app.request('http://localhost/api/v1/ui/lists', { headers: headers(bearer) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    expect(fake.calls.some((c) => c.method === 'createGroup')).toBe(false)
  })

  it('POST /lists provisions the personal group and injects scope + type', async () => {
    const bearer = await loginAs('user_b')
    const res = await app.request('http://localhost/api/v1/ui/lists', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'Errands', color: 'blue' }),
    })
    expect(res.status).toBe(201)
    const created = (await res.json()) as ListDto
    expect(created.listType).toBe('tasks')
    expect(created.scopeType).toBe('list_group')
    expect(created.visibility).toBe('all')
    expect(created.color).toBe('blue')

    const createGroup = fake.calls.find((c) => c.method === 'createGroup')
    expect(createGroup?.actor).toBe('user_b')
    expect((createGroup?.args[0] as { name: string }).name).toBe(PERSONAL_NAME)
    const createList = fake.calls.find((c) => c.method === 'createList')
    expect(createList?.actor).toBe('user_b')
  })

  it('reuses the existing personal group on a second create', async () => {
    const bearer = await loginAs('user_c')
    const post = () =>
      app.request('http://localhost/api/v1/ui/lists', {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ name: 'List' }),
      })
    await post()
    await post()
    expect(fake.calls.filter((c) => c.method === 'createGroup')).toHaveLength(1)
    expect(fake.calls.filter((c) => c.method === 'createList')).toHaveLength(2)
  })

  it('GET /lists then returns the created lists', async () => {
    const bearer = await loginAs('user_d')
    await app.request('http://localhost/api/v1/ui/lists', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'Today' }),
    })
    const res = await app.request('http://localhost/api/v1/ui/lists', { headers: headers(bearer) })
    const rows = (await res.json()) as ListDto[]
    expect(rows.map((l) => l.name)).toEqual(['Today'])
  })

  it('item create → check-off → delete round-trips with the session actor', async () => {
    const bearer = await loginAs('user_e')
    const listRes = await app.request('http://localhost/api/v1/ui/lists', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'Chores' }),
    })
    const listId = ((await listRes.json()) as ListDto).id

    const createRes = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/items`,
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Take out trash' }),
      },
    )
    expect(createRes.status).toBe(201)
    const item = (await createRes.json()) as ListItemDto
    expect(item.status).toBe('todo')
    expect(fake.calls.find((c) => c.method === 'createListItem')?.actor).toBe('user_e')

    const patchRes = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/items/${item.id}`,
      {
        method: 'PATCH',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ completed: true }),
      },
    )
    expect(patchRes.status).toBe(200)
    expect(((await patchRes.json()) as ListItemDto).completed).toBe(true)

    const delRes = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/items/${item.id}`,
      { method: 'DELETE', headers: headers(bearer) },
    )
    expect(delRes.status).toBe(204)

    const listItems = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/items`,
      { headers: headers(bearer) },
    )
    expect((await listItems.json()) as ListItemDto[]).toEqual([])
  })

  it('GET items 404s for a list the caller does not own (IDOR guard)', async () => {
    const bearer = await loginAs('user_f')
    const foreignId = fake.seedForeignList()
    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${foreignId}/items`,
      { headers: headers(bearer) },
    )
    expect(res.status).toBe(404)
    // The ungated SDK read must never have been reached.
    expect(fake.calls.some((c) => c.method === 'listItems')).toBe(false)
  })

  it('rejects an empty list name at the BFF boundary (400)', async () => {
    const bearer = await loginAs('user_h')
    const res = await app.request('http://localhost/api/v1/ui/lists', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name: '   ' }),
    })
    expect(res.status).toBe(400)
    // The bad request never reaches the SDK.
    expect(fake.calls.some((c) => c.method === 'createList')).toBe(false)
  })

  it('rejects a malformed item body at the BFF boundary (400)', async () => {
    const bearer = await loginAs('user_i')
    const listRes = await app.request('http://localhost/api/v1/ui/lists', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'L' }),
    })
    const listId = ((await listRes.json()) as ListDto).id
    const res = await app.request(`http://localhost/api/v1/ui/lists/${listId}/items`, {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ notes: 'no title' }),
    })
    expect(res.status).toBe(400)
    expect(fake.calls.some((c) => c.method === 'createListItem')).toBe(false)
  })

  it('maps an SDK ListsClientError to the same status envelope', async () => {
    const bearer = await loginAs('user_g')
    // No personal group → ownership check passes only for owned lists; a
    // write to an unknown list id surfaces the SDK 404 verbatim.
    const res = await app.request(
      'http://localhost/api/v1/ui/lists/lst_does_not_exist/items',
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'x' }),
      },
    )
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found')
  })

  // --- recurring series (slice 12) ---------------------------------

  async function createList(bearer: string, name: string): Promise<string> {
    const res = await app.request('http://localhost/api/v1/ui/lists', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name }),
    })
    return ((await res.json()) as ListDto).id
  }

  it('POST /series creates a series; occurrences surface with seriesId', async () => {
    const bearer = await loginAs('user_s1')
    const listId = await createList(bearer, 'Habits')

    const res = await app.request(`http://localhost/api/v1/ui/lists/${listId}/series`, {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        title: 'Stretch',
        freq: 'weekly',
        interval: 1,
        byDay: ['MO', 'WE'],
        dtstart: '2026-06-08',
        count: 4,
      }),
    })
    expect(res.status).toBe(201)
    const created = (await res.json()) as ListItemSeriesDto
    expect(created.title).toBe('Stretch')
    expect(created.byDay).toEqual(['MO', 'WE'])
    expect(fake.calls.find((c) => c.method === 'createListItemSeries')?.actor).toBe('user_s1')

    const itemsRes = await app.request(`http://localhost/api/v1/ui/lists/${listId}/items`, {
      headers: headers(bearer),
    })
    const rows = (await itemsRes.json()) as ListItemDto[]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.seriesId === created.id)).toBe(true)
  })

  it('POST /series 404s for a list the caller does not own (IDOR guard)', async () => {
    const bearer = await loginAs('user_s2')
    const foreignId = fake.seedForeignList()
    const res = await app.request(`http://localhost/api/v1/ui/lists/${foreignId}/series`, {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ title: 'x', freq: 'daily', interval: 1, dtstart: '2026-06-08', count: 3 }),
    })
    expect(res.status).toBe(404)
    expect(fake.calls.some((c) => c.method === 'createListItemSeries')).toBe(false)
  })

  it('GET /series 404s for a list the caller does not own (IDOR guard)', async () => {
    const bearer = await loginAs('user_s6')
    const foreignId = fake.seedForeignList()
    const res = await app.request(`http://localhost/api/v1/ui/lists/${foreignId}/series`, {
      headers: headers(bearer),
    })
    expect(res.status).toBe(404)
    expect(fake.calls.some((c) => c.method === 'listSeries')).toBe(false)
  })

  it('DELETE /series 404s for a list the caller does not own (IDOR guard)', async () => {
    const bearer = await loginAs('user_s7')
    const foreignId = fake.seedForeignList()
    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${foreignId}/series/lse_1`,
      { method: 'DELETE', headers: headers(bearer) },
    )
    expect(res.status).toBe(404)
    expect(fake.calls.some((c) => c.method === 'deleteSeries')).toBe(false)
  })

  it('POST /series rejects a malformed rule at the BFF boundary (400)', async () => {
    const bearer = await loginAs('user_s3')
    const listId = await createList(bearer, 'Bad')
    // byDay on a daily rule violates the cross-field rule.
    const res = await app.request(`http://localhost/api/v1/ui/lists/${listId}/series`, {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        title: 'x',
        freq: 'daily',
        interval: 1,
        byDay: ['MO'],
        dtstart: '2026-06-08',
        count: 3,
      }),
    })
    expect(res.status).toBe(400)
    expect(fake.calls.some((c) => c.method === 'createListItemSeries')).toBe(false)
  })

  it('GET then DELETE /series round-trips and removes its occurrences', async () => {
    const bearer = await loginAs('user_s4')
    const listId = await createList(bearer, 'Routine')
    const created = (await (
      await app.request(`http://localhost/api/v1/ui/lists/${listId}/series`, {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Walk', freq: 'daily', interval: 1, dtstart: '2026-06-08', count: 3 }),
      })
    ).json()) as ListItemSeriesDto

    const listRes = await app.request(`http://localhost/api/v1/ui/lists/${listId}/series`, {
      headers: headers(bearer),
    })
    expect(((await listRes.json()) as ListItemSeriesDto[]).map((s) => s.id)).toEqual([created.id])

    const delRes = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/series/${created.id}`,
      { method: 'DELETE', headers: headers(bearer) },
    )
    expect(delRes.status).toBe(204)

    const itemsRes = await app.request(`http://localhost/api/v1/ui/lists/${listId}/items`, {
      headers: headers(bearer),
    })
    expect((await itemsRes.json()) as ListItemDto[]).toEqual([])
  })

  it('DELETE /series 404s when the series is not in the caller-owned list', async () => {
    const bearer = await loginAs('user_s5')
    const listId = await createList(bearer, 'Mine')
    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/series/lse_does_not_exist`,
      { method: 'DELETE', headers: headers(bearer) },
    )
    expect(res.status).toBe(404)
    expect(fake.calls.some((c) => c.method === 'deleteSeries')).toBe(false)
  })

  // --- custom field defs (slice 13) --------------------------------

  it('POST /fields creates a def; GET then PATCH then DELETE round-trips', async () => {
    const bearer = await loginAs('user_fd1')
    const listId = await createList(bearer, 'Project')

    const createRes = await app.request(`http://localhost/api/v1/ui/lists/${listId}/fields`, {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ label: 'Stage', fieldType: 'single_select', choices: [{ label: 'Todo' }] }),
    })
    expect(createRes.status).toBe(201)
    const def = (await createRes.json()) as FieldDefDto
    expect(def.label).toBe('Stage')
    expect(fake.calls.find((c) => c.method === 'createFieldDef')?.actor).toBe('user_fd1')

    const getRes = await app.request(`http://localhost/api/v1/ui/lists/${listId}/fields`, {
      headers: headers(bearer),
    })
    expect(((await getRes.json()) as FieldDefDto[]).map((d) => d.id)).toEqual([def.id])

    const patchRes = await app.request(`http://localhost/api/v1/ui/lists/${listId}/fields/${def.id}`, {
      method: 'PATCH',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ label: 'Status', required: true }),
    })
    expect(patchRes.status).toBe(200)
    expect(await patchRes.json()).toMatchObject({ label: 'Status', required: true })

    const delRes = await app.request(`http://localhost/api/v1/ui/lists/${listId}/fields/${def.id}`, {
      method: 'DELETE',
      headers: headers(bearer),
    })
    expect(delRes.status).toBe(204)
    const after = await app.request(`http://localhost/api/v1/ui/lists/${listId}/fields`, {
      headers: headers(bearer),
    })
    expect((await after.json()) as FieldDefDto[]).toEqual([])
  })

  it('GET /fields 404s for a list the caller does not own (IDOR guard)', async () => {
    const bearer = await loginAs('user_fd2')
    const foreignId = fake.seedForeignList()
    const res = await app.request(`http://localhost/api/v1/ui/lists/${foreignId}/fields`, {
      headers: headers(bearer),
    })
    expect(res.status).toBe(404)
    // The ungated SDK read must never have been reached.
    expect(fake.calls.some((c) => c.method === 'listFieldDefs')).toBe(false)
  })

  it('POST /fields rejects a malformed def at the BFF boundary (400)', async () => {
    const bearer = await loginAs('user_fd3')
    const listId = await createList(bearer, 'Bad fields')
    // choices on a non-select type violates the create cross-field rule.
    const res = await app.request(`http://localhost/api/v1/ui/lists/${listId}/fields`, {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ label: 'Nope', fieldType: 'text', choices: [{ label: 'x' }] }),
    })
    expect(res.status).toBe(400)
    expect(fake.calls.some((c) => c.method === 'createFieldDef')).toBe(false)
  })

  it('POST /fields 404s for a personal list the caller does not own (IDOR guard)', async () => {
    const bearer = await loginAs('user_fd4')
    const foreignId = fake.seedForeignPersonalList()
    const res = await app.request(`http://localhost/api/v1/ui/lists/${foreignId}/fields`, {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ label: 'Stage', fieldType: 'text' }),
    })
    expect(res.status).toBe(404)
    // The downstream SDK membership gate (list_group ownership) rejects it.
    expect(fake.calls.some((c) => c.method === 'createFieldDef' && c.actor === 'user_fd4')).toBe(true)
  })

  it('PATCH /fields/:id 404s for a personal list the caller does not own (IDOR guard)', async () => {
    const bearer = await loginAs('user_fd5')
    const foreignId = fake.seedForeignPersonalList()
    const res = await app.request(`http://localhost/api/v1/ui/lists/${foreignId}/fields/lfd_1`, {
      method: 'PATCH',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ label: 'Hijacked' }),
    })
    expect(res.status).toBe(404)
    expect(fake.calls.some((c) => c.method === 'updateFieldDef' && c.actor === 'user_fd5')).toBe(true)
  })

  it('DELETE /fields/:id 404s for a personal list the caller does not own (IDOR guard)', async () => {
    const bearer = await loginAs('user_fd6')
    const foreignId = fake.seedForeignPersonalList()
    const res = await app.request(`http://localhost/api/v1/ui/lists/${foreignId}/fields/lfd_1`, {
      method: 'DELETE',
      headers: headers(bearer),
    })
    expect(res.status).toBe(404)
    expect(fake.calls.some((c) => c.method === 'deleteFieldDef' && c.actor === 'user_fd6')).toBe(true)
  })

  // --- PATCH series (slice 12b) --------------------------------

  it('PATCH /series updates a field and returns the updated DTO', async () => {
    const bearer = await loginAs('user_ps1')
    const listId = await createList(bearer, 'Habits')

    // Create a series first
    const created = (await (
      await app.request(`http://localhost/api/v1/ui/lists/${listId}/series`, {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Walk', freq: 'daily', interval: 1, dtstart: '2026-06-08', count: 10 }),
      })
    ).json()) as ListItemSeriesDto

    const patchRes = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/series/${created.id}`,
      {
        method: 'PATCH',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ interval: 2, title: 'Long Walk' }),
      },
    )
    expect(patchRes.status).toBe(200)
    const updated = (await patchRes.json()) as ListItemSeriesDto
    expect(updated.interval).toBe(2)
    expect(updated.title).toBe('Long Walk')
    // The actor should be forwarded downstream
    expect(fake.calls.find((c) => c.method === 'updateSeries')?.actor).toBe('user_ps1')
  })

  it('PATCH /series: a follow-up GET reflects the updated field', async () => {
    const bearer = await loginAs('user_ps2')
    const listId = await createList(bearer, 'Routines')

    const created = (await (
      await app.request(`http://localhost/api/v1/ui/lists/${listId}/series`, {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Run', freq: 'weekly', interval: 1, byDay: ['MO'], dtstart: '2026-06-09', count: 4 }),
      })
    ).json()) as ListItemSeriesDto

    await app.request(`http://localhost/api/v1/ui/lists/${listId}/series/${created.id}`, {
      method: 'PATCH',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ title: 'Morning Run' }),
    })

    const getRes = await app.request(`http://localhost/api/v1/ui/lists/${listId}/series`, {
      headers: headers(bearer),
    })
    const rows = (await getRes.json()) as ListItemSeriesDto[]
    expect(rows.find((s) => s.id === created.id)?.title).toBe('Morning Run')
  })

  it('PATCH /series 404s when the actor does not own the list (IDOR guard)', async () => {
    const bearer = await loginAs('user_ps3')
    const foreignId = fake.seedForeignList()
    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${foreignId}/series/lse_1`,
      {
        method: 'PATCH',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Hijacked' }),
      },
    )
    expect(res.status).toBe(404)
    expect(fake.calls.some((c) => c.method === 'updateSeries')).toBe(false)
  })

  it('PATCH /series 404s when the seriesId is not in the caller-owned list (IDOR guard)', async () => {
    const bearer = await loginAs('user_ps4')
    const listId = await createList(bearer, 'Mine')
    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/series/lse_does_not_exist`,
      {
        method: 'PATCH',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Fake' }),
      },
    )
    expect(res.status).toBe(404)
    expect(fake.calls.some((c) => c.method === 'updateSeries')).toBe(false)
  })

  it('PATCH /series 400s on an empty patch (UpdateSeriesSchema requires at least one field)', async () => {
    const bearer = await loginAs('user_ps5')
    const listId = await createList(bearer, 'Empty Patch')
    const created = (await (
      await app.request(`http://localhost/api/v1/ui/lists/${listId}/series`, {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Stretch', freq: 'daily', interval: 1, dtstart: '2026-06-08', count: 3 }),
      })
    ).json()) as ListItemSeriesDto

    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/series/${created.id}`,
      {
        method: 'PATCH',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({}),
      },
    )
    expect(res.status).toBe(400)
    expect(fake.calls.some((c) => c.method === 'updateSeries')).toBe(false)
  })

  it('PATCH /series 400s on an invalid freq value', async () => {
    const bearer = await loginAs('user_ps6')
    const listId = await createList(bearer, 'Bad Freq')
    const created = (await (
      await app.request(`http://localhost/api/v1/ui/lists/${listId}/series`, {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Yoga', freq: 'daily', interval: 1, dtstart: '2026-06-08', count: 3 }),
      })
    ).json()) as ListItemSeriesDto

    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/series/${created.id}`,
      {
        method: 'PATCH',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ freq: 'monthly' }),
      },
    )
    expect(res.status).toBe(400)
    expect(fake.calls.some((c) => c.method === 'updateSeries')).toBe(false)
  })

  // --- DELETE /lists/:listId (list delete) --------------------------------

  it('DELETE /lists/:listId removes the list and it is gone from a subsequent GET', async () => {
    const bearer = await loginAs('user_dl1')
    const listId = await createList(bearer, 'Errands')

    const delRes = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}`,
      { method: 'DELETE', headers: headers(bearer) },
    )
    expect(delRes.status).toBe(204)
    expect(fake.calls.some((c) => c.method === 'deleteList')).toBe(true)

    // Subsequent GET should not include the deleted list.
    const getRes = await app.request('http://localhost/api/v1/ui/lists', { headers: headers(bearer) })
    expect(getRes.status).toBe(200)
    const rows = (await getRes.json()) as ListDto[]
    expect(rows.some((l) => l.id === listId)).toBe(false)
  })

  it('DELETE /lists/:listId returns 409 for the notes list (not deletable)', async () => {
    const bearer = await loginAs('user_dl2')
    const notesId = fake.seedNotesListForActor('user_dl2')

    const delRes = await app.request(
      `http://localhost/api/v1/ui/lists/${notesId}`,
      { method: 'DELETE', headers: headers(bearer) },
    )
    expect(delRes.status).toBe(409)
    const body = (await delRes.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('list_not_deletable')
    // The SDK deleteList must not have been called.
    expect(fake.calls.some((c) => c.method === 'deleteList')).toBe(false)
  })

  it('DELETE /lists/:listId returns 404 when the listId is not owned by the actor', async () => {
    const bearer = await loginAs('user_dl3')
    // Seed a foreign list_group list the actor does not own.
    const foreignId = fake.seedForeignPersonalList()

    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${foreignId}`,
      { method: 'DELETE', headers: headers(bearer) },
    )
    expect(res.status).toBe(404)
    expect(fake.calls.some((c) => c.method === 'deleteList')).toBe(false)
  })

  // --- RPL↔RPP separation (#531): no shared lists in Planner ----------

  it('GET /lists/:listId/items 404s for a non-personal list (IDOR guard)', async () => {
    const bearer = await loginAs('user_sl3')
    // A foreign list — never reachable now that flagged shared lists are gone.
    const foreignId = fake.seedForeignList()

    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${foreignId}/items`,
      { headers: headers(bearer) },
    )
    expect(res.status).toBe(404)
    // The ungated SDK read must never have been reached.
    expect(fake.calls.some((c) => c.method === 'listItems')).toBe(false)
  })

  it('PUT /lists/:listId/planner-pref no longer exists (404)', async () => {
    const bearer = await loginAs('user_sl4')

    const res = await app.request(
      'http://localhost/api/v1/ui/lists/lst_any/planner-pref',
      {
        method: 'PUT',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ show: false }),
      },
    )
    expect(res.status).toBe(404)
  })

  // --- quick-add path: dueDate + priority forwarding (#430) ----------
  // These tests exercise the quick-add use case — POST /items with
  // dueDate and priority, matching the shape the widened createTaskItem
  // client helper sends after the #430 change.

  it('POST /items with dueDate + priority persists both fields', async () => {
    const bearer = await loginAs('user_qa1')
    const listId = await createList(bearer, 'Quick Add Test')

    // Local-midnight instant for 2026-06-15 (simulates dateInputToInstant output).
    // We send a fixed UTC instant here since the BFF is tz-agnostic — it stores
    // whatever ISO string it receives. The conversion is tested on the client side.
    const dueDateInstant = new Date(2026, 5, 15).toISOString()
    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/items`,
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Buy groceries', dueDate: dueDateInstant, priority: 'high' }),
      },
    )
    expect(res.status).toBe(201)
    const item = (await res.json()) as ListItemDto
    expect(item.title).toBe('Buy groceries')
    expect(item.dueDate).toBe(dueDateInstant)
    expect(item.priority).toBe('high')

    // Confirm the SDK received exactly the values the BFF forwarded.
    const sdkCall = fake.calls.find((c) => c.method === 'createListItem')
    expect(sdkCall?.actor).toBe('user_qa1')
    const sdkInput = sdkCall?.args[1] as { dueDate?: string; priority?: string } | undefined
    expect(sdkInput?.dueDate).toBe(dueDateInstant)
    expect(sdkInput?.priority).toBe('high')
  })

  it('POST /items without dueDate or priority preserves server defaults (priority=medium, dueDate=null)', async () => {
    const bearer = await loginAs('user_qa2')
    const listId = await createList(bearer, 'Title Only List')

    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/items`,
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Just a title' }),
      },
    )
    expect(res.status).toBe(201)
    const item = (await res.json()) as ListItemDto
    expect(item.title).toBe('Just a title')
    // The fake SDK's createListItem defaults priority to 'medium' and dueDate to null
    // when omitted — matching lists-api behaviour.
    expect(item.priority).toBe('medium')
    expect(item.dueDate).toBeNull()
  })

  // --- asymmetric quick-add cases: null priority + isolated dueDate (#430 P3) ----

  it('POST /items with priority:null creates a no-priority task (null stored)', async () => {
    // Lock: quick-add sends explicit priority:null; the BFF must pass it through
    // to the SDK without coercing to 'medium'. This is the P2 fix in #430.
    const bearer = await loginAs('user_qa3')
    const listId = await createList(bearer, 'Null Priority List')

    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/items`,
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'No priority task', priority: null }),
      },
    )
    expect(res.status).toBe(201)
    const item = (await res.json()) as ListItemDto
    expect(item.title).toBe('No priority task')
    // null must survive all the way through — not coerced to 'medium'.
    expect(item.priority).toBeNull()
    expect(item.dueDate).toBeNull()

    // Confirm the SDK received null, not 'medium'.
    const sdkCall = fake.calls.find((c) => c.method === 'createListItem' && c.actor === 'user_qa3')
    const sdkInput = sdkCall?.args[1] as { priority?: string | null } | undefined
    expect(sdkInput?.priority).toBeNull()
  })

  it('POST /items with dueDate only (priority omitted) applies server default priority=medium', async () => {
    // Asymmetric: dueDate set, priority omitted → server default kicks in.
    const bearer = await loginAs('user_qa4')
    const listId = await createList(bearer, 'Due Only List')
    const dueDateInstant = new Date(2026, 8, 1).toISOString()

    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/items`,
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Has due', dueDate: dueDateInstant }),
      },
    )
    expect(res.status).toBe(201)
    const item = (await res.json()) as ListItemDto
    expect(item.dueDate).toBe(dueDateInstant)
    // Priority was omitted → server default 'medium'.
    expect(item.priority).toBe('medium')
  })

  it('POST /items with priority set but no dueDate stores dueDate=null', async () => {
    // Asymmetric: priority set, dueDate omitted → dueDate stays null.
    const bearer = await loginAs('user_qa5')
    const listId = await createList(bearer, 'Priority Only List')

    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/items`,
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Has priority', priority: 'low' }),
      },
    )
    expect(res.status).toBe(201)
    const item = (await res.json()) as ListItemDto
    expect(item.priority).toBe('low')
    expect(item.dueDate).toBeNull()
  })
})
