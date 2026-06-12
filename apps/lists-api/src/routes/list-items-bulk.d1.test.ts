import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type { Hono } from 'hono'
import type { RealtimeBus, RealtimeEnvelope, Subscription } from '@rallypoint/realtime'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { LISTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 integration tests for the bulk item endpoint. Replaces
// list-items-bulk.it.test.ts. A spy realtime bus captures publishes.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

interface Published {
  channel: string
  env: RealtimeEnvelope
}

describe('D1 integration — bulk item actions', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>
  let published: Published[]

  const spyBus: RealtimeBus = {
    async publish(channel: string, e: RealtimeEnvelope) {
      published.push({ channel, env: e })
    },
    subscribe(): Subscription {
      return { unsubscribe() {} }
    },
    async close() {},
  }

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
    app = buildApp({ env: envVars, logger: undefined, repos, services, realtime: spyBus })
  })

  beforeEach(() => {
    published = []
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

  async function makeList(
    bearer: string,
    listType: 'tasks' | 'standard' = 'tasks',
  ): Promise<string> {
    const groupRes = await req(bearer, 'POST', '/api/v1/ui/groups', {
      name: `Group ${Date.now()}_${Math.random().toString(36).slice(2)}`,
    })
    const groupId = ((await groupRes.json()) as { id: string }).id
    const res = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'List',
      listType,
      scopeType: 'list_group',
      scopeId: groupId,
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }

  async function makeItem(bearer: string, listId: string, title: string): Promise<string> {
    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, { title })
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }

  async function listItems(
    bearer: string,
    listId: string,
  ): Promise<Array<{ id: string; completed: boolean; custom_fields: Record<string, unknown> }>> {
    const res = await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/items`)
    return (
      (await res.json()) as {
        items: Array<{ id: string; completed: boolean; custom_fields: Record<string, unknown> }>
      }
    ).items
  }

  it('bulk-updates many items in one frame and leaves unselected items untouched', async () => {
    const bearer = await loginAs(`user_${Date.now()}_bu`)
    const listId = await makeList(bearer)
    const a = await makeItem(bearer, listId, 'A')
    const b = await makeItem(bearer, listId, 'B')
    const c = await makeItem(bearer, listId, 'C')
    published = []

    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/bulk`, {
      action: 'update',
      itemIds: [a, b],
      patch: { completed: true },
    })
    expect(res.status).toBe(200)
    const out = (await res.json()) as { count: number; ids: string[] }
    expect(out.count).toBe(2)
    expect(out.ids.sort()).toEqual([a, b].sort())

    // Exactly one coalesced realtime frame.
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      channel: `lists:list:${listId}`,
      env: { resource: 'list_items', operation: 'update' },
    })

    const items = await listItems(bearer, listId)
    const byId = new Map(items.map((i) => [i.id, i]))
    expect(byId.get(a)!.completed).toBe(true)
    expect(byId.get(b)!.completed).toBe(true)
    expect(byId.get(c)!.completed).toBe(false)
  })

  it('bulk-sets a custom status across items, mirroring completed off its category (S6)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_bs`)
    const listId = await makeList(bearer) // tasks list
    const a = await makeItem(bearer, listId, 'A')
    const b = await makeItem(bearer, listId, 'B')

    // Reading statuses lazy-seeds the three defaults; pick the done one.
    const stRes = await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/statuses`)
    expect(stRes.status).toBe(200)
    const statuses = ((await stRes.json()) as {
      items: Array<{ id: string; category: string }>
    }).items
    const done = statuses.find((s) => s.category === 'done')!
    expect(done).toBeTruthy()
    published = []

    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/bulk`, {
      action: 'update',
      itemIds: [a, b],
      patch: { statusId: done.id },
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { count: number }).count).toBe(2)
    // One coalesced realtime frame for the whole batch.
    expect(published).toHaveLength(1)

    const after = await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/items`)
    const rows = ((await after.json()) as {
      items: Array<{ id: string; status_id: string | null; status: string | null; completed: boolean }>
    }).items
    const byId = new Map(rows.map((i) => [i.id, i]))
    for (const id of [a, b]) {
      expect(byId.get(id)!.status_id).toBe(done.id)
      // The done category mirrors completed + dual-writes the legacy text.
      expect(byId.get(id)!.completed).toBe(true)
      expect(byId.get(id)!.status).toBe('done')
    }
  })

  it('returns ids in input order for a base-only batch (single-UPDATE path, #247)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_ord`)
    const listId = await makeList(bearer)
    const a = await makeItem(bearer, listId, 'A')
    const b = await makeItem(bearer, listId, 'B')
    const c = await makeItem(bearer, listId, 'C')
    published = []

    // Deliberately un-sorted order — the collapsed path RETURNS in DB
    // order, so the repo must re-project onto the input order.
    const order = [c, a, b]
    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/bulk`, {
      action: 'update',
      itemIds: order,
      patch: { completed: true },
    })
    expect(res.status).toBe(200)
    const out = (await res.json()) as { count: number; ids: string[] }
    expect(out.ids).toEqual(order)

    const items = await listItems(bearer, listId)
    for (const i of items) expect(i.completed).toBe(true)
  })

  it('bulk-soft-deletes a set and emits one delete frame', async () => {
    const bearer = await loginAs(`user_${Date.now()}_bd`)
    const listId = await makeList(bearer)
    const a = await makeItem(bearer, listId, 'A')
    const b = await makeItem(bearer, listId, 'B')
    const c = await makeItem(bearer, listId, 'C')
    published = []

    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/bulk`, {
      action: 'delete',
      itemIds: [a, c],
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { count: number }).count).toBe(2)

    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      channel: `lists:list:${listId}`,
      env: { resource: 'list_items', operation: 'delete' },
    })

    const remaining = (await listItems(bearer, listId)).map((i) => i.id)
    expect(remaining).toEqual([b])
  })

  it('ignores ids that belong to another list', async () => {
    const bearer = await loginAs(`user_${Date.now()}_xl`)
    const listId = await makeList(bearer)
    const otherId = await makeList(bearer)
    const mine = await makeItem(bearer, listId, 'Mine')
    const foreign = await makeItem(bearer, otherId, 'Foreign')
    published = []

    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/bulk`, {
      action: 'update',
      itemIds: [mine, foreign],
      patch: { completed: true },
    })
    const out = (await res.json()) as { count: number; ids: string[] }
    expect(out.count).toBe(1)
    expect(out.ids).toEqual([mine])

    // The foreign list's item is unchanged.
    const foreignItems = await listItems(bearer, otherId)
    expect(foreignItems.find((i) => i.id === foreign)!.completed).toBe(false)

    // A delete scoped to one list can't soft-delete a foreign list's item.
    published = []
    const del = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/bulk`, {
      action: 'delete',
      itemIds: [mine, foreign],
    })
    expect(((await del.json()) as { count: number }).count).toBe(1)
    expect((await listItems(bearer, otherId)).map((i) => i.id)).toEqual([foreign])
  })

  it('rejects the whole batch when a custom-field value is invalid', async () => {
    const bearer = await loginAs(`user_${Date.now()}_cf`)
    const listId = await makeList(bearer, 'standard')
    const budget = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/fields`, {
      label: 'Budget',
      fieldType: 'number',
    })).json()) as { id: string }
    const a = await makeItem(bearer, listId, 'A')
    const b = await makeItem(bearer, listId, 'B')
    published = []

    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/bulk`, {
      action: 'update',
      itemIds: [a, b],
      patch: { customFields: { [budget.id]: 'not a number' } },
    })
    expect(res.status).toBe(400)
    // No frame, no write — all-or-nothing.
    expect(published).toHaveLength(0)
    const items = await listItems(bearer, listId)
    for (const i of items) expect(i.custom_fields).toEqual({})
  })

  it('sets a valid custom-field value across the batch in one frame', async () => {
    const bearer = await loginAs(`user_${Date.now()}_cfok`)
    const listId = await makeList(bearer, 'standard')
    const budget = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/fields`, {
      label: 'Budget',
      fieldType: 'number',
    })).json()) as { id: string }
    const a = await makeItem(bearer, listId, 'A')
    const b = await makeItem(bearer, listId, 'B')
    published = []

    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/bulk`, {
      action: 'update',
      itemIds: [a, b],
      patch: { customFields: { [budget.id]: 42 } },
    })
    expect(res.status).toBe(200)
    expect(published).toHaveLength(1)
    const items = await listItems(bearer, listId)
    for (const i of items) expect(i.custom_fields).toEqual({ [budget.id]: 42 })
  })

  it('rejects an empty update patch (400) and an empty itemIds array (400)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_bad`)
    const listId = await makeList(bearer)
    const a = await makeItem(bearer, listId, 'A')

    const emptyPatch = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/bulk`, {
      action: 'update',
      itemIds: [a],
      patch: {},
    })
    expect(emptyPatch.status).toBe(400)

    const emptyIds = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/bulk`, {
      action: 'delete',
      itemIds: [],
    })
    expect(emptyIds.status).toBe(400)
  })
})
