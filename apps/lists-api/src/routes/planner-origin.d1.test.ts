import { env } from 'cloudflare:test'
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
import { LISTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 integration tests for the planner-origin read-only rule (#531):
// groups provisioned by the Planner BFF (origin='planner') are served
// READ-ONLY on the Lists UI surface — every mutation 403s — while the
// SDK surface (Planner's own path) stays fully writable.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — planner-origin read-only (UI surface)', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  const services: Services = {
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: async () => {},
    },
    rpidSso: {
      exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
    },
    settings: {
      get: async () => ({}),
      patch: async (_u: string, _n: string, p: Record<string, unknown>) => p,
    },
  }

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })

  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(LISTS_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { LISTS_SESSION_KEY_V1: envVars.LISTS_SESSION_KEY_V1 },
      keyVersion: envVars.LISTS_SESSION_KEY_VERSION,
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

  function uiHeaders(bearer: string): Record<string, string> {
    return {
      cookie: `${envVars.LISTS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.LISTS_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      'content-type': 'application/json',
    }
  }

  async function ui(
    bearer: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: uiHeaders(bearer),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  function sdkHeaders(actor: string): Record<string, string> {
    return {
      authorization: `Bearer ${envVars.PLANNER_API_KEY!}`,
      'x-actor': actor,
      'content-type': 'application/json',
    }
  }

  async function sdk(actor: string, method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: sdkHeaders(actor),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  // Provision a planner-origin group + tasks list + one item for a user,
  // exactly the way the Planner BFF does it (SDK surface, origin stamp).
  async function seedPlannerScope(actor: string): Promise<{
    groupId: string
    listId: string
    itemId: string
  }> {
    const groupRes = await sdk(actor, 'POST', '/api/v1/sdk/groups', {
      name: 'My Tasks',
      origin: 'planner',
    })
    expect(groupRes.status).toBe(201)
    const group = (await groupRes.json()) as { id: string; origin: string | null }
    expect(group.origin).toBe('planner')

    const listRes = await sdk(actor, 'POST', '/api/v1/sdk/lists', {
      name: 'Errands',
      listType: 'tasks',
      scopeType: 'list_group',
      scopeId: group.id,
    })
    expect(listRes.status).toBe(201)
    const listId = ((await listRes.json()) as { id: string }).id

    const itemRes = await sdk(actor, 'POST', `/api/v1/sdk/lists/${listId}/items`, {
      title: 'Buy milk',
    })
    expect(itemRes.status).toBe(201)
    const itemId = ((await itemRes.json()) as { id: string }).id

    return { groupId: group.id, listId, itemId }
  }

  it('SDK createGroup without origin leaves it null (Lists-app groups stay writable)', async () => {
    const actor = `user_${'0'.repeat(20)}PRG001`
    const res = await sdk(actor, 'POST', '/api/v1/sdk/groups', { name: 'Plain group' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { origin: string | null }
    expect(body.origin).toBeNull()
  })

  it('UI reads still work on a planner-origin list, but item writes 403', async () => {
    const actor = `user_${'0'.repeat(20)}PRG002`
    const bearer = await loginAs(actor)
    const { listId, itemId } = await seedPlannerScope(actor)

    // Read: list + items are visible.
    const getList = await ui(bearer, 'GET', `/api/v1/ui/lists/${listId}`)
    expect(getList.status).toBe(200)
    const getItems = await ui(bearer, 'GET', `/api/v1/ui/lists/${listId}/items`)
    expect(getItems.status).toBe(200)

    // Writes: create / patch / delete / restore all 403.
    const create = await ui(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, { title: 'Nope' })
    expect(create.status).toBe(403)
    const patch = await ui(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/items/${itemId}`, {
      completed: true,
    })
    expect(patch.status).toBe(403)
    const del = await ui(bearer, 'DELETE', `/api/v1/ui/lists/${listId}/items/${itemId}`)
    expect(del.status).toBe(403)
    const bulk = await ui(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/bulk`, {
      action: 'complete',
      itemIds: [itemId],
    })
    expect(bulk.status).toBe(403)

    // Item untouched throughout.
    const item = await repos.listItems.findById(itemId)
    expect(item!.completed).toBe(false)
    expect(item!.deletedAt).toBeNull()
  })

  it('UI structural mutations on a planner-origin list 403 (delete, statuses, comments, list create)', async () => {
    const actor = `user_${'0'.repeat(20)}PRG003`
    const bearer = await loginAs(actor)
    const { groupId, listId, itemId } = await seedPlannerScope(actor)

    const delList = await ui(bearer, 'DELETE', `/api/v1/ui/lists/${listId}`)
    expect(delList.status).toBe(403)

    const status = await ui(bearer, 'POST', `/api/v1/ui/lists/${listId}/statuses`, {
      name: 'Blocked',
      category: 'todo',
    })
    expect(status.status).toBe(403)

    const comment = await ui(
      bearer,
      'POST',
      `/api/v1/ui/lists/${listId}/items/${itemId}/comments`,
      { body: 'hi' },
    )
    expect(comment.status).toBe(403)

    const createInScope = await ui(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'Sneaky RPL list',
      listType: 'standard',
      scopeType: 'list_group',
      scopeId: groupId,
    })
    expect(createInScope.status).toBe(403)
  })

  it('UI group rename/delete on a planner-origin group 403', async () => {
    const actor = `user_${'0'.repeat(20)}PRG004`
    const bearer = await loginAs(actor)
    const { groupId } = await seedPlannerScope(actor)

    const rename = await ui(bearer, 'PATCH', `/api/v1/ui/groups/${groupId}`, { name: 'Renamed' })
    expect(rename.status).toBe(403)
    const del = await ui(bearer, 'DELETE', `/api/v1/ui/groups/${groupId}`)
    expect(del.status).toBe(403)

    // Group untouched.
    const group = await repos.groups.findById(groupId)
    expect(group!.name).toBe('My Tasks')
    expect(group!.deletedAt).toBeNull()
  })

  it('UI group listing surfaces origin so the client can render read-only', async () => {
    const actor = `user_${'0'.repeat(20)}PRG005`
    const bearer = await loginAs(actor)
    const { groupId } = await seedPlannerScope(actor)

    const res = await ui(bearer, 'GET', '/api/v1/ui/groups')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { id: string; origin: string | null }[] }
    const mine = body.items.find((g) => g.id === groupId)
    expect(mine?.origin).toBe('planner')
  })

  it('SDK surface stays writable on the same planner-origin list', async () => {
    const actor = `user_${'0'.repeat(20)}PRG006`
    const { listId, itemId } = await seedPlannerScope(actor)

    const patch = await sdk(actor, 'PATCH', `/api/v1/sdk/lists/${listId}/items/${itemId}`, {
      completed: true,
    })
    expect(patch.status).toBe(200)
    const item = await repos.listItems.findById(itemId)
    expect(item!.completed).toBe(true)
  })

  it('normal (null-origin) groups are unaffected — UI writes still succeed', async () => {
    const actor = `user_${'0'.repeat(20)}PRG007`
    const bearer = await loginAs(actor)

    const groupRes = await ui(bearer, 'POST', '/api/v1/ui/groups', { name: 'RPL group' })
    expect(groupRes.status).toBe(201)
    const groupId = ((await groupRes.json()) as { id: string }).id

    const listRes = await ui(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'Groceries',
      listType: 'standard',
      scopeType: 'list_group',
      scopeId: groupId,
    })
    expect(listRes.status).toBe(201)
    const listId = ((await listRes.json()) as { id: string }).id

    const itemRes = await ui(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Eggs',
    })
    expect(itemRes.status).toBe(201)
  })
})
