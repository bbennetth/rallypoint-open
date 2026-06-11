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

// D1 integration tests asserting each Lists mutation publishes the expected
// realtime envelope. Replaces realtime.it.test.ts.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

interface Published {
  channel: string
  env: RealtimeEnvelope
}

describe('D1 integration — realtime publishing', () => {
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
    opts: { listType?: string; visibility?: string; scopeId?: string } = {},
  ): Promise<{ id: string; scopeId: string }> {
    let scopeId = opts.scopeId
    if (!scopeId) {
      // #128: create a real list_group so loadListForRead's membership
      // check passes for the owner. Tests that need a specific scope_id
      // still pass it in via opts.scopeId.
      const groupRes = await req(bearer, 'POST', '/api/v1/ui/groups', {
        name: `Group ${Date.now()}_${Math.random().toString(36).slice(2)}`,
      })
      expect(groupRes.status).toBe(201)
      scopeId = ((await groupRes.json()) as { id: string }).id
    }
    const res = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'Tasks',
      listType: opts.listType ?? 'tasks',
      scopeType: 'list_group',
      scopeId,
      ...(opts.visibility ? { visibility: opts.visibility } : {}),
    })
    expect(res.status).toBe(201)
    return { id: ((await res.json()) as { id: string }).id, scopeId }
  }

  it('publishes a lists/create on the scope channel when a list is made', async () => {
    const userId = `user_${Date.now()}_listcreate`
    const bearer = await loginAs(userId)
    const { id, scopeId } = await makeList(bearer)

    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      channel: `lists:scope:list_group:${scopeId}`,
      env: {
        resource: 'lists',
        operation: 'create',
        payload: { id },
        authorId: userId,
      },
    })
  })

  it('does NOT publish to the scope channel when a private list is created (#128)', async () => {
    // Private lists must not leak their existence over the scope SSE
    // stream — non-shared scope members would otherwise see the new
    // list's id. Their own list-channel envelopes still work after
    // the share recipient subscribes.
    const userId = `user_${Date.now()}_privatelist`
    const bearer = await loginAs(userId)
    published = []
    await makeList(bearer, { visibility: 'private' })
    expect(published).toHaveLength(0)
  })

  it('publishes a list_items/create on the list channel when an item is added', async () => {
    const userId = `user_${Date.now()}_itemcreate`
    const bearer = await loginAs(userId)
    const { id: listId } = await makeList(bearer)
    published = []

    const item = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Pitch tent',
    })).json()) as { id: string }

    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      channel: `lists:list:${listId}`,
      env: { resource: 'list_items', operation: 'create', payload: { id: item.id }, authorId: userId },
    })
  })

  it('publishes a list_items/update on a check-off', async () => {
    const userId = `user_${Date.now()}_itemupdate`
    const bearer = await loginAs(userId)
    const { id: listId } = await makeList(bearer)
    const item = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Buy ice',
    })).json()) as { id: string }
    published = []

    await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/items/${item.id}`, { completed: true })

    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      channel: `lists:list:${listId}`,
      env: { resource: 'list_items', operation: 'update', payload: { id: item.id }, authorId: userId },
    })
  })

  it('publishes a list_items/delete on soft-delete', async () => {
    const userId = `user_${Date.now()}_itemdelete`
    const bearer = await loginAs(userId)
    const { id: listId } = await makeList(bearer)
    const item = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Temp',
    })).json()) as { id: string }
    published = []

    await req(bearer, 'DELETE', `/api/v1/ui/lists/${listId}/items/${item.id}`)

    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      channel: `lists:list:${listId}`,
      env: { resource: 'list_items', operation: 'delete', payload: { id: item.id }, authorId: userId },
    })
  })

  it('publishes a list_items/create on restore', async () => {
    const userId = `user_${Date.now()}_itemrestore`
    const bearer = await loginAs(userId)
    const { id: listId } = await makeList(bearer)
    const item = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Restore me',
    })).json()) as { id: string }
    await req(bearer, 'DELETE', `/api/v1/ui/lists/${listId}/items/${item.id}`)
    published = []

    await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/${item.id}/restore`)

    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      channel: `lists:list:${listId}`,
      env: { resource: 'list_items', operation: 'create', payload: { id: item.id }, authorId: userId },
    })
  })

  it('publishes to both source and target list channels on a cross-list move', async () => {
    const userId = `user_${Date.now()}_itemmove`
    const bearer = await loginAs(userId)
    const { id: source } = await makeList(bearer, { listType: 'tasks' })
    const { id: target } = await makeList(bearer, { listType: 'tasks' })
    const item = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${source}/items`, {
      title: 'Relocate',
    })).json()) as { id: string }
    published = []

    await req(bearer, 'PATCH', `/api/v1/ui/lists/${source}/items/${item.id}`, { listId: target })

    expect(published).toHaveLength(2)
    const channels = published.map((p) => p.channel)
    expect(channels).toContain(`lists:list:${source}`)
    expect(channels).toContain(`lists:list:${target}`)
    for (const p of published) {
      expect(p.env).toMatchObject({
        resource: 'list_items',
        operation: 'update',
        payload: { id: item.id },
        authorId: userId,
      })
    }
  })

  it('does not publish on a no-op self-move', async () => {
    const userId = `user_${Date.now()}_selfmove`
    const bearer = await loginAs(userId)
    const { id: listId } = await makeList(bearer, { listType: 'tasks' })
    const item = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Stay put',
    })).json()) as { id: string }
    published = []

    await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/items/${item.id}`, { listId })

    expect(published).toHaveLength(0)
  })
})
