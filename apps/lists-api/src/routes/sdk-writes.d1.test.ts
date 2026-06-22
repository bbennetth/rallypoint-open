import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { Repos } from '../repos/types.js'
import type { HonoApp } from '../context.js'
import type { Services } from '../services/types.js'

// D1 integration tests for the authenticated SDK WRITE surface. Replaces
// sdk-writes.it.test.ts. Raw SQL queries use env.DB.prepare() with flat
// table names (no `lists_v1.` prefix — D1 has no schemas).

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

describe('D1 integration — SDK write surface', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services, realtime: undefined })
  })

  function bearer(key: string): Record<string, string> {
    return { authorization: `Bearer ${key}` }
  }

  // Planner is the write-surface peer — drive with its key.
  function sdkHeaders(actor: string): Record<string, string> {
    return { ...bearer(envVars.PLANNER_API_KEY!), 'x-actor': actor, 'content-type': 'application/json' }
  }

  // Provision a personal list_group for an actor (auto-enrolled owner)
  // and return its id — the same flow Planner uses on first write.
  async function createGroupFor(actor: string, name = 'Personal'): Promise<string> {
    const res = await app.request('http://localhost/api/v1/sdk/groups', {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ name }),
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as Record<string, unknown>).id as string
  }

  // Create a tasks list in the actor's group and return its id.
  async function createTasksList(actor: string, groupId: string, name = 'My tasks'): Promise<string> {
    const res = await app.request('http://localhost/api/v1/sdk/lists', {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({
        name,
        listType: 'tasks',
        scopeType: 'list_group',
        scopeId: groupId,
      }),
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as Record<string, unknown>).id as string
  }

  // --- key auth tests -----------------------------------------------

  it('404s when no peer key is configured', async () => {
    const prodEnv = parseEnv({
      NODE_ENV: 'production',
      LOG_LEVEL: 'fatal',
      LISTS_API_KEY: 'x'.repeat(40),
      LISTS_SESSION_KEY_V1: 'y'.repeat(40),
      REALTIME_TOKEN_HMAC_KEY: 'z'.repeat(40),
    })
    expect(prodEnv.EVENTS_API_KEY).toBeUndefined()
    expect(prodEnv.PLANNER_API_KEY).toBeUndefined()
    const noKeyApp = buildApp({ env: prodEnv, logger: undefined, repos, services, realtime: undefined })
    const res = await noKeyApp.request('http://localhost/api/v1/sdk/groups', {
      headers: { 'x-actor': 'user_test' },
    })
    expect(res.status).toBe(404)
  })

  it('403s on a missing or wrong bearer', async () => {
    const none = await app.request('http://localhost/api/v1/sdk/groups', {
      headers: { 'x-actor': 'user_test' },
    })
    expect(none.status).toBe(403)
    const wrong = await app.request('http://localhost/api/v1/sdk/groups', {
      headers: { ...bearer('not-the-key'), 'x-actor': 'user_test' },
    })
    expect(wrong.status).toBe(403)
  })

  it('403s when EVENTS_API_KEY is used on a write (planner-only) route', async () => {
    // events-api is only authorised for the three read routes in sdk-lists.ts.
    // Any other SDK path (including GET /sdk/groups) requires PLANNER_API_KEY.
    const res = await app.request('http://localhost/api/v1/sdk/groups', {
      headers: { ...bearer(envVars.EVENTS_API_KEY!), 'x-actor': 'user_01JP0000000000000000000001' },
    })
    expect(res.status).toBe(403)
  })

  it('allows PLANNER_API_KEY on a write route', async () => {
    const res = await app.request('http://localhost/api/v1/sdk/groups', {
      headers: { ...bearer(envVars.PLANNER_API_KEY!), 'x-actor': 'user_01JP0000000000000000000002' },
    })
    expect(res.status).toBe(200)
  })

  it('allows EVENTS_API_KEY on a read route (GET /sdk/lists)', async () => {
    const res = await app.request('http://localhost/api/v1/sdk/lists?scope_type=group&scope_id=grp_test', {
      headers: bearer(envVars.EVENTS_API_KEY!),
    })
    expect(res.status).toBe(200)
  })

  it('allows PLANNER_API_KEY on a read route (GET /sdk/lists)', async () => {
    const res = await app.request('http://localhost/api/v1/sdk/lists?scope_type=group&scope_id=grp_test2', {
      headers: bearer(envVars.PLANNER_API_KEY!),
    })
    expect(res.status).toBe(200)
  })

  it('403s EVENTS_API_KEY on POST /sdk/groups (write route)', async () => {
    const res = await app.request('http://localhost/api/v1/sdk/groups', {
      method: 'POST',
      headers: { ...bearer(envVars.EVENTS_API_KEY!), 'x-actor': 'user_01JP0000000000000000000003', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sneaky' }),
    })
    expect(res.status).toBe(403)
  })

  // --- x-actor header tests -----------------------------------------

  it('400s when x-actor header is missing', async () => {
    const res = await app.request('http://localhost/api/v1/sdk/groups', {
      method: 'POST',
      headers: { ...bearer(envVars.PLANNER_API_KEY!), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Nope' }),
    })
    expect(res.status).toBe(400)
  })

  it('400s when x-actor is malformed (not a user_<ulid>)', async () => {
    const malformed = [
      'not_a_user',
      'user_short',
      'user_',
      'user_toolongAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ]
    for (const actor of malformed) {
      const res = await app.request('http://localhost/api/v1/sdk/groups', {
        method: 'POST',
        headers: { ...bearer(envVars.PLANNER_API_KEY!), 'x-actor': actor, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Nope' }),
      })
      expect(res.status, `expected 400 for actor "${actor}"`).toBe(400)
    }
  })

  // --- groups -------------------------------------------------------

  it('creates a group with the actor auto-enrolled as owner', async () => {
    const actor = 'user_01JP0000000000000000000041'
    const res = await app.request('http://localhost/api/v1/sdk/groups', {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ name: 'Personal', description: 'My stuff' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ name: 'Personal', description: 'My stuff', createdBy: actor })
    expect((body.id as string).startsWith('lgr_')).toBe(true)
    expect(body).not.toHaveProperty('tenantId')
    expect(body).not.toHaveProperty('deletedAt')

    // D1: flat table name `list_group_members` (no `lists_v1.` prefix).
    const row = await env.DB.prepare(
      'SELECT role FROM list_group_members WHERE group_id = ? AND user_id = ?',
    )
      .bind(body.id as string, actor)
      .first<{ role: string }>()
    expect(row?.role).toBe('owner')
  })

  it('lists only the groups the actor belongs to', async () => {
    const actor = 'user_01JP0000000000000000000005'
    const other = 'user_01JP0000000000000000000006'
    const mineA = await createGroupFor(actor, 'A')
    const mineB = await createGroupFor(actor, 'B')
    await createGroupFor(other, 'Theirs')

    const res = await app.request('http://localhost/api/v1/sdk/groups', {
      headers: { ...bearer(envVars.PLANNER_API_KEY!), 'x-actor': actor },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<Record<string, unknown>>
    const ids = body.map((g) => g.id).sort()
    expect(ids).toEqual([mineA, mineB].sort())
  })

  // --- list creation + scope membership enforcement -----------------

  it('creates a list in a list_group scope the actor owns', async () => {
    const actor = 'user_01JP0000000000000000000007'
    const groupId = await createGroupFor(actor)
    const res = await app.request('http://localhost/api/v1/sdk/lists', {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ name: 'Errands', listType: 'tasks', scopeType: 'list_group', scopeId: groupId }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ name: 'Errands', scopeType: 'list_group', scopeId: groupId, createdBy: actor })
    expect((body.id as string).startsWith('lst_')).toBe(true)
  })

  it('404s creating a list in a list_group the actor is not a member of', async () => {
    const owner = 'user_01JP0000000000000000000008'
    const intruder = 'user_01JP0000000000000000000009'
    const groupId = await createGroupFor(owner)
    const res = await app.request('http://localhost/api/v1/sdk/lists', {
      method: 'POST',
      headers: sdkHeaders(intruder),
      body: JSON.stringify({ name: 'Sneaky', listType: 'tasks', scopeType: 'list_group', scopeId: groupId }),
    })
    expect(res.status).toBe(404)
  })

  it('404s creating a list in a non-existent list_group', async () => {
    const res = await app.request('http://localhost/api/v1/sdk/lists', {
      method: 'POST',
      headers: sdkHeaders('user_01JP0000000000000000000010'),
      body: JSON.stringify({ name: 'Orphan', listType: 'tasks', scopeType: 'list_group', scopeId: 'lgr_nope' }),
    })
    expect(res.status).toBe(404)
  })

  // --- item creation ------------------------------------------------

  it('creates a task item with default status/priority', async () => {
    const actor = 'user_01JP0000000000000000000011'
    const groupId = await createGroupFor(actor)
    const listId = await createTasksList(actor, groupId)
    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ title: 'Buy milk', position: 0 }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      listId,
      title: 'Buy milk',
      status: 'todo',
      priority: 'medium',
      completed: false,
      createdBy: actor,
    })
    expect((body.id as string).startsWith('lit_')).toBe(true)
  })

  it('leaves status/priority null on a non-tasks list item', async () => {
    const actor = 'user_01JP0000000000000000000012'
    const groupId = await createGroupFor(actor)
    const listRes = await app.request('http://localhost/api/v1/sdk/lists', {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ name: 'Notes', listType: 'standard', scopeType: 'list_group', scopeId: groupId }),
    })
    const listId = ((await listRes.json()) as Record<string, unknown>).id as string
    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ title: 'A note', position: 0 }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.status).toBeNull()
    expect(body.priority).toBeNull()
  })

  // --- chores lists are tasks-shaped for priority + dueDate (#546) -------
  // chores is system-managed (#546) — like tasks it keeps priority + dueDate so
  // recurring occurrences land on a calendar day — but it gets NO kanban status.
  it('keeps priority + dueDate on a chores list item, but no status', async () => {
    const actor = 'user_01JP0000000000000000000CH1'
    const groupId = await createGroupFor(actor)
    const listRes = await app.request('http://localhost/api/v1/sdk/lists', {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ name: 'Chores', listType: 'chores', scopeType: 'list_group', scopeId: groupId }),
    })
    const listId = ((await listRes.json()) as Record<string, unknown>).id as string
    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({
        title: 'Take out trash',
        priority: 'high',
        dueDate: '2026-06-15T00:00:00.000Z',
        position: 0,
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.priority).toBe('high')
    expect(body.dueDate).toBe('2026-06-15T00:00:00.000Z')
    // chores gets no kanban status pipeline.
    expect(body.status).toBeNull()
    // Verify the columns actually persisted (not just echoed back).
    const row = await env.DB.prepare('SELECT priority, due_date FROM list_items WHERE id = ?')
      .bind(body.id)
      .first<{ priority: string | null; due_date: string | null }>()
    expect(row?.priority).toBe('high')
    expect(row?.due_date).not.toBeNull()
  })

  // --- diary lists carry a dueDate (the journal day) but no priority/status ---
  // The Planner Diary tab stores each entry's day in dueDate; without widening
  // dueDate persistence to `diary` it was nulled (standard-shaped default),
  // making every entry read as "No date".
  it('keeps dueDate on a diary list item but null priority/status (create + update)', async () => {
    const actor = 'user_01JP0000000000000000000DR1'
    const groupId = await createGroupFor(actor)
    const listRes = await app.request('http://localhost/api/v1/sdk/lists', {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ name: 'Diary', listType: 'diary', scopeType: 'list_group', scopeId: groupId }),
    })
    const listId = ((await listRes.json()) as Record<string, unknown>).id as string

    // Create with a date-only dueDate (what the diary UI sends).
    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ title: 'Jun 15, 2026', notes: 'a good day', dueDate: '2026-06-15', position: 0 }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.dueDate).toBe('2026-06-15T00:00:00.000Z')
    expect(body.priority).toBeNull()
    expect(body.status).toBeNull()
    // Persisted, not just echoed.
    const row = await env.DB.prepare('SELECT due_date FROM list_items WHERE id = ?')
      .bind(body.id)
      .first<{ due_date: string | null }>()
    expect(row?.due_date).not.toBeNull()

    // PATCH the day — the EntryEditor lets the user change the date.
    const patch = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items/${body.id}`, {
      method: 'PATCH',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ dueDate: '2026-07-01' }),
    })
    expect(patch.status).toBe(200)
    expect(((await patch.json()) as Record<string, unknown>).dueDate).toBe('2026-07-01T00:00:00.000Z')
  })

  // chores is undeletable via the SDK (system-managed, like shopping/notes).
  it('rejects deleting a chores list (system-managed)', async () => {
    const actor = 'user_01JP0000000000000000000CH2'
    const groupId = await createGroupFor(actor)
    const listRes = await app.request('http://localhost/api/v1/sdk/lists', {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ name: 'Chores', listType: 'chores', scopeType: 'list_group', scopeId: groupId }),
    })
    const listId = ((await listRes.json()) as Record<string, unknown>).id as string
    const delRes = await app.request(`http://localhost/api/v1/sdk/lists/${listId}`, {
      method: 'DELETE',
      headers: sdkHeaders(actor),
    })
    expect(delRes.status).toBe(409)
  })

  // --- priority null / omit / value on SDK create route (real D1) --------
  // These cases cover the bug where sdk-writes.ts used `body.priority ?? 'medium'`
  // which coerced an explicit null back to 'medium'. The fix uses `body.priority`
  // directly (schema already turns omitted→'medium', explicit null→null).

  it('SDK create with priority: null stores NULL in D1 (no-priority task)', async () => {
    const actor = 'user_01JP0000000000000000000013'
    const groupId = await createGroupFor(actor)
    const listId = await createTasksList(actor, groupId)
    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ title: 'No priority task', priority: null, position: 0 }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.priority).toBeNull()

    // Assert the stored D1 column is NULL (re-fetch directly from DB).
    const row = await env.DB.prepare('SELECT priority FROM list_items WHERE id = ?')
      .bind(body.id as string)
      .first<{ priority: string | null }>()
    expect(row?.priority).toBeNull()
  })

  it('SDK create with priority omitted stores "medium" in D1 (backward-compat default)', async () => {
    const actor = 'user_01JP0000000000000000000014'
    const groupId = await createGroupFor(actor)
    const listId = await createTasksList(actor, groupId)
    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ title: 'Default priority task', position: 0 }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.priority).toBe('medium')

    // Assert stored column is 'medium'.
    const row = await env.DB.prepare('SELECT priority FROM list_items WHERE id = ?')
      .bind(body.id as string)
      .first<{ priority: string | null }>()
    expect(row?.priority).toBe('medium')
  })

  it('SDK create with priority: "high" stores "high" in D1', async () => {
    const actor = 'user_01JP0000000000000000000015'
    const groupId = await createGroupFor(actor)
    const listId = await createTasksList(actor, groupId)
    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ title: 'High priority task', priority: 'high', position: 0 }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.priority).toBe('high')

    // Assert stored column is 'high'.
    const row = await env.DB.prepare('SELECT priority FROM list_items WHERE id = ?')
      .bind(body.id as string)
      .first<{ priority: string | null }>()
    expect(row?.priority).toBe('high')
  })

  it('trusts an opaque (Events group) scope — no membership check', async () => {
    const list = await repos.lists.create({
      id: `lst_${ulid()}`,
      tenantId: 'rallypoint',
      scopeType: 'group',
      scopeId: `group_${ulid()}`,
      listType: 'tasks',
      name: 'Crew tasks',
      visibility: 'all',
      color: null,
      createdBy: 'user_seed',
    })
    const res = await app.request(`http://localhost/api/v1/sdk/lists/${list.id}/items`, {
      method: 'POST',
      headers: sdkHeaders('user_01JP0000000000000000000016'),
      body: JSON.stringify({ title: 'Trusted write', position: 0 }),
    })
    expect(res.status).toBe(201)
  })

  it('404s creating an item in a list the actor cannot access', async () => {
    const owner = 'user_01JP0000000000000000000017'
    const intruder = 'user_01JP0000000000000000000018'
    const groupId = await createGroupFor(owner)
    const listId = await createTasksList(owner, groupId)
    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      method: 'POST',
      headers: sdkHeaders(intruder),
      body: JSON.stringify({ title: 'Nope', position: 0 }),
    })
    expect(res.status).toBe(404)
  })

  // --- item update / check-off --------------------------------------

  it('checks off an item via PATCH completed', async () => {
    const actor = 'user_01JP0000000000000000000019'
    const groupId = await createGroupFor(actor)
    const listId = await createTasksList(actor, groupId)
    const createRes = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ title: 'Walk dog', position: 0 }),
    })
    const itemId = ((await createRes.json()) as Record<string, unknown>).id as string

    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items/${itemId}`, {
      method: 'PATCH',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ completed: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.completed).toBe(true)
    expect(body.completedAt).not.toBeNull()
  })

  it('rejects a cross-list move on PATCH', async () => {
    const actor = 'user_01JP0000000000000000000020'
    const groupId = await createGroupFor(actor)
    const listId = await createTasksList(actor, groupId, 'Source')
    const otherListId = await createTasksList(actor, groupId, 'Target')
    const createRes = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ title: 'Stays put', position: 0 }),
    })
    const itemId = ((await createRes.json()) as Record<string, unknown>).id as string

    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items/${itemId}`, {
      method: 'PATCH',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ listId: otherListId }),
    })
    expect(res.status).toBe(400)
  })

  it('404s PATCH on an item in a different list', async () => {
    const actor = 'user_01JP0000000000000000000021'
    const groupId = await createGroupFor(actor)
    const listA = await createTasksList(actor, groupId, 'A')
    const listB = await createTasksList(actor, groupId, 'B')
    const createRes = await app.request(`http://localhost/api/v1/sdk/lists/${listA}/items`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ title: 'In A', position: 0 }),
    })
    const itemId = ((await createRes.json()) as Record<string, unknown>).id as string

    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listB}/items/${itemId}`, {
      method: 'PATCH',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ completed: true }),
    })
    expect(res.status).toBe(404)
  })

  // --- item delete --------------------------------------------------

  it('soft-deletes an item via DELETE', async () => {
    const actor = 'user_01JP0000000000000000000022'
    const groupId = await createGroupFor(actor)
    const listId = await createTasksList(actor, groupId)
    const createRes = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ title: 'Delete me', position: 0 }),
    })
    const itemId = ((await createRes.json()) as Record<string, unknown>).id as string

    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items/${itemId}`, {
      method: 'DELETE',
      headers: sdkHeaders(actor),
    })
    expect(res.status).toBe(204)

    // D1: flat table name.
    const row = await env.DB.prepare('SELECT deleted_at FROM list_items WHERE id = ?')
      .bind(itemId)
      .first<{ deleted_at: number | null }>()
    expect(row?.deleted_at).not.toBeNull()
  })

  // --- field-def write surface (slice 13) ---------------------------

  async function createFieldDef(
    actor: string,
    listId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/fields`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(201)
    return (await res.json()) as Record<string, unknown>
  }

  it('creates a field def with a derived key and minted choice ids', async () => {
    const actor = 'user_01JP0000000000000000000023'
    const groupId = await createGroupFor(actor)
    const listId = await createTasksList(actor, groupId)
    const def = await createFieldDef(actor, listId, {
      label: 'Priority Level',
      fieldType: 'single_select',
      required: true,
      choices: [{ label: 'Low' }, { label: 'High' }],
    })
    expect(def).toMatchObject({
      listId,
      label: 'Priority Level',
      fieldType: 'single_select',
      required: true,
      createdBy: actor,
    })
    expect((def.id as string).startsWith('lfd_')).toBe(true)
    expect(def.key).toBe('priority_level')
    const choices = (def.options as { choices: Array<{ id: string; label: string }> }).choices
    expect(choices.map((c) => c.label)).toEqual(['Low', 'High'])
    expect(choices.every((c) => c.id.startsWith('opt_'))).toBe(true)
    expect(def).not.toHaveProperty('tenantId')
    expect(def).not.toHaveProperty('deletedAt')
  })

  it('round-trips create → list → update → delete', async () => {
    const actor = 'user_01JP0000000000000000000024'
    const groupId = await createGroupFor(actor)
    const listId = await createTasksList(actor, groupId)
    const def = await createFieldDef(actor, listId, { label: 'Notes', fieldType: 'text' })
    const fieldId = def.id as string

    const listRes = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/fields`, {
      headers: { ...bearer(envVars.PLANNER_API_KEY!), 'x-actor': actor },
    })
    expect(listRes.status).toBe(200)
    expect(((await listRes.json()) as unknown[]).length).toBe(1)

    const patchRes = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/fields/${fieldId}`, {
      method: 'PATCH',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ label: 'Renamed', required: true }),
    })
    expect(patchRes.status).toBe(200)
    expect(await patchRes.json()).toMatchObject({ label: 'Renamed', required: true })

    const delRes = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/fields/${fieldId}`, {
      method: 'DELETE',
      headers: sdkHeaders(actor),
    })
    expect(delRes.status).toBe(204)

    // D1: flat table name.
    const row = await env.DB.prepare('SELECT deleted_at FROM list_field_defs WHERE id = ?')
      .bind(fieldId)
      .first<{ deleted_at: number | null }>()
    expect(row?.deleted_at).not.toBeNull()
  })

  it('rejects choices on a non-select field (validation passthrough)', async () => {
    const actor = 'user_01JP0000000000000000000025'
    const groupId = await createGroupFor(actor)
    const listId = await createTasksList(actor, groupId)
    const def = await createFieldDef(actor, listId, { label: 'Plain', fieldType: 'text' })
    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/fields/${def.id as string}`, {
      method: 'PATCH',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ choices: [{ label: 'Nope' }] }),
    })
    expect(res.status).toBe(400)
  })

  it('400s when x-actor is missing on a field create', async () => {
    const actor = 'user_01JP0000000000000000000026'
    const groupId = await createGroupFor(actor)
    const listId = await createTasksList(actor, groupId)
    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/fields`, {
      method: 'POST',
      headers: { ...bearer(envVars.PLANNER_API_KEY!), 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'X', fieldType: 'text' }),
    })
    expect(res.status).toBe(400)
  })

  it('404s creating a field on a list the actor cannot access', async () => {
    const owner = 'user_01JP0000000000000000000027'
    const intruder = 'user_01JP0000000000000000000028'
    const groupId = await createGroupFor(owner)
    const listId = await createTasksList(owner, groupId)
    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/fields`, {
      method: 'POST',
      headers: sdkHeaders(intruder),
      body: JSON.stringify({ label: 'Sneaky', fieldType: 'text' }),
    })
    expect(res.status).toBe(404)
  })

  it('404s updating a field whose listId does not match the path (cross-list isolation)', async () => {
    const actor = 'user_01JP0000000000000000000029'
    const groupId = await createGroupFor(actor)
    const listA = await createTasksList(actor, groupId, 'A')
    const listB = await createTasksList(actor, groupId, 'B')
    const def = await createFieldDef(actor, listA, { label: 'OnlyA', fieldType: 'text' })
    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listB}/fields/${def.id as string}`, {
      method: 'PATCH',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ label: 'Hijack' }),
    })
    expect(res.status).toBe(404)
  })

  // --- SDK list soft-delete -------------------------------------------

  it('SDK: group member soft-deletes a list → 204, subsequent reads 404', async () => {
    const actor = 'user_01JP0000000000000000000030'
    const groupId = await createGroupFor(actor)
    const listId = await createTasksList(actor, groupId, 'My tasks')

    // DELETE → 204
    const delRes = await app.request(`http://localhost/api/v1/sdk/lists/${listId}`, {
      method: 'DELETE',
      headers: sdkHeaders(actor),
    })
    expect(delRes.status).toBe(204)

    // Subsequent SDK item create on the deleted list → 404
    const itemRes = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ title: 'Should fail', position: 0 }),
    })
    expect(itemRes.status).toBe(404)

    // DB row has deletedAt set
    const row = await repos.lists.findById(listId)
    expect(row).not.toBeNull()
    expect(row!.deletedAt).not.toBeNull()
  })

  it('SDK: non-member / foreign actor gets 404 on list delete', async () => {
    const owner = 'user_01JP0000000000000000000031'
    const intruder = 'user_01JP0000000000000000000032'
    const groupId = await createGroupFor(owner)
    const listId = await createTasksList(owner, groupId, 'Private tasks')

    const delRes = await app.request(`http://localhost/api/v1/sdk/lists/${listId}`, {
      method: 'DELETE',
      headers: sdkHeaders(intruder),
    })
    expect(delRes.status).toBe(404)

    // List still lives
    const row = await repos.lists.findById(listId)
    expect(row).not.toBeNull()
    expect(row!.deletedAt).toBeNull()
  })

  // --- SDK system-managed list type delete guard (#443) ---------------

  it('SDK: rejects DELETE on a shopping list with 409 system_managed_list', async () => {
    const actor = 'user_01JP0000000000000000000033'
    const groupId = await createGroupFor(actor)

    const createRes = await app.request('http://localhost/api/v1/sdk/lists', {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({
        name: 'My Groceries',
        listType: 'shopping',
        scopeType: 'list_group',
        scopeId: groupId,
      }),
    })
    expect(createRes.status).toBe(201)
    const listId = ((await createRes.json()) as Record<string, unknown>).id as string

    const delRes = await app.request(`http://localhost/api/v1/sdk/lists/${listId}`, {
      method: 'DELETE',
      headers: sdkHeaders(actor),
    })
    expect(delRes.status).toBe(409)
    const body = (await delRes.json()) as { error: { code: string } }
    expect(body.error.code).toBe('system_managed_list')

    // The list must still exist (not soft-deleted).
    const row = await repos.lists.findById(listId)
    expect(row).not.toBeNull()
    expect(row!.deletedAt).toBeNull()
  })

  it('SDK: rejects DELETE on a notes list with 409 system_managed_list', async () => {
    const actor = 'user_01JP0000000000000000000034'
    const groupId = await createGroupFor(actor)

    const createRes = await app.request('http://localhost/api/v1/sdk/lists', {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({
        name: 'My Notes',
        listType: 'notes',
        scopeType: 'list_group',
        scopeId: groupId,
      }),
    })
    expect(createRes.status).toBe(201)
    const listId = ((await createRes.json()) as Record<string, unknown>).id as string

    const delRes = await app.request(`http://localhost/api/v1/sdk/lists/${listId}`, {
      method: 'DELETE',
      headers: sdkHeaders(actor),
    })
    expect(delRes.status).toBe(409)
    const body = (await delRes.json()) as { error: { code: string } }
    expect(body.error.code).toBe('system_managed_list')

    const row = await repos.lists.findById(listId)
    expect(row).not.toBeNull()
    expect(row!.deletedAt).toBeNull()
  })

  it('SDK: still allows DELETE on a tasks-type list (non-system-managed)', async () => {
    const actor = 'user_01JP0000000000000000000035'
    const groupId = await createGroupFor(actor)
    const listId = await createTasksList(actor, groupId, 'Deletable tasks')

    const delRes = await app.request(`http://localhost/api/v1/sdk/lists/${listId}`, {
      method: 'DELETE',
      headers: sdkHeaders(actor),
    })
    expect(delRes.status).toBe(204)

    // Confirm it was soft-deleted.
    const row = await repos.lists.findById(listId)
    expect(row).not.toBeNull()
    expect(row!.deletedAt).not.toBeNull()
  })

  // --- shopping list auto-categorization (SDK route — the path Planner uses) ---

  // Helper: create a shopping list for an actor and return its id.
  async function createShoppingList(actor: string, groupId: string, name = 'Weekly shop'): Promise<string> {
    const res = await app.request('http://localhost/api/v1/sdk/lists', {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ name, listType: 'shopping', scopeType: 'list_group', scopeId: groupId }),
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as Record<string, unknown>).id as string
  }

  it('SDK: auto-assigns category on shopping list item create (title-based)', async () => {
    const actor = 'user_01JP0000000000000000000036'
    const groupId = await createGroupFor(actor)
    const listId = await createShoppingList(actor, groupId)

    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ title: 'Whole milk', position: 0 }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    const cf = body.customFields as Record<string, unknown>
    expect(cf['rp:category']).toBe('dairy')

    // Verify the category is actually stored in D1.
    const row = await env.DB.prepare('SELECT custom_fields FROM list_items WHERE id = ?')
      .bind(body.id as string)
      .first<{ custom_fields: string }>()
    const stored = JSON.parse(row!.custom_fields) as Record<string, unknown>
    expect(stored['rp:category']).toBe('dairy')
  })

  it('SDK: explicit client-supplied category is NOT overwritten on create', async () => {
    const actor = 'user_01JP0000000000000000000037'
    const groupId = await createGroupFor(actor)
    const listId = await createShoppingList(actor, groupId)

    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({
        title: 'Milk',
        position: 0,
        customFields: { 'rp:category': 'household' }, // explicit override
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    const cf = body.customFields as Record<string, unknown>
    // Client explicitly said 'household' — must NOT be overwritten by categorize()
    expect(cf['rp:category']).toBe('household')
  })

  it('SDK: category override via PATCH persists and survives round-trip', async () => {
    const actor = 'user_01JP0000000000000000000038'
    const groupId = await createGroupFor(actor)
    const listId = await createShoppingList(actor, groupId)

    const createRes = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ title: 'Butter', position: 0 }),
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as Record<string, unknown>
    const itemId = created.id as string
    // Auto-categorized as 'dairy' on create.
    expect((created.customFields as Record<string, unknown>)['rp:category']).toBe('dairy')

    // Override category to 'pantry' via PATCH.
    const patchRes = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items/${itemId}`, {
      method: 'PATCH',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ customFields: { 'rp:category': 'pantry' } }),
    })
    expect(patchRes.status).toBe(200)
    const patchBody = (await patchRes.json()) as Record<string, unknown>
    const cf = patchBody.customFields as Record<string, unknown>
    expect(cf['rp:category']).toBe('pantry')

    // Verify D1 has the new category.
    const row = await env.DB.prepare('SELECT custom_fields FROM list_items WHERE id = ?')
      .bind(itemId)
      .first<{ custom_fields: string }>()
    const stored = JSON.parse(row!.custom_fields) as Record<string, unknown>
    expect(stored['rp:category']).toBe('pantry')
  })

  it('SDK: items in a tasks list do NOT get auto-categorized', async () => {
    const actor = 'user_01JP0000000000000000000039'
    const groupId = await createGroupFor(actor)
    const listId = await createTasksList(actor, groupId)

    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ title: 'Buy milk', position: 0 }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    const cf = body.customFields as Record<string, unknown>
    // Tasks list must NOT get a category key
    expect(cf['rp:category']).toBeUndefined()
  })

  // --- autoCategorize flag (issue #542) ----------------------------------------

  it('SDK: autoCategorize: false skips keyword assignment on shopping list create', async () => {
    const actor = 'user_01JP0000000000000000000040'
    const groupId = await createGroupFor(actor)
    const listId = await createShoppingList(actor, groupId)

    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ title: 'Whole milk', position: 0, autoCategorize: false }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    const cf = body.customFields as Record<string, unknown>
    // autoCategorize: false → no rp:category set (not 'dairy', not 'other')
    expect(cf['rp:category']).toBeUndefined()

    // Verify D1 stores no category either.
    const row = await env.DB.prepare('SELECT custom_fields FROM list_items WHERE id = ?')
      .bind(body.id as string)
      .first<{ custom_fields: string }>()
    const stored = JSON.parse(row!.custom_fields) as Record<string, unknown>
    expect(stored['rp:category']).toBeUndefined()
  })

  it('SDK: autoCategorize: false with explicit rp:category still uses client value', async () => {
    const actor = 'user_01JP0000000000000000000041'
    const groupId = await createGroupFor(actor)
    const listId = await createShoppingList(actor, groupId)

    // Even with autoCategorize: false, an explicit client-supplied category wins.
    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({
        title: 'Mystery item',
        position: 0,
        autoCategorize: false,
        customFields: { 'rp:category': 'pantry' },
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    const cf = body.customFields as Record<string, unknown>
    expect(cf['rp:category']).toBe('pantry')
  })

  it('SDK: autoCategorize: true (explicit) still categorizes by title', async () => {
    const actor = 'user_01JP0000000000000000000042'
    const groupId = await createGroupFor(actor)
    const listId = await createShoppingList(actor, groupId)

    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ title: 'Chicken breast', position: 0, autoCategorize: true }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    const cf = body.customFields as Record<string, unknown>
    expect(cf['rp:category']).toBe('meat-seafood')
  })

  // --- cross-list move endpoint (#549) ------------------------------

  async function createListOfType(
    actor: string,
    groupId: string,
    listType: string,
    name: string,
  ): Promise<string> {
    const res = await app.request('http://localhost/api/v1/sdk/lists', {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ name, listType, scopeType: 'list_group', scopeId: groupId }),
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as Record<string, unknown>).id as string
  }

  async function createItem(
    actor: string,
    listId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(201)
    return (await res.json()) as Record<string, unknown>
  }

  function moveItem(actor: string, listId: string, itemId: string, targetListId: string) {
    return app.request(`http://localhost/api/v1/sdk/lists/${listId}/items/${itemId}/move`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ targetListId }),
    })
  }

  it('move: happy path — re-appends position at the target max+1', async () => {
    const actor = 'user_01JP0000000000000000000050'
    const groupId = await createGroupFor(actor)
    const source = await createListOfType(actor, groupId, 'notes', 'Inbox')
    const target = await createListOfType(actor, groupId, 'notes', 'Archive')
    // Two items already in target → positions 0 and 1.
    await createItem(actor, target, { title: 'a', priority: null })
    await createItem(actor, target, { title: 'b', priority: null })
    const item = await createItem(actor, source, { title: 'moved', priority: null })

    const res = await moveItem(actor, source, item.id as string, target)
    expect(res.status).toBe(200)
    const moved = (await res.json()) as Record<string, unknown>
    expect(moved.listId).toBe(target)
    expect(moved.position).toBe(2) // appended after the two existing items
  })

  it('move: 404 when the actor does not own the SOURCE list', async () => {
    const owner = 'user_01JP0000000000000000000051'
    const stranger = 'user_01JP0000000000000000000052'
    const groupId = await createGroupFor(owner)
    const source = await createListOfType(owner, groupId, 'notes', 'Inbox')
    const target = await createListOfType(owner, groupId, 'notes', 'Archive')
    const item = await createItem(owner, source, { title: 'x', priority: null })
    const res = await moveItem(stranger, source, item.id as string, target)
    expect(res.status).toBe(404)
  })

  it('move: 404 when the actor does not own the TARGET list', async () => {
    const owner = 'user_01JP0000000000000000000053'
    const other = 'user_01JP0000000000000000000054'
    const groupId = await createGroupFor(owner)
    const source = await createListOfType(owner, groupId, 'notes', 'Inbox')
    const item = await createItem(owner, source, { title: 'x', priority: null })
    // A target list the actor cannot access (owned by someone else).
    const otherGroup = await createGroupFor(other)
    const foreignTarget = await createListOfType(other, otherGroup, 'notes', 'Theirs')
    const res = await moveItem(owner, source, item.id as string, foreignTarget)
    expect(res.status).toBe(404)
  })

  it('move: 404 when the target list is soft-deleted', async () => {
    const actor = 'user_01JP0000000000000000000055'
    const groupId = await createGroupFor(actor)
    const source = await createListOfType(actor, groupId, 'notes', 'Inbox')
    const target = await createListOfType(actor, groupId, 'tasks', 'Trash')
    const item = await createItem(actor, source, { title: 'x', priority: null })
    const del = await app.request(`http://localhost/api/v1/sdk/lists/${target}`, {
      method: 'DELETE',
      headers: sdkHeaders(actor),
    })
    expect(del.status).toBe(204)
    const res = await moveItem(actor, source, item.id as string, target)
    expect(res.status).toBe(404)
  })

  it('move: 400 when target == source', async () => {
    const actor = 'user_01JP0000000000000000000056'
    const groupId = await createGroupFor(actor)
    const source = await createListOfType(actor, groupId, 'notes', 'Inbox')
    const item = await createItem(actor, source, { title: 'x', priority: null })
    const res = await moveItem(actor, source, item.id as string, source)
    expect(res.status).toBe(400)
  })

  it('move: 404 when the item does not belong to the source list', async () => {
    const actor = 'user_01JP0000000000000000000057'
    const groupId = await createGroupFor(actor)
    const source = await createListOfType(actor, groupId, 'notes', 'Inbox')
    const other = await createListOfType(actor, groupId, 'notes', 'Other')
    const target = await createListOfType(actor, groupId, 'notes', 'Archive')
    const item = await createItem(actor, other, { title: 'x', priority: null })
    const res = await moveItem(actor, source, item.id as string, target)
    expect(res.status).toBe(404)
  })

  it('move: 422 for a recurring-series occurrence item', async () => {
    const actor = 'user_01JP0000000000000000000058'
    const groupId = await createGroupFor(actor)
    const source = await createTasksList(actor, groupId, 'Recurring')
    const target = await createTasksList(actor, groupId, 'Target')
    // Create a daily series → materializes occurrences carrying seriesId.
    const seriesRes = await app.request(`http://localhost/api/v1/sdk/lists/${source}/series`, {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({
        title: 'Standup',
        freq: 'daily',
        interval: 1,
        dtstart: '2026-06-10',
      }),
    })
    expect(seriesRes.status).toBe(201)
    // Find a materialized occurrence (seriesId != null).
    const itemsRes = await app.request(`http://localhost/api/v1/sdk/lists/${source}/items`, {
      headers: { ...bearer(envVars.PLANNER_API_KEY!), 'x-actor': actor },
    })
    const items = (await itemsRes.json()) as Array<Record<string, unknown>>
    const occ = items.find((i) => i.seriesId !== null)
    expect(occ).toBeDefined()
    const res = await moveItem(actor, source, occ!.id as string, target)
    expect(res.status).toBe(422)
  })

  it('move: drops custom-field values whose def-id is not live in the target', async () => {
    const actor = 'user_01JP0000000000000000000059'
    const groupId = await createGroupFor(actor)
    const source = await createTasksList(actor, groupId, 'Src')
    const target = await createTasksList(actor, groupId, 'Tgt')
    // A field def on the SOURCE only; the value keyed by its id must be dropped
    // on move (the target has no such def).
    const def = await createFieldDef(actor, source, { label: 'Owner', fieldType: 'text' })
    const item = await createItem(actor, source, {
      title: 'x',
      priority: null,
      customFields: { [def.id as string]: 'alice' },
    })
    expect((item.customFields as Record<string, unknown>)[def.id as string]).toBe('alice')
    const res = await moveItem(actor, source, item.id as string, target)
    expect(res.status).toBe(200)
    const moved = (await res.json()) as Record<string, unknown>
    expect(moved.customFields).toEqual({})
  })

  it('move: clears statusId when it is not a live status of the target', async () => {
    const actor = 'user_01JP0000000000000000000060'
    const groupId = await createGroupFor(actor)
    const source = await createTasksList(actor, groupId, 'Src')
    const target = await createTasksList(actor, groupId, 'Tgt')
    // A tasks-list item gets a statusId from the source's seeded statuses.
    const item = await createItem(actor, source, { title: 'x', priority: null, status: 'todo' })
    expect(item.statusId).not.toBeNull()
    const res = await moveItem(actor, source, item.id as string, target)
    expect(res.status).toBe(200)
    const moved = (await res.json()) as Record<string, unknown>
    // The source's status id is meaningless in the target's seeded set → cleared.
    expect(moved.statusId).toBeNull()
    // Legacy status text is list-type-agnostic and stays.
    expect(moved.status).toBe('todo')
  })

  // --- find an item by id within a scope (#559) --------------------

  it('finds an item by id within its scope, returning the item with its listId', async () => {
    const actor = 'user_01JP0000000000000000000061'
    const groupId = await createGroupFor(actor)
    const listId = await createListOfType(actor, groupId, 'notes', 'Inbox')
    const item = await createItem(actor, listId, { title: 'note', position: 0 })
    const res = await app.request(
      `http://localhost/api/v1/sdk/scopes/list_group/${groupId}/items/${item.id as string}`,
      { headers: sdkHeaders(actor) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.id).toBe(item.id)
    expect(body.listId).toBe(listId)
  })

  it('404s the scoped lookup when the item lives in a different scope', async () => {
    const actor = 'user_01JP0000000000000000000062'
    const groupA = await createGroupFor(actor, 'A')
    const groupB = await createGroupFor(actor, 'B')
    const listA = await createListOfType(actor, groupA, 'notes', 'Inbox')
    const item = await createItem(actor, listA, { title: 'note', position: 0 })
    // Same actor, but querying group B — the item lives in group A, so 404
    // (the route checks the item's parent list is in the exact scope).
    const res = await app.request(
      `http://localhost/api/v1/sdk/scopes/list_group/${groupB}/items/${item.id as string}`,
      { headers: sdkHeaders(actor) },
    )
    expect(res.status).toBe(404)
  })

  it('404s the scoped lookup for a non-member actor (no cross-user item leak)', async () => {
    const owner = 'user_01JP0000000000000000000063'
    const intruder = 'user_01JP0000000000000000000064'
    const groupId = await createGroupFor(owner)
    const listId = await createListOfType(owner, groupId, 'notes', 'Inbox')
    const item = await createItem(owner, listId, { title: 'secret', position: 0 })
    const res = await app.request(
      `http://localhost/api/v1/sdk/scopes/list_group/${groupId}/items/${item.id as string}`,
      { headers: sdkHeaders(intruder) },
    )
    expect(res.status).toBe(404)
  })

  it('404s the scoped lookup for an unknown item id', async () => {
    const actor = 'user_01JP0000000000000000000065'
    const groupId = await createGroupFor(actor)
    const res = await app.request(
      `http://localhost/api/v1/sdk/scopes/list_group/${groupId}/items/lit_does_not_exist`,
      { headers: sdkHeaders(actor) },
    )
    expect(res.status).toBe(404)
  })

  // --- notes-folder name uniqueness backstop (#559) ----------------

  it('409s a duplicate live notes-folder name in the same scope', async () => {
    const actor = 'user_01JP0000000000000000000066'
    const groupId = await createGroupFor(actor)
    await createListOfType(actor, groupId, 'notes', 'Recipes')
    const dup = await app.request('http://localhost/api/v1/sdk/lists', {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ name: 'Recipes', listType: 'notes', scopeType: 'list_group', scopeId: groupId }),
    })
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as { error?: { code?: string } }).error?.code).toBe('list_name_conflict')
  })

  it('lets a freed notes-folder name be reused after the first is soft-deleted', async () => {
    const actor = 'user_01JP0000000000000000000067'
    const groupId = await createGroupFor(actor)
    const first = await createListOfType(actor, groupId, 'notes', 'Archive')
    // notes lists are system-managed (no SDK delete), so soft-delete directly
    // to model the pruner/contract path freeing the name. The partial index
    // excludes deleted rows, so the name becomes available again.
    await env.DB.prepare('UPDATE lists SET deleted_at = ? WHERE id = ?').bind(Date.now(), first).run()
    const reuse = await app.request('http://localhost/api/v1/sdk/lists', {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ name: 'Archive', listType: 'notes', scopeType: 'list_group', scopeId: groupId }),
    })
    expect(reuse.status).toBe(201)
  })

  it('does NOT constrain duplicate names for non-notes list types', async () => {
    const actor = 'user_01JP0000000000000000000068'
    const groupId = await createGroupFor(actor)
    await createListOfType(actor, groupId, 'standard', 'Groceries')
    // A second standard list with the same name is allowed — the unique index
    // is scoped to notes only, so RPL's duplicate-name lists keep working.
    const second = await app.request('http://localhost/api/v1/sdk/lists', {
      method: 'POST',
      headers: sdkHeaders(actor),
      body: JSON.stringify({ name: 'Groceries', listType: 'standard', scopeType: 'list_group', scopeId: groupId }),
    })
    expect(second.status).toBe(201)
  })
})
