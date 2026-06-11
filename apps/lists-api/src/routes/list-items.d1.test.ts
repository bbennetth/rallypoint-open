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
import { CATEGORY_KEY } from '@rallypoint/lists-shared'

// D1 integration tests for the nested list-item CRUD surface.
// Replaces list-items.it.test.ts.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — list items', () => {
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

  // Each list lives under a real list_group the caller owns — #128
  // enforced authz means a list with a bogus scope_id 404s on reads.
  async function makeList(
    bearer: string,
    opts: { listType?: string; visibility?: string } = {},
  ): Promise<string> {
    const groupRes = await req(bearer, 'POST', '/api/v1/ui/groups', {
      name: `Group ${Date.now()}_${Math.random().toString(36).slice(2)}`,
    })
    expect(groupRes.status).toBe(201)
    const scopeId = ((await groupRes.json()) as { id: string }).id
    const res = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'Tasks',
      listType: opts.listType ?? 'tasks',
      scopeType: 'list_group',
      scopeId,
      ...(opts.visibility ? { visibility: opts.visibility } : {}),
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }

  it('404s adding an item to a non-existent list', async () => {
    const bearer = await loginAs(`user_${Date.now()}_nolist`)
    const res = await req(bearer, 'POST', '/api/v1/ui/lists/lst_missing/items', { title: 'x' })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('list_not_found')
  })

  it('appends items with auto-incrementing position', async () => {
    const bearer = await loginAs(`user_${Date.now()}_pos`)
    const listId = await makeList(bearer)

    const first = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'First',
    })).json()) as Record<string, unknown>
    const second = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Second',
    })).json()) as Record<string, unknown>

    expect(first.id).toMatch(/^lit_/)
    expect(first.position).toBe(0)
    expect(second.position).toBe(1)
    expect(first.completed).toBe(false)
    expect(first.completed_at).toBeNull()

    const page = (await (await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/items`)).json()) as {
      items: Array<Record<string, unknown>>
    }
    expect(page.items.map((i) => i.title)).toEqual(['First', 'Second'])
  })

  it('checks an item off and back on, toggling completed_at', async () => {
    const bearer = await loginAs(`user_${Date.now()}_check`)
    const listId = await makeList(bearer)
    const item = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Buy ice',
    })).json()) as { id: string }

    const checked = (await (await req(
      bearer,
      'PATCH',
      `/api/v1/ui/lists/${listId}/items/${item.id}`,
      { completed: true },
    )).json()) as Record<string, unknown>
    expect(checked.completed).toBe(true)
    expect(checked.completed_at).not.toBeNull()

    const unchecked = (await (await req(
      bearer,
      'PATCH',
      `/api/v1/ui/lists/${listId}/items/${item.id}`,
      { completed: false },
    )).json()) as Record<string, unknown>
    expect(unchecked.completed).toBe(false)
    expect(unchecked.completed_at).toBeNull()
  })

  it('reorders via a position PATCH', async () => {
    const bearer = await loginAs(`user_${Date.now()}_reorder`)
    const listId = await makeList(bearer)
    const a = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'A',
    })).json()) as { id: string }
    await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, { title: 'B' })

    await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/items/${a.id}`, { position: 5 })
    const page = (await (await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/items`)).json()) as {
      items: Array<Record<string, unknown>>
    }
    expect(page.items.map((i) => i.title)).toEqual(['B', 'A'])
  })

  it('soft-deletes an item then restores it', async () => {
    const bearer = await loginAs(`user_${Date.now()}_del`)
    const listId = await makeList(bearer)
    const item = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Temp',
    })).json()) as { id: string }

    const delRes = await req(bearer, 'DELETE', `/api/v1/ui/lists/${listId}/items/${item.id}`)
    expect(delRes.status).toBe(204)

    const afterDelete = (await (await req(
      bearer,
      'GET',
      `/api/v1/ui/lists/${listId}/items`,
    )).json()) as { items: unknown[] }
    expect(afterDelete.items).toHaveLength(0)

    const restoreRes = await req(
      bearer,
      'POST',
      `/api/v1/ui/lists/${listId}/items/${item.id}/restore`,
    )
    expect(restoreRes.status).toBe(200)

    const afterRestore = (await (await req(
      bearer,
      'GET',
      `/api/v1/ui/lists/${listId}/items`,
    )).json()) as { items: unknown[] }
    expect(afterRestore.items).toHaveLength(1)
  })

  it('rejects restoring an item that is not deleted (409)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_live`)
    const listId = await makeList(bearer)
    const item = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Still here',
    })).json()) as { id: string }

    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/${item.id}/restore`)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('item_not_deleted')
  })

  it('rejects restoring an item past the 30-day window (409)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_stale`)
    const listId = await makeList(bearer)
    const item = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Long gone',
    })).json()) as { id: string }

    // Backdate the soft-delete past the 30-day grace window.
    await repos.listItems.softDelete(item.id, new Date(Date.now() - 31 * 24 * 60 * 60 * 1000))

    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/${item.id}/restore`)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'item_purge_window_elapsed',
    )
  })

  it('rejects an empty patch body with validation_failed', async () => {
    const bearer = await loginAs(`user_${Date.now()}_empty`)
    const listId = await makeList(bearer)
    const item = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'X',
    })).json()) as { id: string }
    const res = await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/items/${item.id}`, {})
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation_failed')
  })

  it('defaults task-list items to status=todo, priority=medium', async () => {
    const bearer = await loginAs(`user_${Date.now()}_taskdefault`)
    const taskList = await makeList(bearer, { listType: 'tasks' })
    const task = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${taskList}/items`, {
      title: 'Pitch tent',
    })).json()) as Record<string, unknown>
    expect(task.status).toBe('todo')
    expect(task.priority).toBe('medium')
    expect(task.due_date).toBeNull()

    // A non-task list ignores client-supplied task fields and leaves the
    // task columns null.
    const standard = await makeList(bearer, { listType: 'standard' })
    const item = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${standard}/items`, {
      title: 'Milk',
      status: 'done',
      priority: 'high',
      dueDate: '2026-07-01T09:00:00.000Z',
    })).json()) as Record<string, unknown>
    expect(item.status).toBeNull()
    expect(item.priority).toBeNull()
    expect(item.due_date).toBeNull()
  })

  it('mirrors completed when a task is created with status=done', async () => {
    const bearer = await loginAs(`user_${Date.now()}_createdone`)
    const taskList = await makeList(bearer, { listType: 'tasks' })
    const task = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${taskList}/items`, {
      title: 'Already done',
      status: 'done',
    })).json()) as Record<string, unknown>
    expect(task.status).toBe('done')
    expect(task.completed).toBe(true)
    expect(task.completed_at).not.toBeNull()
  })

  it('lets status win when a patch carries both status and completed', async () => {
    const bearer = await loginAs(`user_${Date.now()}_bothfields`)
    const taskList = await makeList(bearer, { listType: 'tasks' })
    const task = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${taskList}/items`, {
      title: 'Contested',
    })).json()) as { id: string }

    // completed:true would set done, but status:'todo' is the source of
    // truth and must win → completed stays false.
    const patched = (await (await req(bearer, 'PATCH', `/api/v1/ui/lists/${taskList}/items/${task.id}`, {
      completed: true,
      status: 'todo',
    })).json()) as Record<string, unknown>
    expect(patched.status).toBe('todo')
    expect(patched.completed).toBe(false)
    expect(patched.completed_at).toBeNull()
  })

  it('treats a self-move (listId === current) as a no-op', async () => {
    const bearer = await loginAs(`user_${Date.now()}_selfmove`)
    const listId = await makeList(bearer, { listType: 'tasks' })
    const task = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Stay put',
    })).json()) as { id: string; updated_at: string; position: number }

    const res = (await (await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/items/${task.id}`, {
      listId,
    })).json()) as Record<string, unknown>
    // Same row, untouched — no spurious updated_at bump or reposition.
    expect(res.list_id).toBe(listId)
    expect(res.position).toBe(task.position)
    expect(res.updated_at).toBe(task.updated_at)
  })

  it('appends on a cross-list move even when a position is supplied', async () => {
    const bearer = await loginAs(`user_${Date.now()}_movepos`)
    const source = await makeList(bearer, { listType: 'tasks' })
    const target = await makeList(bearer, { listType: 'tasks' })
    await req(bearer, 'POST', `/api/v1/ui/lists/${target}/items`, { title: 'Existing' })
    const task = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${source}/items`, {
      title: 'Relocate',
    })).json()) as { id: string }

    // An explicit position must not override the append-at-end on move.
    const moved = (await (await req(bearer, 'PATCH', `/api/v1/ui/lists/${source}/items/${task.id}`, {
      listId: target,
      position: 0,
    })).json()) as Record<string, unknown>
    expect(moved.list_id).toBe(target)
    expect(moved.position).toBe(1)
  })

  it('mirrors completed off status (done ⟺ completed)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_mirror`)
    const taskList = await makeList(bearer, { listType: 'tasks' })
    const task = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${taskList}/items`, {
      title: 'Book the van',
    })).json()) as { id: string }

    const done = (await (await req(bearer, 'PATCH', `/api/v1/ui/lists/${taskList}/items/${task.id}`, {
      status: 'done',
    })).json()) as Record<string, unknown>
    expect(done.status).toBe('done')
    expect(done.completed).toBe(true)
    expect(done.completed_at).not.toBeNull()

    const back = (await (await req(bearer, 'PATCH', `/api/v1/ui/lists/${taskList}/items/${task.id}`, {
      status: 'in_progress',
    })).json()) as Record<string, unknown>
    expect(back.status).toBe('in_progress')
    expect(back.completed).toBe(false)
    expect(back.completed_at).toBeNull()
  })

  it('round-trips priority and due date', async () => {
    const bearer = await loginAs(`user_${Date.now()}_prio`)
    const taskList = await makeList(bearer, { listType: 'tasks' })
    const task = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${taskList}/items`, {
      title: 'Permit',
    })).json()) as { id: string }

    const due = '2026-07-01T09:00:00.000Z'
    const patched = (await (await req(bearer, 'PATCH', `/api/v1/ui/lists/${taskList}/items/${task.id}`, {
      priority: 'high',
      dueDate: due,
    })).json()) as Record<string, unknown>
    expect(patched.priority).toBe('high')
    expect(patched.due_date).toBe(due)
  })

  it('clears priority with null (#427)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_clearprio`)
    const taskList = await makeList(bearer, { listType: 'tasks' })
    const task = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${taskList}/items`, {
      title: 'Needs no priority',
      priority: 'high',
    })).json()) as { id: string }

    // Sanity: item was created with high priority.
    const created = (await (await req(bearer, 'GET', `/api/v1/ui/lists/${taskList}/items`)).json()) as {
      items: Array<Record<string, unknown>>
    }
    expect(created.items[0]!.priority).toBe('high')

    // Clear it.
    const cleared = (await (await req(bearer, 'PATCH', `/api/v1/ui/lists/${taskList}/items/${task.id}`, {
      priority: null,
    })).json()) as Record<string, unknown>
    expect(cleared.priority).toBeNull()

    // Verify persistence via a re-fetch.
    const page = (await (await req(bearer, 'GET', `/api/v1/ui/lists/${taskList}/items`)).json()) as {
      items: Array<Record<string, unknown>>
    }
    expect(page.items[0]!.priority).toBeNull()
  })

  it('moves a task to another list, appending at the end', async () => {
    const bearer = await loginAs(`user_${Date.now()}_move`)
    const source = await makeList(bearer, { listType: 'tasks' })
    const target = await makeList(bearer, { listType: 'tasks' })
    // Seed the target with one item so the moved item must append after it.
    await req(bearer, 'POST', `/api/v1/ui/lists/${target}/items`, { title: 'Existing' })
    const task = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${source}/items`, {
      title: 'Relocate me',
    })).json()) as { id: string; position: number }

    const moved = (await (await req(bearer, 'PATCH', `/api/v1/ui/lists/${source}/items/${task.id}`, {
      listId: target,
    })).json()) as Record<string, unknown>
    expect(moved.list_id).toBe(target)
    expect(moved.position).toBe(1)

    // It is gone from the source and present in the target.
    const srcPage = (await (await req(bearer, 'GET', `/api/v1/ui/lists/${source}/items`)).json()) as {
      items: unknown[]
    }
    expect(srcPage.items).toHaveLength(0)
    const tgtPage = (await (await req(bearer, 'GET', `/api/v1/ui/lists/${target}/items`)).json()) as {
      items: Array<Record<string, unknown>>
    }
    expect(tgtPage.items.map((i) => i.title)).toEqual(['Existing', 'Relocate me'])
  })

  it('clears task fields when a task moves to a non-task list', async () => {
    const bearer = await loginAs(`user_${Date.now()}_movecross`)
    const source = await makeList(bearer, { listType: 'tasks' })
    const standard = await makeList(bearer, { listType: 'standard' })
    const task = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${source}/items`, {
      title: 'Crossing types',
      status: 'done',
      priority: 'high',
      dueDate: '2026-07-01T09:00:00.000Z',
    })).json()) as { id: string }

    const moved = (await (await req(bearer, 'PATCH', `/api/v1/ui/lists/${source}/items/${task.id}`, {
      listId: standard,
    })).json()) as Record<string, unknown>
    expect(moved.list_id).toBe(standard)
    // Task-only columns are cleared on the non-task row.
    expect(moved.status).toBeNull()
    expect(moved.priority).toBeNull()
    expect(moved.due_date).toBeNull()
  })

  it('404s moving a task to a missing list', async () => {
    const bearer = await loginAs(`user_${Date.now()}_movemiss`)
    const source = await makeList(bearer, { listType: 'tasks' })
    const task = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${source}/items`, {
      title: 'Stay',
    })).json()) as { id: string }
    const res = await req(bearer, 'PATCH', `/api/v1/ui/lists/${source}/items/${task.id}`, {
      listId: 'lst_does_not_exist',
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('list_not_found')
  })

  it('transfers ownership when moving to a private list, not to a shared one', async () => {
    // Three distinct creators so the transfer is observable: the task
    // starts owned by A, B owns the private target, C owns the shared
    // one. Post-#128 each list lives in a list_group; we set up one
    // group with all three users as members so userA can target each
    // list, plus a share on B's private list so userA can read into it.
    const userA = `user_${Date.now()}_a`
    const userB = `user_${Date.now()}_b`
    const userC = `user_${Date.now()}_c`
    const bearerA = await loginAs(userA)
    const bearerB = await loginAs(userB)
    const bearerC = await loginAs(userC)
    // userA owns the source group; B and C join. The three lists live
    // in this single shared group so cross-list moves resolve.
    const groupRes = await req(bearerA, 'POST', '/api/v1/ui/groups', {
      name: `Move Group ${Date.now()}`,
    })
    expect(groupRes.status).toBe(201)
    const groupId = ((await groupRes.json()) as { id: string }).id
    await repos.groups.addMember({
      id: `lgm_test_${Math.random().toString(36).slice(2)}`,
      groupId,
      userId: userB,
      role: 'member',
    })
    await repos.groups.addMember({
      id: `lgm_test_${Math.random().toString(36).slice(2)}`,
      groupId,
      userId: userC,
      role: 'member',
    })
    async function makeListInGroup(
      bearer: string,
      visibility: 'all' | 'private',
    ): Promise<string> {
      const r = await req(bearer, 'POST', '/api/v1/ui/lists', {
        name: 'L',
        listType: 'tasks',
        scopeType: 'list_group',
        scopeId: groupId,
        visibility,
      })
      expect(r.status).toBe(201)
      return ((await r.json()) as { id: string }).id
    }
    const source = await makeListInGroup(bearerA, 'all')
    const privateList = await makeListInGroup(bearerB, 'private')
    const sharedList = await makeListInGroup(bearerC, 'all')
    // userA needs explicit share access on B's private list to be able
    // to move into it (loadListForRead enforces visibility on the
    // target). Share directly via the repo to keep the test focused.
    await repos.listShares.add({
      id: `lsh_test_${Math.random().toString(36).slice(2)}`,
      listId: privateList,
      userId: userA,
      addedByUserId: userB,
    })

    const task = (await (await req(bearerA, 'POST', `/api/v1/ui/lists/${source}/items`, {
      title: 'Owned task',
    })).json()) as { id: string; created_by: string }
    expect(task.created_by).toBe(userA)

    // Move to B's private list → created_by transfers to B.
    const toPrivate = (await (await req(bearerA, 'PATCH', `/api/v1/ui/lists/${source}/items/${task.id}`, {
      listId: privateList,
    })).json()) as Record<string, unknown>
    expect(toPrivate.created_by).toBe(userB)

    // Move on to C's shared (all) list → ownership unchanged (stays B).
    const toShared = (await (await req(bearerA, 'PATCH', `/api/v1/ui/lists/${privateList}/items/${task.id}`, {
      listId: sharedList,
    })).json()) as Record<string, unknown>
    expect(toShared.created_by).toBe(userB)
  })

  it('404s when the item is addressed under the wrong parent list', async () => {
    const bearer = await loginAs(`user_${Date.now()}_xlist`)
    const listA = await makeList(bearer)
    const listB = await makeList(bearer)
    const item = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listA}/items`, {
      title: 'Belongs to A',
    })).json()) as { id: string }

    const res = await req(bearer, 'PATCH', `/api/v1/ui/lists/${listB}/items/${item.id}`, {
      completed: true,
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('item_not_found')
  })

  // --- UI-route shopping auto-categorization (mirrors sdk-writes.d1.test.ts) ---

  async function makeShoppingList(bearer: string): Promise<string> {
    const groupRes = await req(bearer, 'POST', '/api/v1/ui/groups', {
      name: `Shop Group ${Date.now()}_${Math.random().toString(36).slice(2)}`,
    })
    expect(groupRes.status).toBe(201)
    const scopeId = ((await groupRes.json()) as { id: string }).id
    const res = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'Weekly shop',
      listType: 'shopping',
      scopeType: 'list_group',
      scopeId,
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }

  it('UI: auto-assigns category on shopping list item create (title-based)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_ui_shop01`)
    const listId = await makeShoppingList(bearer)

    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Whole milk',
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    const cf = body.custom_fields as Record<string, unknown>
    expect(cf[CATEGORY_KEY]).toBe('dairy')

    // Verify the category is actually stored in D1.
    const row = await env.DB.prepare('SELECT custom_fields FROM list_items WHERE id = ?')
      .bind(body.id as string)
      .first<{ custom_fields: string }>()
    const stored = JSON.parse(row!.custom_fields) as Record<string, unknown>
    expect(stored[CATEGORY_KEY]).toBe('dairy')
  })

  it('UI: explicit client-supplied category is NOT overwritten on create', async () => {
    const bearer = await loginAs(`user_${Date.now()}_ui_shop02`)
    const listId = await makeShoppingList(bearer)

    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Milk',
      customFields: { [CATEGORY_KEY]: 'household' },
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    const cf = body.custom_fields as Record<string, unknown>
    // Client explicitly said 'household' — must NOT be overwritten by categorize().
    expect(cf[CATEGORY_KEY]).toBe('household')
  })

  it('UI: category override via single-item PATCH persists and survives round-trip', async () => {
    const bearer = await loginAs(`user_${Date.now()}_ui_shop03`)
    const listId = await makeShoppingList(bearer)

    const createRes = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Butter',
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as Record<string, unknown>
    const itemId = created.id as string
    // Auto-categorized as 'dairy' on create.
    expect((created.custom_fields as Record<string, unknown>)[CATEGORY_KEY]).toBe('dairy')

    // Override category to 'pantry' via PATCH.
    const patchRes = await req(
      bearer,
      'PATCH',
      `/api/v1/ui/lists/${listId}/items/${itemId}`,
      { customFields: { [CATEGORY_KEY]: 'pantry' } },
    )
    expect(patchRes.status).toBe(200)
    const patchBody = (await patchRes.json()) as Record<string, unknown>
    const cf = patchBody.custom_fields as Record<string, unknown>
    expect(cf[CATEGORY_KEY]).toBe('pantry')

    // Verify D1 has the new category.
    const row = await env.DB.prepare('SELECT custom_fields FROM list_items WHERE id = ?')
      .bind(itemId)
      .first<{ custom_fields: string }>()
    const stored = JSON.parse(row!.custom_fields) as Record<string, unknown>
    expect(stored[CATEGORY_KEY]).toBe('pantry')
  })

  it('UI: items in a tasks list do NOT get auto-categorized', async () => {
    const bearer = await loginAs(`user_${Date.now()}_ui_shop04`)
    const listId = await makeList(bearer, { listType: 'tasks' })

    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Buy milk',
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    const cf = body.custom_fields as Record<string, unknown>
    // Tasks list must NOT get a category key.
    expect(cf[CATEGORY_KEY]).toBeUndefined()
  })

  it('UI bulk update: rp:category survives a base-only bulk update on shopping items', async () => {
    // When the bulk patch has no customFields the repo never writes custom_fields —
    // but we still assert the stored value is intact after the write.
    const bearer = await loginAs(`user_${Date.now()}_ui_shop05`)
    const listId = await makeShoppingList(bearer)

    // Create two shopping items; each gets auto-categorized.
    const milkRes = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Whole milk',
    })
    expect(milkRes.status).toBe(201)
    const milk = (await milkRes.json()) as { id: string; custom_fields: Record<string, unknown> }
    expect(milk.custom_fields[CATEGORY_KEY]).toBe('dairy')

    const soapRes = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Dish soap',
    })
    expect(soapRes.status).toBe(201)
    const soap = (await soapRes.json()) as { id: string; custom_fields: Record<string, unknown> }
    const soapCategoryBefore = soap.custom_fields[CATEGORY_KEY] as string
    expect(soapCategoryBefore).toBeTruthy()

    // Run a base-only bulk update (completed toggle).
    const bulkRes = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/bulk`, {
      action: 'update',
      itemIds: [milk.id, soap.id],
      patch: { completed: true },
    })
    expect(bulkRes.status).toBe(200)
    expect(((await bulkRes.json()) as { count: number }).count).toBe(2)

    // Category must STILL be present in D1 after the base-only write.
    const milkRow = await env.DB.prepare('SELECT custom_fields FROM list_items WHERE id = ?')
      .bind(milk.id)
      .first<{ custom_fields: string }>()
    expect(JSON.parse(milkRow!.custom_fields)[CATEGORY_KEY]).toBe('dairy')

    const soapRow = await env.DB.prepare('SELECT custom_fields FROM list_items WHERE id = ?')
      .bind(soap.id)
      .first<{ custom_fields: string }>()
    expect(JSON.parse(soapRow!.custom_fields)[CATEGORY_KEY]).toBe(soapCategoryBefore)
  })

  it('UI bulk update: rp:category survives when bulk patch includes customFields (P3-1 regression)', async () => {
    // Regression test for the exact bug path: hasCustom=true causes the bulk
    // handler to build `intended` filtered to activeIds, which drops rp:category.
    // This test exercises that code path by including a customFields key.
    // (On a v1 shopping list with no field defs, the patch key is ignored by
    // validateCustomFields but the rp:category re-carry must still happen.)
    const bearer = await loginAs(`user_${Date.now()}_ui_shop06`)
    const listId = await makeShoppingList(bearer)

    const milkRes = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Whole milk',
    })
    expect(milkRes.status).toBe(201)
    const milk = (await milkRes.json()) as { id: string; custom_fields: Record<string, unknown> }
    expect(milk.custom_fields[CATEGORY_KEY]).toBe('dairy')

    const soapRes = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Dish soap',
    })
    expect(soapRes.status).toBe(201)
    const soap = (await soapRes.json()) as { id: string; custom_fields: Record<string, unknown> }
    const soapCategoryBefore = soap.custom_fields[CATEGORY_KEY] as string
    expect(soapCategoryBefore).toBeTruthy()

    // Bulk update with a customFields patch — triggers the hasCustom=true path.
    // Use rp:category itself as the client-supplied patch to prove both strip
    // and re-carry work: milk gets 'pantry' (explicit override), soap keeps its
    // existing category (since the patch only targets milk via per-item loop).
    // Actually, the bulk patch applies the SAME cfPatch to all items. So we use
    // an empty custom-fields object to trigger the hasCustom path without
    // overriding either item's category — proving the re-carry from existing
    // stored value works.
    const bulkRes = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/bulk`, {
      action: 'update',
      itemIds: [milk.id, soap.id],
      patch: {
        completed: true,
        // A rp:category key in the patch: both items get this category,
        // proving the client-supplied value is carried through (not dropped).
        customFields: { [CATEGORY_KEY]: 'pantry' },
      },
    })
    expect(bulkRes.status).toBe(200)
    expect(((await bulkRes.json()) as { count: number }).count).toBe(2)

    // Both items must now have 'pantry' (the client-supplied override).
    const milkRow = await env.DB.prepare('SELECT custom_fields FROM list_items WHERE id = ?')
      .bind(milk.id)
      .first<{ custom_fields: string }>()
    expect(JSON.parse(milkRow!.custom_fields)[CATEGORY_KEY]).toBe('pantry')

    const soapRow = await env.DB.prepare('SELECT custom_fields FROM list_items WHERE id = ?')
      .bind(soap.id)
      .first<{ custom_fields: string }>()
    expect(JSON.parse(soapRow!.custom_fields)[CATEGORY_KEY]).toBe('pantry')
  })

  it('UI bulk update: re-carry preserves DISTINCT per-item categories when customFields patch has no rp:category (shop07)', async () => {
    // This is the core re-carry bug path: hasCustom=true but the patch
    // contains NO rp:category key. Without the re-carry fix each item's
    // existing rp:category would be silently dropped by the activeIds filter.
    // A v1 shopping list rejects non-rp custom-field keys as unrecognized, so
    // we must register a field def to make a non-rp key legal. That also
    // proves re-carry works on a "shopping + field-defs" (v2 shopping) list.
    const bearer = await loginAs(`user_${Date.now()}_ui_shop07`)
    const listId = await makeShoppingList(bearer)

    // Register a non-rp field def so the bulk patch can legally carry it.
    const fieldRes = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/fields`, {
      label: 'Notes',
      fieldType: 'text',
    })
    expect(fieldRes.status).toBe(201)
    const fieldDef = (await fieldRes.json()) as { id: string }

    // Create two items with DISTINCT auto-assigned categories.
    const milkRes = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Whole milk',
    })
    expect(milkRes.status).toBe(201)
    const milk = (await milkRes.json()) as { id: string; custom_fields: Record<string, unknown> }
    expect(milk.custom_fields[CATEGORY_KEY]).toBe('dairy')

    const soapRes = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, {
      title: 'Dish soap',
    })
    expect(soapRes.status).toBe(201)
    const soap = (await soapRes.json()) as { id: string; custom_fields: Record<string, unknown> }
    expect(soap.custom_fields[CATEGORY_KEY]).toBe('household')

    // Bulk update with a customFields patch that sets ONLY the field-def key —
    // NO rp:category. This triggers hasCustom=true without a client override.
    // The re-carry must keep each item's OWN distinct stored category.
    const bulkRes = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/bulk`, {
      action: 'update',
      itemIds: [milk.id, soap.id],
      patch: {
        customFields: { [fieldDef.id]: 'check-notes' },
      },
    })
    expect(bulkRes.status).toBe(200)
    expect(((await bulkRes.json()) as { count: number }).count).toBe(2)

    // Each item must retain its own distinct category AND have the new field value.
    const milkRow = await env.DB.prepare('SELECT custom_fields FROM list_items WHERE id = ?')
      .bind(milk.id)
      .first<{ custom_fields: string }>()
    const milkCf = JSON.parse(milkRow!.custom_fields) as Record<string, unknown>
    expect(milkCf[CATEGORY_KEY]).toBe('dairy')        // re-carried from milk
    expect(milkCf[fieldDef.id]).toBe('check-notes')  // new field-def value applied

    const soapRow = await env.DB.prepare('SELECT custom_fields FROM list_items WHERE id = ?')
      .bind(soap.id)
      .first<{ custom_fields: string }>()
    const soapCf = JSON.parse(soapRow!.custom_fields) as Record<string, unknown>
    expect(soapCf[CATEGORY_KEY]).toBe('household')    // re-carried from soap (distinct from dairy)
    expect(soapCf[fieldDef.id]).toBe('check-notes')  // new field-def value applied
  })
})
