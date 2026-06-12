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

// D1 integration tests for the custom-status surface (RPL v1.0.0 slice 1):
// lazy seeding, CRUD, reorder, item status resolution + the completed
// mirror, and the last-done-status guard.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

type Status = {
  id: string
  name: string
  category: string
  position: number
  color: string | null
}
type Item = { id: string; status: string | null; status_id: string | null; completed: boolean }

describe('D1 integration — custom statuses', () => {
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

  function headers(bearer: string): Record<string, string> {
    return {
      cookie: `${envVars.LISTS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.LISTS_CSRF_COOKIE_NAME}=${CSRF}`,
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
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  async function makeTaskList(bearer: string): Promise<string> {
    const groupRes = await req(bearer, 'POST', '/api/v1/ui/groups', {
      name: `Group ${Date.now()}_${Math.random().toString(36).slice(2)}`,
    })
    const groupId = ((await groupRes.json()) as { id: string }).id
    const listRes = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'Tasks',
      listType: 'tasks',
      scopeType: 'list_group',
      scopeId: groupId,
    })
    expect(listRes.status).toBe(201)
    return ((await listRes.json()) as { id: string }).id
  }

  async function getStatuses(bearer: string, listId: string): Promise<Status[]> {
    const res = await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/statuses`)
    expect(res.status).toBe(200)
    return ((await res.json()) as { items: Status[] }).items
  }

  it('lazily seeds the three default statuses, in order, on first read', async () => {
    const bearer = await loginAs(`user_${Date.now()}_seed`)
    const listId = await makeTaskList(bearer)
    const statuses = await getStatuses(bearer, listId)
    expect(statuses.map((s) => s.category)).toEqual(['todo', 'in_progress', 'done'])
    expect(statuses.map((s) => s.position)).toEqual([0, 1, 2])
    expect(statuses[0]!.id).toMatch(/^lst_/)

    // Idempotent: a second read does not re-seed.
    const again = await getStatuses(bearer, listId)
    expect(again).toHaveLength(3)
    expect(again.map((s) => s.id)).toEqual(statuses.map((s) => s.id))
  })

  it('resolves a created task item to the default todo status', async () => {
    const bearer = await loginAs(`user_${Date.now()}_create`)
    const listId = await makeTaskList(bearer)
    const statuses = await getStatuses(bearer, listId)
    const todo = statuses.find((s) => s.category === 'todo')!

    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, { title: 'A' })
    expect(res.status).toBe(201)
    const item = (await res.json()) as Item
    expect(item.status).toBe('todo')
    expect(item.status_id).toBe(todo.id)
    expect(item.completed).toBe(false)
  })

  it('creating an item on the done status marks it completed (mirror)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_done`)
    const listId = await makeTaskList(bearer)
    const statuses = await getStatuses(bearer, listId)
    const done = statuses.find((s) => s.category === 'done')!

    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'B',
      statusId: done.id,
    })
    const item = (await res.json()) as Item
    expect(item.status_id).toBe(done.id)
    expect(item.status).toBe('done')
    expect(item.completed).toBe(true)
  })

  it('rejects an item write referencing an unknown status (400)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_unknown`)
    const listId = await makeTaskList(bearer)
    await getStatuses(bearer, listId)
    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'C',
      statusId: 'lst_does_not_exist',
    })
    expect(res.status).toBe(400)
  })

  it('moving an item to a done status via PATCH completes it; back to todo un-completes', async () => {
    const bearer = await loginAs(`user_${Date.now()}_patch`)
    const listId = await makeTaskList(bearer)
    const statuses = await getStatuses(bearer, listId)
    const todo = statuses.find((s) => s.category === 'todo')!
    const done = statuses.find((s) => s.category === 'done')!

    const item = (await (
      await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, { title: 'D' })
    ).json()) as Item

    const toDone = (await (
      await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/items/${item.id}`, {
        statusId: done.id,
      })
    ).json()) as Item
    expect(toDone.status_id).toBe(done.id)
    expect(toDone.completed).toBe(true)

    const toTodo = (await (
      await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/items/${item.id}`, {
        statusId: todo.id,
      })
    ).json()) as Item
    expect(toTodo.status_id).toBe(todo.id)
    expect(toTodo.completed).toBe(false)
  })

  it('creates a custom status and appends it after the defaults', async () => {
    const bearer = await loginAs(`user_${Date.now()}_custom`)
    const listId = await makeTaskList(bearer)
    await getStatuses(bearer, listId)

    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/statuses`, {
      name: 'In review',
      category: 'in_progress',
      color: 'purple',
    })
    expect(res.status).toBe(201)
    const created = (await res.json()) as Status
    expect(created.id).toMatch(/^lst_/)
    expect(created.position).toBe(3)

    const all = await getStatuses(bearer, listId)
    expect(all).toHaveLength(4)
    expect(all[3]!.name).toBe('In review')
  })

  it('recategorizing a status to done completes its items', async () => {
    const bearer = await loginAs(`user_${Date.now()}_recat`)
    const listId = await makeTaskList(bearer)
    const statuses = await getStatuses(bearer, listId)
    const inProgress = statuses.find((s) => s.category === 'in_progress')!

    const item = (await (
      await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
        title: 'E',
        statusId: inProgress.id,
      })
    ).json()) as Item
    expect(item.completed).toBe(false)

    const patch = await req(
      bearer,
      'PATCH',
      `/api/v1/ui/lists/${listId}/statuses/${inProgress.id}`,
      { category: 'done' },
    )
    expect(patch.status).toBe(200)

    const fresh = (await (
      await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/items`)
    ).json()) as { items: Item[] }
    const updated = fresh.items.find((i) => i.id === item.id)!
    expect(updated.status).toBe('done')
    expect(updated.completed).toBe(true)
  })

  it('deleting a status reassigns its items to a fallback', async () => {
    const bearer = await loginAs(`user_${Date.now()}_del`)
    const listId = await makeTaskList(bearer)
    const statuses = await getStatuses(bearer, listId)
    const inProgress = statuses.find((s) => s.category === 'in_progress')!
    const todo = statuses.find((s) => s.category === 'todo')!

    const item = (await (
      await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
        title: 'F',
        statusId: inProgress.id,
      })
    ).json()) as Item

    const del = await req(
      bearer,
      'DELETE',
      `/api/v1/ui/lists/${listId}/statuses/${inProgress.id}`,
    )
    expect(del.status).toBe(204)

    const fresh = (await (
      await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/items`)
    ).json()) as { items: Item[] }
    const moved = fresh.items.find((i) => i.id === item.id)!
    // Fallback for an in_progress status with no sibling is the first
    // remaining status by position — the todo default.
    expect(moved.status_id).toBe(todo.id)
    expect(moved.status).toBe('todo')
    expect(moved.completed).toBe(false)
  })

  it('refuses to delete the last done status (409)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_lastdone`)
    const listId = await makeTaskList(bearer)
    const statuses = await getStatuses(bearer, listId)
    const done = statuses.find((s) => s.category === 'done')!
    const res = await req(bearer, 'DELETE', `/api/v1/ui/lists/${listId}/statuses/${done.id}`)
    expect(res.status).toBe(409)
  })

  it('reorders statuses', async () => {
    const bearer = await loginAs(`user_${Date.now()}_order`)
    const listId = await makeTaskList(bearer)
    const statuses = await getStatuses(bearer, listId)
    const reversed = statuses.map((s) => s.id).reverse()

    const res = await req(bearer, 'PUT', `/api/v1/ui/lists/${listId}/statuses/order`, {
      orderedIds: reversed,
    })
    expect(res.status).toBe(200)
    const after = await getStatuses(bearer, listId)
    expect(after.map((s) => s.id)).toEqual(reversed)
  })
})
