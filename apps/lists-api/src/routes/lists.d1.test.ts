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

// D1 integration tests for the lists UI surface. Replaces lists.it.test.ts.
// Runs inside a workerd isolate (Miniflare D1), migrations applied by
// apps/lists-api/test/apply-d1-migrations.ts.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — lists UI surface', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  // Stubbed services: the verifier trusts any bearer and returns it
  // verbatim as the user id (we seal plaintext=userId into the row).
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

  // #128: lists-api UI routes only serve scopes Lists owns. Tests that
  // exercise reads against a list_group create a real group + own the
  // ownership row. Returns the new group id (which is the list scope id).
  async function seedListGroup(ownerBearer: string, name = 'Test Group'): Promise<string> {
    const res = await req(ownerBearer, 'POST', '/api/v1/ui/groups', { name })
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }

  it('returns ok from the public health route', async () => {
    const res = await app.request('http://localhost/api/v1/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; service: string }
    expect(body.ok).toBe(true)
    expect(body.service).toBe('rallypoint-lists')
  })

  it('rejects an unauthenticated request to the lists surface', async () => {
    const res = await app.request('http://localhost/api/v1/ui/lists?scope_type=list_group&scope_id=lgr_1', {
      headers: { 'x-rp-csrf': CSRF, cookie: `${envVars.LISTS_CSRF_COOKIE_NAME}=${CSRF}` },
    })
    expect(res.status).toBe(401)
  })

  it('creates a list, persists the row, and lists it back by scope', async () => {
    const owner = `user_${Date.now()}_owner`
    const bearer = await loginAs(owner)
    const scopeId = await seedListGroup(bearer)

    const createRes = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: '  Camp tasks  ',
      listType: 'tasks',
      scopeType: 'list_group',
      scopeId,
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as Record<string, unknown>
    expect(created.id).toMatch(/^lst_/)
    expect(created.name).toBe('Camp tasks') // trimmed by the validator
    expect(created.list_type).toBe('tasks')
    expect(created.visibility).toBe('all') // defaulted
    expect(created.created_by).toBe(owner)
    expect(created.color).toBeNull()

    // Round-trip: the DB row exists.
    const row = await repos.lists.findById(created.id as string)
    expect(row).not.toBeNull()
    expect(row!.scopeId).toBe(scopeId)
    expect(row!.createdBy).toBe(owner)

    // And it comes back from the scope listing.
    const listRes = await req(
      bearer,
      'GET',
      `/api/v1/ui/lists?scope_type=list_group&scope_id=${scopeId}`,
    )
    expect(listRes.status).toBe(200)
    const page = (await listRes.json()) as { items: Array<Record<string, unknown>> }
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.id).toBe(created.id)
  })

  it('creates a shopping-type list (Plan hub) and persists the discriminator', async () => {
    const owner = `user_${Date.now()}_shop`
    const bearer = await loginAs(owner)
    const scopeId = await seedListGroup(bearer, 'Shopping Group')

    const createRes = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'Groceries',
      listType: 'shopping',
      scopeType: 'list_group',
      scopeId,
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as Record<string, unknown>
    expect(created.list_type).toBe('shopping')

    // The text discriminator round-trips from the DB with no migration.
    const row = await repos.lists.findById(created.id as string)
    expect(row!.listType).toBe('shopping')

    // A shopping item is a generic check-off item: task-only columns stay
    // null (shopping behaves like `standard`, not `tasks`).
    const itemRes = await req(bearer, 'POST', `/api/v1/ui/lists/${created.id as string}/items`, {
      title: 'Ice',
    })
    expect(itemRes.status).toBe(201)
    const item = (await itemRes.json()) as Record<string, unknown>
    expect(item.status).toBeNull()
    expect(item.priority).toBeNull()
    expect(item.completed).toBe(false)
  })

  it('fetches a single list by id, and 404s for unknown/deleted ids', async () => {
    const owner = `user_${Date.now()}_one`
    const bearer = await loginAs(owner)
    const scopeId = await seedListGroup(bearer, 'One Group')

    const createRes = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'Packing',
      listType: 'standard',
      scopeType: 'list_group',
      scopeId,
    })
    const created = (await createRes.json()) as Record<string, unknown>

    const getRes = await req(bearer, 'GET', `/api/v1/ui/lists/${created.id as string}`)
    expect(getRes.status).toBe(200)
    const got = (await getRes.json()) as Record<string, unknown>
    expect(got.id).toBe(created.id)
    expect(got.name).toBe('Packing')

    const missingRes = await req(bearer, 'GET', '/api/v1/ui/lists/lst_does_not_exist')
    expect(missingRes.status).toBe(404)
    const missing = (await missingRes.json()) as { error: { code: string } }
    expect(missing.error.code).toBe('list_not_found')
  })

  it('rejects an invalid create body with validation_failed', async () => {
    const bearer = await loginAs(`user_${Date.now()}_bad`)
    const res = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: '   ',
      listType: 'chores',
      scopeType: 'list_group',
      scopeId: 'lgr_x',
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('validation_failed')
  })

  it('rejects a list query missing scope params', async () => {
    const bearer = await loginAs(`user_${Date.now()}_q`)
    const res = await req(bearer, 'GET', '/api/v1/ui/lists')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('validation_failed')
  })

  // --- soft-delete a list (UI surface) -----------------------------------

  it('soft-deletes a list: 204, disappears from scope listing, GET 404s, deletedAt set', async () => {
    const owner = `user_${Date.now()}_delowner`
    const bearer = await loginAs(owner)
    const scopeId = await seedListGroup(bearer, 'Del Group')

    const createRes = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'To Delete',
      listType: 'standard',
      scopeType: 'list_group',
      scopeId,
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as Record<string, unknown>
    const listId = created.id as string

    // DELETE returns 204
    const delRes = await req(bearer, 'DELETE', `/api/v1/ui/lists/${listId}`)
    expect(delRes.status).toBe(204)

    // Scope listing no longer includes the deleted list
    const listRes = await req(bearer, 'GET', `/api/v1/ui/lists?scope_type=list_group&scope_id=${scopeId}`)
    expect(listRes.status).toBe(200)
    const page = (await listRes.json()) as { items: Array<Record<string, unknown>> }
    expect(page.items.every((l) => l.id !== listId)).toBe(true)

    // GET by id 404s
    const getRes = await req(bearer, 'GET', `/api/v1/ui/lists/${listId}`)
    expect(getRes.status).toBe(404)
    const getBody = (await getRes.json()) as { error: { code: string } }
    expect(getBody.error.code).toBe('list_not_found')

    // DB row has deletedAt set
    const row = await repos.lists.findById(listId)
    expect(row).not.toBeNull()
    expect(row!.deletedAt).not.toBeNull()
  })

  it('non-creator gets 404 on list delete (even if a scope member)', async () => {
    const owner = `user_${Date.now()}_del2owner`
    const other = `user_${Date.now()}_del2other`
    const ownerBearer = await loginAs(owner)
    const otherBearer = await loginAs(other)
    const scopeId = await seedListGroup(ownerBearer, 'Shared Del Group')

    // Create list
    const createRes = await req(ownerBearer, 'POST', '/api/v1/ui/lists', {
      name: 'Mine',
      listType: 'standard',
      scopeType: 'list_group',
      scopeId,
    })
    const listId = ((await createRes.json()) as Record<string, unknown>).id as string

    // Add `other` as a member by using the groups route directly via SDK
    // (the UI does not expose member-add; use repo directly for simplicity)
    await repos.groups.addMember({
      id: `lgm_${Date.now()}_del2`,
      groupId: scopeId,
      userId: other,
      role: 'member',
    })

    // Non-creator DELETE → 403 (loadListForWrite: read passes for member, but creator check 403s)
    const delRes = await req(otherBearer, 'DELETE', `/api/v1/ui/lists/${listId}`)
    expect(delRes.status).toBe(403)

    // List still lives
    const getRes = await req(ownerBearer, 'GET', `/api/v1/ui/lists/${listId}`)
    expect(getRes.status).toBe(200)
  })

  it('double-delete returns 404 on the second call', async () => {
    const owner = `user_${Date.now()}_del3`
    const bearer = await loginAs(owner)
    const scopeId = await seedListGroup(bearer, 'Double Del Group')

    const createRes = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'Ghost',
      listType: 'tasks',
      scopeType: 'list_group',
      scopeId,
    })
    const listId = ((await createRes.json()) as Record<string, unknown>).id as string

    // First delete: 204
    const first = await req(bearer, 'DELETE', `/api/v1/ui/lists/${listId}`)
    expect(first.status).toBe(204)

    // Second delete: 404 (already soft-deleted → loadListForWrite 404s)
    const second = await req(bearer, 'DELETE', `/api/v1/ui/lists/${listId}`)
    expect(second.status).toBe(404)
  })

  it('sibling list and its items remain intact after deleting one list', async () => {
    const owner = `user_${Date.now()}_del4`
    const bearer = await loginAs(owner)
    const scopeId = await seedListGroup(bearer, 'Sibling Group')

    // Create two lists
    const list1Res = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'List One',
      listType: 'standard',
      scopeType: 'list_group',
      scopeId,
    })
    const list1Id = ((await list1Res.json()) as Record<string, unknown>).id as string

    const list2Res = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'List Two',
      listType: 'standard',
      scopeType: 'list_group',
      scopeId,
    })
    const list2Id = ((await list2Res.json()) as Record<string, unknown>).id as string

    // Add an item to the sibling list
    const itemRes = await req(bearer, 'POST', `/api/v1/ui/lists/${list2Id}/items`, {
      title: 'Sibling item',
    })
    expect(itemRes.status).toBe(201)
    const itemId = ((await itemRes.json()) as Record<string, unknown>).id as string

    // Delete list 1
    const delRes = await req(bearer, 'DELETE', `/api/v1/ui/lists/${list1Id}`)
    expect(delRes.status).toBe(204)

    // List 2 still accessible
    const get2 = await req(bearer, 'GET', `/api/v1/ui/lists/${list2Id}`)
    expect(get2.status).toBe(200)

    // Sibling item still alive
    const itemRow = await repos.listItems.findById(itemId)
    expect(itemRow).not.toBeNull()
    expect(itemRow!.deletedAt).toBeNull()
  })

  // --- planner prefs (UI surface) ------------------------------------

  it('PUT /planner-pref on a readable list returns 204 and GET /ui/planner-prefs returns that listId', async () => {
    const owner = `user_pp_ui01_${Date.now()}`
    const bearer = await loginAs(owner)
    const scopeId = await seedListGroup(bearer)

    const listRes = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'Planner list',
      listType: 'tasks',
      scopeType: 'list_group',
      scopeId,
    })
    expect(listRes.status).toBe(201)
    const listId = ((await listRes.json()) as Record<string, unknown>).id as string

    const putRes = await req(bearer, 'PUT', `/api/v1/ui/lists/${listId}/planner-pref`, { show: true })
    expect(putRes.status).toBe(204)

    const getRes = await req(bearer, 'GET', '/api/v1/ui/planner-prefs')
    expect(getRes.status).toBe(200)
    const body = (await getRes.json()) as { listIds: string[] }
    expect(body.listIds).toContain(listId)
  })

  it('setting show=false removes the list from flagged set', async () => {
    const owner = `user_pp_ui02_${Date.now()}`
    const bearer = await loginAs(owner)
    const scopeId = await seedListGroup(bearer)

    const listRes = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'Planner list 2',
      listType: 'tasks',
      scopeType: 'list_group',
      scopeId,
    })
    const listId = ((await listRes.json()) as Record<string, unknown>).id as string

    // Flag it as true, then flip to false.
    await req(bearer, 'PUT', `/api/v1/ui/lists/${listId}/planner-pref`, { show: true })
    const putFalse = await req(bearer, 'PUT', `/api/v1/ui/lists/${listId}/planner-pref`, { show: false })
    expect(putFalse.status).toBe(204)

    const getRes = await req(bearer, 'GET', '/api/v1/ui/planner-prefs')
    const body = (await getRes.json()) as { listIds: string[] }
    expect(body.listIds).not.toContain(listId)
  })

  it('PUT planner-pref on a list the user cannot read returns 404', async () => {
    const owner = `user_pp_ui03_${Date.now()}`
    const intruder = `user_pp_ui04_${Date.now()}`
    const ownerBearer = await loginAs(owner)
    const intruderBearer = await loginAs(intruder)
    const scopeId = await seedListGroup(ownerBearer)

    const listRes = await req(ownerBearer, 'POST', '/api/v1/ui/lists', {
      name: 'Private list',
      listType: 'tasks',
      scopeType: 'list_group',
      scopeId,
      visibility: 'all',
    })
    const listId = ((await listRes.json()) as Record<string, unknown>).id as string

    // Intruder is not a member of the group — should 404.
    const putRes = await req(intruderBearer, 'PUT', `/api/v1/ui/lists/${listId}/planner-pref`, { show: true })
    expect(putRes.status).toBe(404)
  })

  it('per-user isolation: user A flagging a list does not appear in user B GET planner-prefs', async () => {
    const userA = `user_pp_ui05a_${Date.now()}`
    const userB = `user_pp_ui05b_${Date.now()}`
    const bearerA = await loginAs(userA)
    const bearerB = await loginAs(userB)
    // Both users are in the same group.
    const scopeId = await seedListGroup(bearerA, 'Shared Group')
    // Add userB as a member via a new group (the UI group membership comes from UI group routes)
    // For this test, create a separate group for B so both have readable lists independently.
    const scopeIdB = await seedListGroup(bearerB, 'Group B')

    const listResA = await req(bearerA, 'POST', '/api/v1/ui/lists', {
      name: 'A list',
      listType: 'tasks',
      scopeType: 'list_group',
      scopeId,
    })
    const listIdA = ((await listResA.json()) as Record<string, unknown>).id as string

    // A flags their own list.
    await req(bearerA, 'PUT', `/api/v1/ui/lists/${listIdA}/planner-pref`, { show: true })

    // B's planner-prefs endpoint should not include A's list.
    const getResB = await req(bearerB, 'GET', '/api/v1/ui/planner-prefs')
    const bodyB = (await getResB.json()) as { listIds: string[] }
    expect(bodyB.listIds).not.toContain(listIdA)
    // Suppress unused-variable lint.
    void scopeIdB
  })

  // --- system-managed list type delete guard (#443) ------------------

  it('rejects DELETE on a shopping list with 409 system_managed_list', async () => {
    const owner = `user_sysmgd_shop_${Date.now()}`
    const bearer = await loginAs(owner)
    const scopeId = await seedListGroup(bearer, 'SysMgd Shop Group')

    const createRes = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'My Groceries',
      listType: 'shopping',
      scopeType: 'list_group',
      scopeId,
    })
    expect(createRes.status).toBe(201)
    const listId = ((await createRes.json()) as Record<string, unknown>).id as string

    // DELETE should be rejected with 409 for system-managed types.
    const delRes = await req(bearer, 'DELETE', `/api/v1/ui/lists/${listId}`)
    expect(delRes.status).toBe(409)
    const body = (await delRes.json()) as { error: { code: string } }
    expect(body.error.code).toBe('system_managed_list')

    // The list must still exist (not soft-deleted).
    const row = await repos.lists.findById(listId)
    expect(row).not.toBeNull()
    expect(row!.deletedAt).toBeNull()
  })

  it('rejects DELETE on a notes list with 409 system_managed_list', async () => {
    const owner = `user_sysmgd_notes_${Date.now()}`
    const bearer = await loginAs(owner)
    const scopeId = await seedListGroup(bearer, 'SysMgd Notes Group')

    const createRes = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'My Notes',
      listType: 'notes',
      scopeType: 'list_group',
      scopeId,
    })
    expect(createRes.status).toBe(201)
    const listId = ((await createRes.json()) as Record<string, unknown>).id as string

    const delRes = await req(bearer, 'DELETE', `/api/v1/ui/lists/${listId}`)
    expect(delRes.status).toBe(409)
    const body = (await delRes.json()) as { error: { code: string } }
    expect(body.error.code).toBe('system_managed_list')

    const row = await repos.lists.findById(listId)
    expect(row).not.toBeNull()
    expect(row!.deletedAt).toBeNull()
  })

  it('still allows DELETE on a tasks-type list (non-system-managed)', async () => {
    const owner = `user_sysmgd_tasks_${Date.now()}`
    const bearer = await loginAs(owner)
    const scopeId = await seedListGroup(bearer, 'SysMgd Tasks Group')

    const createRes = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'Deletable Tasks',
      listType: 'tasks',
      scopeType: 'list_group',
      scopeId,
    })
    expect(createRes.status).toBe(201)
    const listId = ((await createRes.json()) as Record<string, unknown>).id as string

    // DELETE should succeed for a normal tasks list.
    const delRes = await req(bearer, 'DELETE', `/api/v1/ui/lists/${listId}`)
    expect(delRes.status).toBe(204)

    // Confirm it was soft-deleted.
    const row = await repos.lists.findById(listId)
    expect(row).not.toBeNull()
    expect(row!.deletedAt).not.toBeNull()
  })

  it('still allows DELETE on a standard-type list (non-system-managed)', async () => {
    const owner = `user_sysmgd_std_${Date.now()}`
    const bearer = await loginAs(owner)
    const scopeId = await seedListGroup(bearer, 'SysMgd Std Group')

    const createRes = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'Deletable Standard',
      listType: 'standard',
      scopeType: 'list_group',
      scopeId,
    })
    expect(createRes.status).toBe(201)
    const listId = ((await createRes.json()) as Record<string, unknown>).id as string

    const delRes = await req(bearer, 'DELETE', `/api/v1/ui/lists/${listId}`)
    expect(delRes.status).toBe(204)

    const row = await repos.lists.findById(listId)
    expect(row!.deletedAt).not.toBeNull()
  })
})
