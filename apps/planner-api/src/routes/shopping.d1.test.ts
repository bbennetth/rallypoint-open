import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { env as testEnv } from 'cloudflare:test'
import type { Hono } from 'hono'
import {
  ListsClientError,
  type GroupDto,
  type ListDto,
  type ListItemDto,
  type ListsClient,
} from '@rallypoint/lists-client'
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

// Integration tests for the Planner Shopping BFF (#443 — single system-managed list).
// A real planner session lives in a Miniflare D1 (planner-db); RPID is stubbed
// and the Lists SDK is an in-memory fake. The point is to exercise:
// - GET /shopping/list auto-provisions the single shopping list (resolveShoppingList).
// - Repeated GETs return the SAME list id (idempotence).
// - The shopping list does NOT appear on the Tasks rail (GET /lists).
// - Items CRUD round-trips through the BFF.
// - Unknown list IDOR guard on item read.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

function isoNow(): string {
  return new Date().toISOString()
}

function makeFakeLists(): { client: ListsClient } {
  const groups: GroupDto[] = []
  const lists: ListDto[] = []
  const items: ListItemDto[] = []

  function ownsGroup(actor: string, scopeId: string): boolean {
    return groups.some((g) => g.id === scopeId && g.createdBy === actor)
  }
  function listOf(listId: string): ListDto | undefined {
    return lists.find((l) => l.id === listId)
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
      const it: ListItemDto = {
        id: `lit_${items.length + 1}`,
        listId,
        title: input.title,
        notes: input.notes ?? null,
        assignedTo: input.assignedTo ?? null,
        completed: false,
        completedAt: null,
        status: null,
        priority: null,
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
    updateListItem: async (listId, itemId, patch, _actor) => {
      const it = items.find((x) => x.id === itemId && x.listId === listId)
      if (!it) throw new ListsClientError(404, 'item_not_found', 'Item not found.')
      if (patch.completed !== undefined) it.completed = patch.completed
      if (patch.title !== undefined) it.title = patch.title
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
    // Stub remaining SDK methods not used by the shopping BFF.
    listFieldDefs: async () => [],
    createFieldDef: async () => { throw new Error('not stubbed') },
    updateFieldDef: async () => { throw new Error('not stubbed') },
    deleteFieldDef: async () => {},
    listSeries: async () => [],
    createListItemSeries: async () => { throw new Error('not stubbed') },
    updateSeries: async () => { throw new Error('not stubbed') },
    deleteSeries: async () => {},
  }

  return { client }
}

// Minimal stub for the events client (not exercised by shopping routes).
function makeFakeEvents(): { client: EventsClient } {
  const client = {
    listPersonalEvents: async () => [],
    listUserEvents: async () => [],
  } as unknown as EventsClient
  return { client }
}

describe('D1 integration — Planner Shopping BFF', () => {
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

  // --- single system-managed shopping list ----------------------------------

  it('GET /shopping/list auto-provisions and returns the single shopping list', async () => {
    const bearer = await loginAs('user_shop_new')
    const res = await req(bearer, 'GET', '/api/v1/ui/shopping/list')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(typeof body.id).toBe('string')
    expect(body.listType).toBe('shopping')
  })

  it('GET /shopping/list is idempotent — repeated calls return the same list id', async () => {
    const bearer = await loginAs('user_shop_idem')
    const res1 = await req(bearer, 'GET', '/api/v1/ui/shopping/list')
    const res2 = await req(bearer, 'GET', '/api/v1/ui/shopping/list')
    const res3 = await req(bearer, 'GET', '/api/v1/ui/shopping/list')
    expect(res1.status).toBe(200)
    const id1 = ((await res1.json()) as Record<string, unknown>).id
    const id2 = ((await res2.json()) as Record<string, unknown>).id
    const id3 = ((await res3.json()) as Record<string, unknown>).id
    expect(id1).toBe(id2)
    expect(id2).toBe(id3)
  })

  it('the shopping list does NOT appear on the Tasks rail (GET /lists)', async () => {
    const bearer = await loginAs('user_shop_rail')
    // Provision the shopping list via GET /shopping/list.
    await req(bearer, 'GET', '/api/v1/ui/shopping/list')
    // Also create a task list.
    await req(bearer, 'POST', '/api/v1/ui/lists', { name: 'My tasks' })

    const tasksRes = await req(bearer, 'GET', '/api/v1/ui/lists')
    expect(tasksRes.status).toBe(200)
    const taskLists = (await tasksRes.json()) as Array<Record<string, unknown>>

    // Tasks rail must NOT contain the shopping list.
    expect(taskLists.every((l) => l.listType !== 'shopping')).toBe(true)
  })

  it('creates and lists items in the shopping list', async () => {
    const bearer = await loginAs('user_shop_items')
    const listRes = await req(bearer, 'GET', '/api/v1/ui/shopping/list')
    const listId = ((await listRes.json()) as Record<string, unknown>).id as string

    const itemRes = await req(bearer, 'POST', `/api/v1/ui/shopping/${listId}/items`, {
      title: 'Milk',
    })
    expect(itemRes.status).toBe(201)

    const listItemsRes = await req(bearer, 'GET', `/api/v1/ui/shopping/${listId}/items`)
    expect(listItemsRes.status).toBe(200)
    const items = (await listItemsRes.json()) as Array<Record<string, unknown>>
    expect(items.length).toBe(1)
    expect(items[0].title).toBe('Milk')
  })

  it('can check off a shopping item', async () => {
    const bearer = await loginAs('user_shop_toggle')
    const listRes = await req(bearer, 'GET', '/api/v1/ui/shopping/list')
    const listId = ((await listRes.json()) as Record<string, unknown>).id as string

    const itemRes = await req(bearer, 'POST', `/api/v1/ui/shopping/${listId}/items`, {
      title: 'Eggs',
    })
    const itemId = ((await itemRes.json()) as Record<string, unknown>).id as string

    const patchRes = await req(bearer, 'PATCH', `/api/v1/ui/shopping/${listId}/items/${itemId}`, {
      completed: true,
    })
    expect(patchRes.status).toBe(200)
    expect(((await patchRes.json()) as Record<string, unknown>).completed).toBe(true)
  })

  it('can delete a shopping item', async () => {
    const bearer = await loginAs('user_shop_delitem')
    const listRes = await req(bearer, 'GET', '/api/v1/ui/shopping/list')
    const listId = ((await listRes.json()) as Record<string, unknown>).id as string

    const itemRes = await req(bearer, 'POST', `/api/v1/ui/shopping/${listId}/items`, {
      title: 'Coffee',
    })
    const itemId = ((await itemRes.json()) as Record<string, unknown>).id as string

    const delRes = await req(bearer, 'DELETE', `/api/v1/ui/shopping/${listId}/items/${itemId}`)
    expect(delRes.status).toBe(204)
  })

  it('404s on item read for a list the actor does not own', async () => {
    const bearer = await loginAs('user_shop_idor')
    const res = await req(bearer, 'GET', '/api/v1/ui/shopping/lst_foreign_nobody/items')
    expect(res.status).toBe(404)
  })

  it('404s on item read for a tasks list accessed via the shopping items path', async () => {
    // The shopping items GET must reject a list that isn't THE user's shopping list.
    const bearer = await loginAs('user_shop_typecheck01')

    // Create a tasks list via the tasks endpoint.
    const tasksRes = await req(bearer, 'POST', '/api/v1/ui/lists', { name: 'My tasks' })
    expect(tasksRes.status).toBe(201)
    const tasksListId = ((await tasksRes.json()) as Record<string, unknown>).id as string

    // Attempt to read its items via the shopping items endpoint — must 404.
    const itemsRes = await req(bearer, 'GET', `/api/v1/ui/shopping/${tasksListId}/items`)
    expect(itemsRes.status).toBe(404)
  })

  it('401s when no session cookie is present', async () => {
    const res = await app.request('http://localhost/api/v1/ui/shopping/list', {
      headers: {
        'x-rp-csrf': CSRF,
        cookie: `${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`,
        'content-type': 'application/json',
      },
    })
    expect(res.status).toBe(401)
  })

  // --- cross-type write guard (shopping path must reject non-shopping lists) ---
  // The actor has BOTH a tasks list and a shopping list in their personal scope.
  // Using the tasks listId on the shopping item write paths must 404; the real
  // shopping listId must still succeed.

  it('POST item with a tasks listId (cross-type) 404s', async () => {
    const bearer = await loginAs('user_shop_xtype_post')
    // Ensure a shopping list exists for this actor.
    await req(bearer, 'GET', '/api/v1/ui/shopping/list')
    // Create a tasks list in the actor's personal scope.
    const tasksRes = await req(bearer, 'POST', '/api/v1/ui/lists', { name: 'Shopping xtype tasks' })
    expect(tasksRes.status).toBe(201)
    const tasksListId = ((await tasksRes.json()) as Record<string, unknown>).id as string

    // Attempt to create a shopping item on the tasks list — must 404.
    const res = await req(bearer, 'POST', `/api/v1/ui/shopping/${tasksListId}/items`, {
      title: 'Should not exist',
    })
    expect(res.status).toBe(404)
  })

  it('PATCH item with a tasks listId (cross-type) 404s', async () => {
    const bearer = await loginAs('user_shop_xtype_patch')
    // Ensure a shopping list and a tasks list both exist for this actor.
    const shopRes = await req(bearer, 'GET', '/api/v1/ui/shopping/list')
    const shopListId = ((await shopRes.json()) as Record<string, unknown>).id as string
    const tasksRes = await req(bearer, 'POST', '/api/v1/ui/lists', { name: 'Shopping xtype tasks' })
    expect(tasksRes.status).toBe(201)
    const tasksListId = ((await tasksRes.json()) as Record<string, unknown>).id as string

    // Add a real shopping item so we have a valid itemId to attempt to patch.
    const itemRes = await req(bearer, 'POST', `/api/v1/ui/shopping/${shopListId}/items`, {
      title: 'Real item',
    })
    expect(itemRes.status).toBe(201)
    const itemId = ((await itemRes.json()) as Record<string, unknown>).id as string

    // Attempt to update via the tasks listId on the shopping path — must 404.
    const res = await req(
      bearer,
      'PATCH',
      `/api/v1/ui/shopping/${tasksListId}/items/${itemId}`,
      { completed: true },
    )
    expect(res.status).toBe(404)
  })

  it('DELETE item with a tasks listId (cross-type) 404s', async () => {
    const bearer = await loginAs('user_shop_xtype_del')
    // Ensure both list types exist for this actor.
    const shopRes = await req(bearer, 'GET', '/api/v1/ui/shopping/list')
    const shopListId = ((await shopRes.json()) as Record<string, unknown>).id as string
    const tasksRes = await req(bearer, 'POST', '/api/v1/ui/lists', { name: 'Shopping xtype tasks' })
    expect(tasksRes.status).toBe(201)
    const tasksListId = ((await tasksRes.json()) as Record<string, unknown>).id as string

    // Add a real shopping item.
    const itemRes = await req(bearer, 'POST', `/api/v1/ui/shopping/${shopListId}/items`, {
      title: 'Real item',
    })
    expect(itemRes.status).toBe(201)
    const itemId = ((await itemRes.json()) as Record<string, unknown>).id as string

    // Attempt to delete via the tasks listId on the shopping path — must 404.
    const res = await req(
      bearer,
      'DELETE',
      `/api/v1/ui/shopping/${tasksListId}/items/${itemId}`,
    )
    expect(res.status).toBe(404)
  })

  it('POST item with the real shopping listId still succeeds (regression guard)', async () => {
    const bearer = await loginAs('user_shop_xtype_ok')
    // Both list types exist; real shopping listId must still work.
    const shopRes = await req(bearer, 'GET', '/api/v1/ui/shopping/list')
    expect(shopRes.status).toBe(200)
    const shopListId = ((await shopRes.json()) as Record<string, unknown>).id as string
    // Create a tasks list to make the fixture realistic.
    await req(bearer, 'POST', '/api/v1/ui/lists', { name: 'Some tasks list' })

    const res = await req(bearer, 'POST', `/api/v1/ui/shopping/${shopListId}/items`, {
      title: 'Butter',
    })
    expect(res.status).toBe(201)
    expect(((await res.json()) as Record<string, unknown>).title).toBe('Butter')
  })
})
