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

// D1 integration tests for the ref-bearing list-item + idempotency
// surface (offline-retry-safe create — mirrors money-api's
// expense-ref-idempotency.d1.test.ts).

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — list item ref + idempotent create', () => {
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
      origin: envVars.LISTS_UI_ORIGIN,
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

  // Creates a group + a list in it, returning the list id.
  async function makeList(bearer: string): Promise<string> {
    const groupRes = await req(bearer, 'POST', '/api/v1/ui/groups', {
      name: `Group ${Date.now()}_${Math.random().toString(36).slice(2)}`,
    })
    const groupId = ((await groupRes.json()) as { id: string }).id
    const listRes = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'List',
      listType: 'standard',
      scopeType: 'list_group',
      scopeId: groupId,
    })
    expect(listRes.status).toBe(201)
    return ((await listRes.json()) as { id: string }).id
  }

  const itemPayload = (overrides: Record<string, unknown> = {}) => ({
    title: 'Cascade test',
    ...overrides,
  })

  it('persists ref on create and echoes it back', async () => {
    const bearer = await loginAs(`user_${Date.now()}_ref_owner`)
    const listId = await makeList(bearer)

    const res = await req(
      bearer,
      'POST',
      `/api/v1/ui/lists/${listId}/items`,
      itemPayload({ ref: 'lists:purchase:abc123' }),
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; ref: string; idempotent?: boolean }
    expect(body.id).toMatch(/^lit_/)
    expect(body.ref).toBe('lists:purchase:abc123')
    expect(body.idempotent).toBeUndefined()
  })

  it('replay with the same (list_id, ref) returns the existing row (200, idempotent:true)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_idem_owner`)
    const listId = await makeList(bearer)

    const first = (await (await req(
      bearer,
      'POST',
      `/api/v1/ui/lists/${listId}/items`,
      itemPayload({ ref: 'cascade:42', title: 'First' }),
    )).json()) as { id: string }

    const replayRes = await req(
      bearer,
      'POST',
      `/api/v1/ui/lists/${listId}/items`,
      itemPayload({ ref: 'cascade:42', title: 'Second' }),
    )
    expect(replayRes.status).toBe(200)
    const replay = (await replayRes.json()) as { id: string; title: string; idempotent: boolean }
    expect(replay.id).toBe(first.id)
    expect(replay.idempotent).toBe(true)
    // The original title wins — the second body's `title` is ignored.
    // Ref pins the first writer.
    expect(replay.title).toBe('First')

    const list = (await (
      await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/items`)
    ).json()) as { items: unknown[] }
    expect(list.items).toHaveLength(1)
  })

  it('different refs in the same list create distinct rows', async () => {
    const bearer = await loginAs(`user_${Date.now()}_distinct_owner`)
    const listId = await makeList(bearer)

    await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, itemPayload({ ref: 'a' }))
    await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, itemPayload({ ref: 'b' }))

    const list = (await (
      await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/items`)
    ).json()) as { items: unknown[] }
    expect(list.items).toHaveLength(2)
  })

  it('same ref in two different lists does NOT collide (scoped per list)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_scoped_owner`)
    const listA = await makeList(bearer)
    const listB = await makeList(bearer)

    const a = await req(bearer, 'POST', `/api/v1/ui/lists/${listA}/items`, itemPayload({ ref: 'shared' }))
    const b = await req(bearer, 'POST', `/api/v1/ui/lists/${listB}/items`, itemPayload({ ref: 'shared' }))
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
  })

  it('items without a ref are unconstrained — same body twice creates two rows', async () => {
    const bearer = await loginAs(`user_${Date.now()}_noref_owner`)
    const listId = await makeList(bearer)

    await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, itemPayload())
    await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, itemPayload())

    const list = (await (
      await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/items`)
    ).json()) as { items: unknown[] }
    expect(list.items).toHaveLength(2)
  })

  it('after soft-delete, the ref is reserved — POST with the same ref returns 409', async () => {
    const bearer = await loginAs(`user_${Date.now()}_tomb_owner`)
    const listId = await makeList(bearer)

    const created = (await (await req(
      bearer,
      'POST',
      `/api/v1/ui/lists/${listId}/items`,
      itemPayload({ ref: 'doomed' }),
    )).json()) as { id: string }
    expect(
      (await req(bearer, 'DELETE', `/api/v1/ui/lists/${listId}/items/${created.id}`)).status,
    ).toBe(204)

    const replay = await req(
      bearer,
      'POST',
      `/api/v1/ui/lists/${listId}/items`,
      itemPayload({ ref: 'doomed' }),
    )
    expect(replay.status).toBe(409)
    const body = (await replay.json()) as { error: { code: string; details: Record<string, unknown> } }
    expect(body.error.code).toBe('item_ref_taken_by_deleted')
    expect(body.error.details.item_id).toBe(created.id)
    expect(body.error.details.ref).toBe('doomed')
    expect(typeof body.error.details.deleted_at).toBe('string')
  })

  it('rejects an empty-string ref at the validator boundary', async () => {
    const bearer = await loginAs(`user_${Date.now()}_empty_owner`)
    const listId = await makeList(bearer)

    const res = await req(
      bearer,
      'POST',
      `/api/v1/ui/lists/${listId}/items`,
      itemPayload({ ref: '   ' }),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation_failed')
  })
})
