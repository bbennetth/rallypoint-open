import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import { ulid } from 'ulid'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { Repos } from '../repos/types.js'
import type { HonoApp } from '../context.js'
import type { Services } from '../services/types.js'
import type { ListDto } from '../../../../packages/lists-client/src/index.js'

// D1 integration tests for the SDK planner-pref surface.

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

describe('D1 integration — SDK planner-pref surface', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services, realtime: undefined })
  })

  function sdkHeaders(actor: string): Record<string, string> {
    return {
      authorization: `Bearer ${envVars.PLANNER_API_KEY!}`,
      'x-actor': actor,
      'content-type': 'application/json',
    }
  }

  async function createGroupFor(actor: string, name = 'Personal'): Promise<string> {
    const res = await app.request('http://localhost/api/v1/sdk/groups', {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ name }),
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as Record<string, unknown>).id as string
  }

  async function createTasksList(actor: string, groupId: string, name = 'My tasks'): Promise<string> {
    const res = await app.request('http://localhost/api/v1/sdk/lists', {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ name, listType: 'tasks', scopeType: 'list_group', scopeId: groupId }),
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as Record<string, unknown>).id as string
  }

  // --- PUT /sdk/lists/:listId/planner-pref --------------------------

  it('returns 204 when a member sets planner-pref', async () => {
    const actor = `user_${ulid()}`
    const groupId = await createGroupFor(actor)
    const listId = await createTasksList(actor, groupId)

    const res = await app.request(
      `http://localhost/api/v1/sdk/lists/${listId}/planner-pref`,
      {
        method: 'PUT',
        headers: sdkHeaders(actor),
        body: JSON.stringify({ show: true }),
      },
    )
    expect(res.status).toBe(204)
  })

  it('404s when a non-member actor tries to set planner-pref', async () => {
    const owner = `user_${ulid()}`
    const intruder = `user_${ulid()}`
    const groupId = await createGroupFor(owner)
    const listId = await createTasksList(owner, groupId)

    const res = await app.request(
      `http://localhost/api/v1/sdk/lists/${listId}/planner-pref`,
      {
        method: 'PUT',
        headers: sdkHeaders(intruder),
        body: JSON.stringify({ show: true }),
      },
    )
    expect(res.status).toBe(404)
  })

  // --- GET /sdk/planner-lists ---------------------------------------

  it('returns flagged list as ListDto after setting planner-pref', async () => {
    const actor = `user_${ulid()}`
    const groupId = await createGroupFor(actor)
    const listId = await createTasksList(actor, groupId, 'Flagged list')

    // Set the pref first.
    const putRes = await app.request(
      `http://localhost/api/v1/sdk/lists/${listId}/planner-pref`,
      {
        method: 'PUT',
        headers: sdkHeaders(actor),
        body: JSON.stringify({ show: true }),
      },
    )
    expect(putRes.status).toBe(204)

    const getRes = await app.request('http://localhost/api/v1/sdk/planner-lists', {
      headers: sdkHeaders(actor),
    })
    expect(getRes.status).toBe(200)
    const body = (await getRes.json()) as ListDto[]
    const found = body.find((l) => l.id === listId)
    expect(found).toBeDefined()
    expect(found!.name).toBe('Flagged list')
    expect(typeof found!.incompleteCount).toBe('number')
  })

  it("GET /sdk/planner-lists does not include another actor's flagged list", async () => {
    const actorA = `user_${ulid()}`
    const actorB = `user_${ulid()}`
    const groupA = await createGroupFor(actorA)
    const listIdA = await createTasksList(actorA, groupA, "A's list")

    // A flags their list.
    await app.request(`http://localhost/api/v1/sdk/lists/${listIdA}/planner-pref`, {
      method: 'PUT',
      headers: sdkHeaders(actorA),
      body: JSON.stringify({ show: true }),
    })

    // B's planner-lists should be empty (no pref set for B).
    const res = await app.request('http://localhost/api/v1/sdk/planner-lists', {
      headers: sdkHeaders(actorB),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as ListDto[]
    expect(body.find((l) => l.id === listIdA)).toBeUndefined()
  })

  it('GET /sdk/planner-lists silently drops a list the actor lost access to', async () => {
    const actor = `user_${ulid()}`
    const groupId = await createGroupFor(actor)
    const listId = await createTasksList(actor, groupId, 'Soon deleted')

    // Flag it.
    await app.request(`http://localhost/api/v1/sdk/lists/${listId}/planner-pref`, {
      method: 'PUT',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ show: true }),
    })

    // Soft-delete the list via the SDK delete route.
    const delRes = await app.request(
      `http://localhost/api/v1/sdk/lists/${listId}`,
      {
        method: 'DELETE',
        headers: sdkHeaders(actor),
      },
    )
    expect(delRes.status).toBe(204)

    // Planner-lists should not include the deleted list.
    const getRes = await app.request('http://localhost/api/v1/sdk/planner-lists', {
      headers: sdkHeaders(actor),
    })
    expect(getRes.status).toBe(200)
    const body = (await getRes.json()) as ListDto[]
    expect(body.find((l) => l.id === listId)).toBeUndefined()
  })

  // --- batch fetch: multiple flagged lists, incl. soft-deleted -------

  it('GET /sdk/planner-lists returns only live accessible lists when multiple are flagged', async () => {
    const actor = `user_${ulid()}`
    const groupId = await createGroupFor(actor)

    // Create three lists and flag them all.
    const liveId1 = await createTasksList(actor, groupId, 'Live list 1')
    const liveId2 = await createTasksList(actor, groupId, 'Live list 2')
    const softDeletedId = await createTasksList(actor, groupId, 'Soon to be deleted')

    for (const id of [liveId1, liveId2, softDeletedId]) {
      await app.request(`http://localhost/api/v1/sdk/lists/${id}/planner-pref`, {
        method: 'PUT',
        headers: sdkHeaders(actor),
        body: JSON.stringify({ show: true }),
      })
    }

    // Soft-delete the third list.
    const delRes = await app.request(
      `http://localhost/api/v1/sdk/lists/${softDeletedId}`,
      { method: 'DELETE', headers: sdkHeaders(actor) },
    )
    expect(delRes.status).toBe(204)

    // GET planner-lists: only the two live lists should appear.
    const getRes = await app.request('http://localhost/api/v1/sdk/planner-lists', {
      headers: sdkHeaders(actor),
    })
    expect(getRes.status).toBe(200)
    const body = (await getRes.json()) as ListDto[]
    const returnedIds = body.map((l) => l.id)
    expect(returnedIds).toContain(liveId1)
    expect(returnedIds).toContain(liveId2)
    expect(returnedIds).not.toContain(softDeletedId)
  })

  it('GET /sdk/planner-lists drops a list the actor lost access to (non-member)', async () => {
    const owner = `user_${ulid()}`
    const intruder = `user_${ulid()}`
    const groupId = await createGroupFor(owner)

    // Owner creates and flags a list.
    const ownerListId = await createTasksList(owner, groupId, 'Owner list')
    await app.request(`http://localhost/api/v1/sdk/lists/${ownerListId}/planner-pref`, {
      method: 'PUT',
      headers: sdkHeaders(owner),
      body: JSON.stringify({ show: true }),
    })

    // Intruder creates their own group/list and flags both their list and
    // the owner's. The owner's list should not appear because access re-check
    // (loadListForActor) will reject it.
    const intruderGroupId = await createGroupFor(intruder)
    const intruderListId = await createTasksList(intruder, intruderGroupId, 'Intruder list')
    await app.request(`http://localhost/api/v1/sdk/lists/${intruderListId}/planner-pref`, {
      method: 'PUT',
      headers: sdkHeaders(intruder),
      body: JSON.stringify({ show: true }),
    })

    // Intruder only sees their own list.
    const getRes = await app.request('http://localhost/api/v1/sdk/planner-lists', {
      headers: sdkHeaders(intruder),
    })
    expect(getRes.status).toBe(200)
    const body = (await getRes.json()) as ListDto[]
    expect(body.find((l) => l.id === intruderListId)).toBeDefined()
    expect(body.find((l) => l.id === ownerListId)).toBeUndefined()
  })

  it('400s on missing x-actor header', async () => {
    const res = await app.request(
      'http://localhost/api/v1/sdk/lists/lst_fake/planner-pref',
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${envVars.PLANNER_API_KEY!}`, 'content-type': 'application/json' },
        body: JSON.stringify({ show: true }),
      },
    )
    expect(res.status).toBe(400)
  })
})
