import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
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

// Integration tests for the group-lists BFF proxy (GET
// /api/v1/ui/groups/:id/lists, #84). events-api owns the membership check;
// the lists-client is stubbed so we assert the authz gate + passthrough
// without standing up lists-api. The stub records the scope it was asked
// for so we can prove events-api forwards the group id, not user input.


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

describe('D1 integration — group lists BFF proxy', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  // Mutable capture so each test can set the canned response and inspect
  // the scope the BFF forwarded.
  let lastScope: { scopeType: string; scopeId: string } | null = null
  let canned: ListDto[] = []
  // Capture for the items proxy: which listId reached lists-client (null
  // proves the confused-deputy guard short-circuited before the call).
  let lastItemsListId: string | null = null
  let cannedItems: ListItemDto[] = []

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
      listLists: async (scope) => {
        lastScope = scope
        return canned
      },
      listItems: async (listId) => {
        lastItemsListId = listId
        return cannedItems
      },
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

  it('returns the group owner their group lists, forwarding the group id as scope', async () => {
    const owner = `user_${Date.now()}_owner`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Lists Owner Event')
    const groupId = await createGroup(bearer, eventId, 'Owners Group')

    canned = [
      listDto({ id: 'lst_a', scopeId: groupId, name: 'Build call sheet' }),
      listDto({ id: 'lst_b', scopeId: groupId, name: 'Gear checklist', listType: 'standard' }),
    ]
    lastScope = null

    const res = await req(bearer, 'GET', `/api/v1/ui/groups/${groupId}/lists`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: ListDto[] }
    expect(body.items.map((l) => l.name)).toEqual(['Build call sheet', 'Gear checklist'])
    // The BFF forwards the group id from the path, scope_type fixed to group.
    expect(lastScope).toEqual({ scopeType: 'group', scopeId: groupId })
  })

  it('returns lists for a non-owner group member', async () => {
    const owner = `user_${Date.now()}_m_owner`
    const member = `${owner}_member`
    const ownerBearer = await loginAs(owner)
    const memberBearer = await loginAs(member)
    const eventId = await createEvent(ownerBearer, 'Lists Member Event')
    const res = await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, {
      name: 'Members Group',
    })
    const created = (await res.json()) as { id: string; join_code: string }
    await req(memberBearer, 'POST', '/api/v1/ui/groups/join', { code: created.join_code })

    canned = [listDto({ id: 'lst_c', scopeId: created.id, name: 'Shared list' })]
    const listsRes = await req(memberBearer, 'GET', `/api/v1/ui/groups/${created.id}/lists`)
    expect(listsRes.status).toBe(200)
    expect(((await listsRes.json()) as { items: ListDto[] }).items).toHaveLength(1)
  })

  it('404s for a user with no group access (no existence leak, lists-client not called)', async () => {
    const owner = `user_${Date.now()}_leak`
    const stranger = `${owner}_stranger`
    const ownerBearer = await loginAs(owner)
    const strangerBearer = await loginAs(stranger)
    const eventId = await createEvent(ownerBearer, 'Lists Leak Event')
    const groupId = await createGroup(ownerBearer, eventId, 'Private Group')

    lastScope = null
    canned = [listDto({ id: 'lst_secret', scopeId: groupId, name: 'Should not leak' })]

    const res = await req(strangerBearer, 'GET', `/api/v1/ui/groups/${groupId}/lists`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('group_not_found')
    // Authz fails before the proxy call — we must not have reached lists-api.
    expect(lastScope).toBeNull()
  })

  it('requires authentication', async () => {
    const res = await app.request('http://localhost/api/v1/ui/groups/group_x/lists')
    expect(res.status).toBe(401)
  })

  // --- items proxy (GET /api/v1/ui/groups/:id/lists/:listId/items) ----

  it('returns items for a list the group owns', async () => {
    const owner = `user_${Date.now()}_items`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Items Event')
    const groupId = await createGroup(bearer, eventId, 'Items Group')

    canned = [listDto({ id: 'lst_items', scopeId: groupId, name: 'Tasks' })]
    cannedItems = [
      itemDto({ id: 'lit_1', listId: 'lst_items', title: 'Soundcheck', dueDate: '2026-06-01T17:00:00.000Z' }),
    ]
    lastItemsListId = null

    const res = await req(bearer, 'GET', `/api/v1/ui/groups/${groupId}/lists/lst_items/items`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: ListItemDto[] }
    expect(body.items.map((i) => i.title)).toEqual(['Soundcheck'])
    expect(lastItemsListId).toBe('lst_items')
  })

  it('404s a listId that does not belong to the group (confused-deputy guard)', async () => {
    const owner = `user_${Date.now()}_deputy`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Deputy Event')
    const groupId = await createGroup(bearer, eventId, 'Deputy Group')

    // The group owns lst_mine; the caller asks for lst_other (another group's).
    canned = [listDto({ id: 'lst_mine', scopeId: groupId, name: 'Mine' })]
    lastItemsListId = null

    const res = await req(bearer, 'GET', `/api/v1/ui/groups/${groupId}/lists/lst_other/items`)
    expect(res.status).toBe(404)
    // Guard fires before proxying — lists-client items must not be called.
    expect(lastItemsListId).toBeNull()
  })

  it('404s items for a user with no group access (no existence leak)', async () => {
    const owner = `user_${Date.now()}_itemsleak`
    const stranger = `${owner}_stranger`
    const ownerBearer = await loginAs(owner)
    const strangerBearer = await loginAs(stranger)
    const eventId = await createEvent(ownerBearer, 'Items Leak Event')
    const groupId = await createGroup(ownerBearer, eventId, 'Private Items Group')

    canned = [listDto({ id: 'lst_secret', scopeId: groupId, name: 'Secret' })]
    lastItemsListId = null

    const res = await req(strangerBearer, 'GET', `/api/v1/ui/groups/${groupId}/lists/lst_secret/items`)
    expect(res.status).toBe(404)
    expect(lastItemsListId).toBeNull()
  })
})
