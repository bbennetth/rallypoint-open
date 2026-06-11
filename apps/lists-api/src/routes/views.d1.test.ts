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

// D1 integration tests for the saved-view surface. Replaces views.it.test.ts.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — list views', () => {
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

  async function makeList(bearer: string): Promise<{ listId: string; groupId: string }> {
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
    return { listId: ((await listRes.json()) as { id: string }).id, groupId }
  }

  it('creates a view with a config and lists it back', async () => {
    const bearer = await loginAs(`user_${Date.now()}_creator`)
    const { listId } = await makeList(bearer)

    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/views`, {
      name: 'High budget',
      config: {
        filters: [{ field: 'lfd_budget', op: 'gte', value: '100' }],
        sort: [{ field: 'title', dir: 'asc' }],
        visibleColumns: ['title', 'lfd_budget'],
        viewMode: 'grid',
      },
    })
    expect(res.status).toBe(201)
    const view = (await res.json()) as {
      id: string
      name: string
      position: number
      config: { filters: unknown[]; viewMode: string }
    }
    expect(view.id).toMatch(/^lvw_/)
    expect(view.name).toBe('High budget')
    expect(view.position).toBe(0)
    expect(view.config.filters).toEqual([{ field: 'lfd_budget', op: 'gte', value: '100' }])
    expect(view.config.viewMode).toBe('grid')

    const listed = (await (await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/views`)).json()) as {
      items: Array<Record<string, unknown>>
    }
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]!.id).toBe(view.id)
  })

  it('defaults config to the empty view when omitted', async () => {
    const bearer = await loginAs(`user_${Date.now()}_empty`)
    const { listId } = await makeList(bearer)
    const view = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/views`, {
      name: 'Default',
    })).json()) as { config: Record<string, unknown> }
    expect(view.config).toEqual({ filters: [], sort: [], visibleColumns: [], viewMode: 'list' })
  })

  it('rejects an invalid op in the config (400)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_badop`)
    const { listId } = await makeList(bearer)
    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/views`, {
      name: 'Bad',
      config: { filters: [{ field: 'title', op: 'bogus', value: 'x' }] },
    })
    expect(res.status).toBe(400)
  })

  it('renames and reconfigures a view via PATCH', async () => {
    const bearer = await loginAs(`user_${Date.now()}_edit`)
    const { listId } = await makeList(bearer)
    const view = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/views`, {
      name: 'Old name',
    })).json()) as { id: string }

    const patched = (await (await req(
      bearer,
      'PATCH',
      `/api/v1/ui/lists/${listId}/views/${view.id}`,
      { name: 'New name', config: { viewMode: 'grid' } },
    )).json()) as { name: string; config: { viewMode: string } }
    expect(patched.name).toBe('New name')
    expect(patched.config.viewMode).toBe('grid')
  })

  it('rejects an empty PATCH (400)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_emptypatch`)
    const { listId } = await makeList(bearer)
    const view = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/views`, {
      name: 'V',
    })).json()) as { id: string }
    const res = await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/views/${view.id}`, {})
    expect(res.status).toBe(400)
  })

  it('soft-deletes a view and orders the rest by position', async () => {
    const bearer = await loginAs(`user_${Date.now()}_del`)
    const { listId } = await makeList(bearer)
    const a = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/views`, {
      name: 'A',
    })).json()) as { id: string; position: number }
    const b = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/views`, {
      name: 'B',
    })).json()) as { id: string; position: number }
    expect(a.position).toBe(0)
    expect(b.position).toBe(1)

    const delRes = await req(bearer, 'DELETE', `/api/v1/ui/lists/${listId}/views/${a.id}`)
    expect(delRes.status).toBe(204)

    const listed = (await (await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/views`)).json()) as {
      items: Array<{ id: string }>
    }
    expect(listed.items.map((v) => v.id)).toEqual([b.id])
  })

  it('forbids a non-creator member from saving a view (403) but allows read', async () => {
    const owner = `user_${Date.now()}_o`
    const ownerBearer = await loginAs(owner)
    const { listId, groupId } = await makeList(ownerBearer)

    const member = `user_${Date.now()}_m`
    await repos.groups.addMember({
      id: `lgm_test_${Date.now()}`,
      groupId,
      userId: member,
      role: 'member',
    })
    const memberBearer = await loginAs(member)

    const getRes = await req(memberBearer, 'GET', `/api/v1/ui/lists/${listId}/views`)
    expect(getRes.status).toBe(200)

    const postRes = await req(memberBearer, 'POST', `/api/v1/ui/lists/${listId}/views`, {
      name: 'Sneaky',
    })
    expect(postRes.status).toBe(403)
    expect(((await postRes.json()) as { error: { code: string } }).error.code).toBe('forbidden')

    const view = (await (await req(ownerBearer, 'POST', `/api/v1/ui/lists/${listId}/views`, {
      name: 'OwnerView',
    })).json()) as { id: string }
    const patchRes = await req(memberBearer, 'PATCH', `/api/v1/ui/lists/${listId}/views/${view.id}`, {
      name: 'Hijack',
    })
    expect(patchRes.status).toBe(403)
    const delRes = await req(memberBearer, 'DELETE', `/api/v1/ui/lists/${listId}/views/${view.id}`)
    expect(delRes.status).toBe(403)
  })

  it('404s a view that belongs to a different list', async () => {
    const bearer = await loginAs(`user_${Date.now()}_iso`)
    const a = await makeList(bearer)
    const b = await makeList(bearer)
    const view = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${a.listId}/views`, {
      name: 'OnlyOnA',
    })).json()) as { id: string }

    const res = await req(bearer, 'PATCH', `/api/v1/ui/lists/${b.listId}/views/${view.id}`, {
      name: 'Hijack',
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('view_not_found')
  })

  it('hides the view surface from a non-member (404 on the list)', async () => {
    const ownerBearer = await loginAs(`user_${Date.now()}_priv`)
    const { listId } = await makeList(ownerBearer)
    const strangerBearer = await loginAs(`user_${Date.now()}_stranger`)
    const res = await req(strangerBearer, 'GET', `/api/v1/ui/lists/${listId}/views`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('list_not_found')
  })
})
