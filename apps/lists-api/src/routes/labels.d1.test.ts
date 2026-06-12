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

// D1 integration tests for the labels surface (RPL v1.0.0 slice 12):
// label CRUD + ordering; set labels on item create; see them in the list
// response label_ids; replace labels via PATCH; reject unknown/cross-list
// label ids on an item (400); deleting a label removes it from items;
// soft-deleted labels don't appear in the labels list.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

type Label = {
  id: string
  list_id: string
  name: string
  color: string | null
  position: number
  created_at: string
  updated_at: string
}
type Item = {
  id: string
  label_ids: string[]
}

describe('D1 integration — labels', () => {
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

  // Create a standard list scoped to a new group.
  async function makeStandardList(bearer: string): Promise<string> {
    const groupRes = await req(bearer, 'POST', '/api/v1/ui/groups', {
      name: `Group ${Date.now()}_${Math.random().toString(36).slice(2)}`,
    })
    const groupId = ((await groupRes.json()) as { id: string }).id
    const listRes = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'My list',
      listType: 'standard',
      scopeType: 'list_group',
      scopeId: groupId,
    })
    expect(listRes.status).toBe(201)
    return ((await listRes.json()) as { id: string }).id
  }

  async function getLabels(bearer: string, listId: string): Promise<Label[]> {
    const res = await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/labels`)
    expect(res.status).toBe(200)
    return ((await res.json()) as { items: Label[] }).items
  }

  async function createLabel(
    bearer: string,
    listId: string,
    body: { name: string; color?: string; position?: number },
  ): Promise<Label> {
    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/labels`, body)
    expect(res.status).toBe(201)
    return res.json() as Promise<Label>
  }

  it('creates a label and returns it in the list', async () => {
    const bearer = await loginAs(`user_${Date.now()}_lbl_create`)
    const listId = await makeStandardList(bearer)

    const label = await createLabel(bearer, listId, { name: 'Bug', color: '#f00' })
    expect(label.id).toMatch(/^lbl_/)
    expect(label.list_id).toBe(listId)
    expect(label.name).toBe('Bug')
    expect(label.color).toBe('#f00')
    expect(label.position).toBe(0)

    const labels = await getLabels(bearer, listId)
    expect(labels).toHaveLength(1)
    expect(labels[0]!.id).toBe(label.id)
  })

  it('orders labels by position ascending', async () => {
    const bearer = await loginAs(`user_${Date.now()}_lbl_order`)
    const listId = await makeStandardList(bearer)

    // Create with explicit positions out of order.
    const c = await createLabel(bearer, listId, { name: 'C', position: 2 })
    const a = await createLabel(bearer, listId, { name: 'A', position: 0 })
    const b = await createLabel(bearer, listId, { name: 'B', position: 1 })

    const labels = await getLabels(bearer, listId)
    expect(labels.map((l) => l.id)).toEqual([a.id, b.id, c.id])
  })

  it('appends at position max+1 when position is omitted', async () => {
    const bearer = await loginAs(`user_${Date.now()}_lbl_append`)
    const listId = await makeStandardList(bearer)

    const first = await createLabel(bearer, listId, { name: 'First' })
    const second = await createLabel(bearer, listId, { name: 'Second' })
    expect(first.position).toBe(0)
    expect(second.position).toBe(1)
  })

  it('updates a label name and color', async () => {
    const bearer = await loginAs(`user_${Date.now()}_lbl_update`)
    const listId = await makeStandardList(bearer)
    const label = await createLabel(bearer, listId, { name: 'Old', color: '#aaa' })

    const patchRes = await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/labels/${label.id}`, {
      name: 'New',
      color: '#bbb',
    })
    expect(patchRes.status).toBe(200)
    const updated = (await patchRes.json()) as Label
    expect(updated.name).toBe('New')
    expect(updated.color).toBe('#bbb')
  })

  it('returns 400 when PATCH body has no fields', async () => {
    const bearer = await loginAs(`user_${Date.now()}_lbl_empty_patch`)
    const listId = await makeStandardList(bearer)
    const label = await createLabel(bearer, listId, { name: 'Label' })

    const res = await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/labels/${label.id}`, {})
    expect(res.status).toBe(400)
  })

  it('soft-deletes a label; it no longer appears in the list', async () => {
    const bearer = await loginAs(`user_${Date.now()}_lbl_delete`)
    const listId = await makeStandardList(bearer)
    const label = await createLabel(bearer, listId, { name: 'ToDelete' })

    const delRes = await req(bearer, 'DELETE', `/api/v1/ui/lists/${listId}/labels/${label.id}`)
    expect(delRes.status).toBe(204)

    const labels = await getLabels(bearer, listId)
    expect(labels.find((l) => l.id === label.id)).toBeUndefined()
  })

  it('attaches labels on item create and surfaces them in label_ids', async () => {
    const bearer = await loginAs(`user_${Date.now()}_lbl_item_create`)
    const listId = await makeStandardList(bearer)
    const labelA = await createLabel(bearer, listId, { name: 'A' })
    const labelB = await createLabel(bearer, listId, { name: 'B' })

    const itemRes = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Task with labels',
      labelIds: [labelA.id, labelB.id],
    })
    expect(itemRes.status).toBe(201)
    const item = (await itemRes.json()) as Item
    expect(item.label_ids.sort()).toEqual([labelA.id, labelB.id].sort())

    // Also visible in the list GET.
    const listRes = await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/items`)
    const items = ((await listRes.json()) as { items: Item[] }).items
    const found = items.find((i) => i.id === item.id)!
    expect(found.label_ids.sort()).toEqual([labelA.id, labelB.id].sort())
  })

  it('replaces the label set via item PATCH', async () => {
    const bearer = await loginAs(`user_${Date.now()}_lbl_item_patch`)
    const listId = await makeStandardList(bearer)
    const labelA = await createLabel(bearer, listId, { name: 'A' })
    const labelB = await createLabel(bearer, listId, { name: 'B' })
    const labelC = await createLabel(bearer, listId, { name: 'C' })

    const itemRes = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Item',
      labelIds: [labelA.id, labelB.id],
    })
    const item = (await itemRes.json()) as Item

    // Replace A+B with just C.
    const patchRes = await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/items/${item.id}`, {
      labelIds: [labelC.id],
    })
    expect(patchRes.status).toBe(200)
    const patched = (await patchRes.json()) as Item
    expect(patched.label_ids).toEqual([labelC.id])
  })

  it('rejects an unknown label id on item create (400)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_lbl_unknown_create`)
    const listId = await makeStandardList(bearer)

    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Item',
      labelIds: ['lbl_doesnotexist00000000000000'],
    })
    expect(res.status).toBe(400)
  })

  it('rejects a cross-list label id on item create (400)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_lbl_xlist`)
    const listId = await makeStandardList(bearer)
    const otherListId = await makeStandardList(bearer)

    // Create a label on the OTHER list.
    const foreignLabel = await createLabel(bearer, otherListId, { name: 'ForeignLabel' })

    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Item',
      labelIds: [foreignLabel.id],
    })
    expect(res.status).toBe(400)
  })

  it('deleting a label removes it from all items', async () => {
    const bearer = await loginAs(`user_${Date.now()}_lbl_del_from_items`)
    const listId = await makeStandardList(bearer)
    const label = await createLabel(bearer, listId, { name: 'ToRemove' })

    const itemRes = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Item',
      labelIds: [label.id],
    })
    const item = (await itemRes.json()) as Item
    expect(item.label_ids).toContain(label.id)

    // Delete the label.
    await req(bearer, 'DELETE', `/api/v1/ui/lists/${listId}/labels/${label.id}`)

    // The item's label_ids no longer includes the deleted label.
    const listRes = await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/items`)
    const items = ((await listRes.json()) as { items: Item[] }).items
    const found = items.find((i) => i.id === item.id)!
    expect(found.label_ids).not.toContain(label.id)
  })
})
