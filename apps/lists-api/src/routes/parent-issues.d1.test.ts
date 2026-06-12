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

// D1 integration tests for sub-item hierarchy (RPL v1.0.0 slice 4):
// parent assignment, cycle/cross-list/self rejection, the child rollup,
// and orphaning on delete + cross-list move.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

type Item = { id: string; parent_id: string | null; completed: boolean }
type ListedItem = Item & { child_count: number; child_done_count: number }

describe('D1 integration — sub-item hierarchy', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  const services: Services = {
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: async () => {},
    },
    rpidSso: { exchange: async () => ({ ok: false as const, reason: 'invalid' as const }) },
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

  function headers(bearer: string): Record<string, string> {
    return {
      cookie: `${envVars.LISTS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.LISTS_CSRF_COOKIE_NAME}=${CSRF}`,
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

  async function makeList(bearer: string, groupId?: string): Promise<{ listId: string; groupId: string }> {
    let gid = groupId
    if (!gid) {
      const groupRes = await req(bearer, 'POST', '/api/v1/ui/groups', {
        name: `Group ${Date.now()}_${Math.random().toString(36).slice(2)}`,
      })
      gid = ((await groupRes.json()) as { id: string }).id
    }
    const listRes = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'List',
      listType: 'standard',
      scopeType: 'list_group',
      scopeId: gid,
    })
    expect(listRes.status).toBe(201)
    return { listId: ((await listRes.json()) as { id: string }).id, groupId: gid }
  }

  async function addItem(bearer: string, listId: string, body: Record<string, unknown>): Promise<Item> {
    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, body)
    expect(res.status).toBe(201)
    return (await res.json()) as Item
  }

  async function listItems(bearer: string, listId: string): Promise<ListedItem[]> {
    const res = await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/items`)
    expect(res.status).toBe(200)
    return ((await res.json()) as { items: ListedItem[] }).items
  }

  it('creates a sub-item under a parent', async () => {
    const bearer = await loginAs(`user_${Date.now()}_sub`)
    const { listId } = await makeList(bearer)
    const parent = await addItem(bearer, listId, { title: 'Parent' })
    const child = await addItem(bearer, listId, { title: 'Child', parentId: parent.id })
    expect(child.parent_id).toBe(parent.id)
  })

  it('rejects a parent from another list (400)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_xlist`)
    const a = await makeList(bearer)
    const b = await makeList(bearer, a.groupId)
    const parentInA = await addItem(bearer, a.listId, { title: 'P' })
    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${b.listId}/items`, {
      title: 'C',
      parentId: parentInA.id,
    })
    expect(res.status).toBe(400)
  })

  it('rejects self-parenting and direct cycles (400)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_cycle`)
    const { listId } = await makeList(bearer)
    const a = await addItem(bearer, listId, { title: 'A' })
    const b = await addItem(bearer, listId, { title: 'B', parentId: a.id })

    // self-parent
    const selfRes = await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/items/${a.id}`, {
      parentId: a.id,
    })
    expect(selfRes.status).toBe(400)

    // cycle: a is b's ancestor, so setting a.parent = b closes a loop
    const cycleRes = await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/items/${a.id}`, {
      parentId: b.id,
    })
    expect(cycleRes.status).toBe(400)
  })

  it('enforces the depth cap (400)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_deep`)
    const { listId } = await makeList(bearer)
    // Build a chain as deep as allowed, then one more should fail.
    let prev = (await addItem(bearer, listId, { title: 'root' })).id
    let lastStatus = 201
    for (let i = 0; i < 10; i++) {
      const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
        title: `n${i}`,
        parentId: prev,
      })
      lastStatus = res.status
      if (res.status !== 201) break
      prev = ((await res.json()) as Item).id
    }
    // Somewhere within 10 levels the depth cap (5) must have rejected one.
    expect(lastStatus).toBe(400)
  })

  it('detaches a sub-item back to top-level via null', async () => {
    const bearer = await loginAs(`user_${Date.now()}_detach`)
    const { listId } = await makeList(bearer)
    const parent = await addItem(bearer, listId, { title: 'P' })
    const child = await addItem(bearer, listId, { title: 'C', parentId: parent.id })
    const res = await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/items/${child.id}`, {
      parentId: null,
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as Item).parent_id).toBeNull()
  })

  it('reports the child rollup in the list response', async () => {
    const bearer = await loginAs(`user_${Date.now()}_rollup`)
    const { listId } = await makeList(bearer)
    const parent = await addItem(bearer, listId, { title: 'P' })
    const c1 = await addItem(bearer, listId, { title: 'c1', parentId: parent.id })
    await addItem(bearer, listId, { title: 'c2', parentId: parent.id })
    // Complete one child.
    await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/items/${c1.id}`, { completed: true })

    const items = await listItems(bearer, listId)
    const parentRow = items.find((i) => i.id === parent.id)!
    expect(parentRow.child_count).toBe(2)
    expect(parentRow.child_done_count).toBe(1)
  })

  it('orphans children to top-level when the parent is soft-deleted', async () => {
    const bearer = await loginAs(`user_${Date.now()}_delparent`)
    const { listId } = await makeList(bearer)
    const parent = await addItem(bearer, listId, { title: 'P' })
    const child = await addItem(bearer, listId, { title: 'C', parentId: parent.id })

    const del = await req(bearer, 'DELETE', `/api/v1/ui/lists/${listId}/items/${parent.id}`)
    expect(del.status).toBe(204)

    const items = await listItems(bearer, listId)
    // Parent is gone; child survives, now top-level.
    expect(items.find((i) => i.id === parent.id)).toBeUndefined()
    const childRow = items.find((i) => i.id === child.id)!
    expect(childRow.parent_id).toBeNull()
  })

  it('orphans children when a parent is bulk-deleted', async () => {
    const bearer = await loginAs(`user_${Date.now()}_bulkdel`)
    const { listId } = await makeList(bearer)
    const parent = await addItem(bearer, listId, { title: 'P' })
    const child = await addItem(bearer, listId, { title: 'C', parentId: parent.id })

    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/bulk`, {
      action: 'delete',
      itemIds: [parent.id],
    })
    expect(res.status).toBe(200)

    const items = await listItems(bearer, listId)
    expect(items.find((i) => i.id === parent.id)).toBeUndefined()
    const childRow = items.find((i) => i.id === child.id)!
    expect(childRow.parent_id).toBeNull()
  })

  it('orphans children left behind when an item is moved to another list', async () => {
    const bearer = await loginAs(`user_${Date.now()}_movechild`)
    const a = await makeList(bearer)
    const b = await makeList(bearer, a.groupId)
    const parent = await addItem(bearer, a.listId, { title: 'P' })
    const child = await addItem(bearer, a.listId, { title: 'C', parentId: parent.id })

    // Move the parent to list B.
    const move = await req(bearer, 'PATCH', `/api/v1/ui/lists/${a.listId}/items/${parent.id}`, {
      listId: b.listId,
    })
    expect(move.status).toBe(200)
    expect(((await move.json()) as Item).parent_id).toBeNull()

    // The child stayed in list A and is now top-level.
    const itemsA = await listItems(bearer, a.listId)
    const childRow = itemsA.find((i) => i.id === child.id)!
    expect(childRow.parent_id).toBeNull()
  })
})
