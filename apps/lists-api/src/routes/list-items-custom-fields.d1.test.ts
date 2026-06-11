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

// D1 integration tests for typed custom-field VALUES on list items.
// Replaces list-items-custom-fields.it.test.ts.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — item custom-field values', () => {
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

  async function makeField(
    bearer: string,
    listId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/fields`, body)
    expect(res.status).toBe(201)
    return (await res.json()) as Record<string, unknown>
  }

  it('round-trips custom-field values on create and exposes them on GET', async () => {
    const bearer = await loginAs(`user_${Date.now()}_rt`)
    const listId = await makeList(bearer)
    const budget = await makeField(bearer, listId, { label: 'Budget', fieldType: 'number' })
    const store = (await makeField(bearer, listId, {
      label: 'Store',
      fieldType: 'single_select',
      choices: [{ label: 'Costco' }, { label: 'Target' }],
    })) as { id: string; options: { choices: Array<{ id: string }> } }
    const costcoId = store.options.choices[0]!.id

    const created = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Bulk paper towels',
      customFields: { [budget.id as string]: 25, [store.id]: costcoId },
    })
    expect(created.status).toBe(201)
    const item = (await created.json()) as { id: string; custom_fields: Record<string, unknown> }
    expect(item.custom_fields).toEqual({ [budget.id as string]: 25, [store.id]: costcoId })

    const listed = (await (await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/items`)).json()) as {
      items: Array<{ id: string; custom_fields: Record<string, unknown> }>
    }
    expect(listed.items.find((i) => i.id === item.id)!.custom_fields).toEqual({
      [budget.id as string]: 25,
      [store.id]: costcoId,
    })
  })

  it('merges a PATCH onto existing values and clears a key with null', async () => {
    const bearer = await loginAs(`user_${Date.now()}_patch`)
    const listId = await makeList(bearer)
    const budget = await makeField(bearer, listId, { label: 'Budget', fieldType: 'number' })
    const note = await makeField(bearer, listId, { label: 'Memo', fieldType: 'text' })

    const item = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Thing',
      customFields: { [budget.id as string]: 10, [note.id as string]: 'hi' },
    })).json()) as { id: string }

    // Patch budget only — memo must survive (shallow merge).
    const patched = (await (await req(
      bearer,
      'PATCH',
      `/api/v1/ui/lists/${listId}/items/${item.id}`,
      { customFields: { [budget.id as string]: 99 } },
    )).json()) as { custom_fields: Record<string, unknown> }
    expect(patched.custom_fields).toEqual({ [budget.id as string]: 99, [note.id as string]: 'hi' })

    // Clear memo with null.
    const cleared = (await (await req(
      bearer,
      'PATCH',
      `/api/v1/ui/lists/${listId}/items/${item.id}`,
      { customFields: { [note.id as string]: null } },
    )).json()) as { custom_fields: Record<string, unknown> }
    expect(cleared.custom_fields).toEqual({ [budget.id as string]: 99 })
  })

  it('rejects a value of the wrong type (400)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_badtype`)
    const listId = await makeList(bearer)
    const budget = await makeField(bearer, listId, { label: 'Budget', fieldType: 'number' })
    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Bad',
      customFields: { [budget.id as string]: 'not a number' },
    })
    expect(res.status).toBe(400)
  })

  it('rejects a missing required field on create (400)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_req`)
    const listId = await makeList(bearer)
    await makeField(bearer, listId, { label: 'Owner', fieldType: 'text', required: true })
    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, { title: 'No owner' })
    expect(res.status).toBe(400)
  })

  it('rejects an archived select option in a new value (400)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_arch`)
    const listId = await makeList(bearer)
    const store = (await makeField(bearer, listId, {
      label: 'Store',
      fieldType: 'single_select',
      choices: [{ label: 'Costco' }, { label: 'Target' }],
    })) as { id: string; options: { choices: Array<{ id: string }> } }
    const targetId = store.options.choices[1]!.id
    // Archive Target.
    await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/fields/${store.id}`, {
      choices: [{ id: targetId, label: 'Target', archived: true }],
    })
    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'At Target',
      customFields: { [store.id]: targetId },
    })
    expect(res.status).toBe(400)
  })

  it('rejects an unknown field key (400)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_unknown`)
    const listId = await makeList(bearer)
    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Ghost',
      customFields: { lfd_does_not_exist: 'x' },
    })
    expect(res.status).toBe(400)
  })

  it('rejects clearing a required field via PATCH null (400)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_reqpatch`)
    const listId = await makeList(bearer)
    const owner = await makeField(bearer, listId, { label: 'Owner', fieldType: 'text', required: true })

    const item = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Owned',
      customFields: { [owner.id as string]: 'alice' },
    })).json()) as { id: string }

    const res = await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/items/${item.id}`, {
      customFields: { [owner.id as string]: null },
    })
    expect(res.status).toBe(400)
  })

  it('clears custom_fields when an item is moved to another list', async () => {
    const bearer = await loginAs(`user_${Date.now()}_move`)
    const sourceId = await makeList(bearer)
    const targetId = await makeList(bearer)
    const budget = await makeField(bearer, sourceId, { label: 'Budget', fieldType: 'number' })

    const item = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${sourceId}/items`, {
      title: 'Movable',
      customFields: { [budget.id as string]: 7 },
    })).json()) as { id: string; custom_fields: Record<string, unknown> }
    expect(item.custom_fields).toEqual({ [budget.id as string]: 7 })

    const moved = (await (await req(
      bearer,
      'PATCH',
      `/api/v1/ui/lists/${sourceId}/items/${item.id}`,
      { listId: targetId },
    )).json()) as { custom_fields: Record<string, unknown> }
    expect(moved.custom_fields).toEqual({})
  })
})
