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

// D1 integration tests for the /api/v1/sdk/lists peer-app surface.
// Replaces sdk-lists.it.test.ts. Raw SQL queries use env.DB.prepare()
// with flat table names (no `lists_v1.` prefix — D1 has no schemas).

const TENANT = 'rallypoint'

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

describe('D1 integration — SDK lists surface', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services, realtime: undefined })
  })

  async function seedList(scopeId: string, name: string): Promise<string> {
    const list = await repos.lists.create({
      id: `lst_${ulid()}`,
      tenantId: TENANT,
      scopeType: 'group',
      scopeId,
      listType: 'tasks',
      name,
      visibility: 'all',
      color: null,
      createdBy: 'user_seed',
    })
    return list.id
  }

  async function seedItem(
    listId: string,
    title: string,
    over: Partial<{
      dueDate: Date
      status: 'todo' | 'in_progress' | 'done'
      priority: 'low' | 'medium' | 'high'
      customFields: Record<string, unknown>
    }> = {},
  ): Promise<string> {
    const item = await repos.listItems.create({
      id: `lit_${ulid()}`,
      tenantId: TENANT,
      listId,
      title,
      createdBy: 'user_seed',
      ...over,
    })
    return item.id
  }

  async function seedFieldDef(
    listId: string,
    over: Partial<{ key: string; label: string; fieldType: 'text' | 'number'; options: Record<string, unknown> }> = {},
  ): Promise<string> {
    const def = await repos.fieldDefs.create({
      id: `lfd_${ulid()}`,
      tenantId: TENANT,
      listId,
      key: over.key ?? 'budget',
      label: over.label ?? 'Budget',
      fieldType: over.fieldType ?? 'number',
      options: over.options ?? {},
      createdBy: 'user_seed',
    })
    return def.id
  }

  function bearer(key: string): Record<string, string> {
    return { authorization: `Bearer ${key}` }
  }

  it('404s when no peer key is configured (route absent on this deployment)', async () => {
    const prodEnv = parseEnv({
      NODE_ENV: 'production',
      LOG_LEVEL: 'fatal',
      LISTS_API_KEY: 'x'.repeat(40),
      LISTS_SESSION_KEY_V1: 'y'.repeat(40),
      REALTIME_TOKEN_HMAC_KEY: 'z'.repeat(40),
    })
    expect(prodEnv.EVENTS_API_KEY).toBeUndefined()
    const noKeyApp = buildApp({ env: prodEnv, logger: undefined, repos, services, realtime: undefined })
    const res = await noKeyApp.request(
      'http://localhost/api/v1/sdk/lists?scope_type=group&scope_id=group_x',
      { headers: bearer('y'.repeat(40)) },
    )
    expect(res.status).toBe(404)
  })

  it('403s on a missing or wrong bearer', async () => {
    const none = await app.request(
      'http://localhost/api/v1/sdk/lists?scope_type=group&scope_id=group_x',
    )
    expect(none.status).toBe(403)

    const wrong = await app.request(
      'http://localhost/api/v1/sdk/lists?scope_type=group&scope_id=group_x',
      { headers: bearer('not-the-key') },
    )
    expect(wrong.status).toBe(403)
  })

  it('400s on invalid scope params', async () => {
    const res = await app.request('http://localhost/api/v1/sdk/lists?scope_type=bogus', {
      headers: bearer(envVars.EVENTS_API_KEY),
    })
    expect(res.status).toBe(400)
  })

  it('returns a flat camelCase ListDto[] for a populated scope, isolated by scope', async () => {
    const groupId = `group_${Date.now()}`
    const otherGroupId = `group_other_${Date.now()}`
    const id = await seedList(groupId, 'Build call sheet')
    await seedList(otherGroupId, 'Should not appear')

    const res = await app.request(
      `http://localhost/api/v1/sdk/lists?scope_type=group&scope_id=${groupId}`,
      { headers: bearer(envVars.EVENTS_API_KEY) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<Record<string, unknown>>
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({
      id,
      scopeType: 'group',
      scopeId: groupId,
      listType: 'tasks',
      name: 'Build call sheet',
      visibility: 'all',
      createdBy: 'user_seed',
    })
    // camelCase, ISO timestamps, no snake_case leakage.
    expect(typeof body[0]!.createdAt).toBe('string')
    expect(body[0]).not.toHaveProperty('scope_type')
    expect(body[0]).not.toHaveProperty('created_at')
    // A freshly-seeded list with no items reports zero incomplete tasks.
    expect(body[0]!.incompleteCount).toBe(0)
  })

  it('reports incompleteCount excluding completed and soft-deleted items', async () => {
    const groupId = `group_count_${Date.now()}`
    const listId = await seedList(groupId, 'Counted tasks')
    // Two open tasks, one done (mirrors completed=true), one soft-deleted.
    await seedItem(listId, 'Open A', { status: 'todo' })
    await seedItem(listId, 'Open B', { status: 'in_progress' })
    await seedItem(listId, 'Finished', { status: 'done' })
    const goneId = await seedItem(listId, 'Removed', { status: 'todo' })
    await repos.listItems.softDelete(goneId, new Date())

    const res = await app.request(
      `http://localhost/api/v1/sdk/lists?scope_type=group&scope_id=${groupId}`,
      { headers: bearer(envVars.EVENTS_API_KEY) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<Record<string, unknown>>
    const counted = body.find((l) => l.id === listId)!
    expect(counted.incompleteCount).toBe(2)
  })

  it('returns a flat camelCase ListItemDto[] for a list', async () => {
    const groupId = `group_items_${Date.now()}`
    const listId = await seedList(groupId, 'Tasks')
    const due = new Date('2026-06-01T17:00:00.000Z')
    await seedItem(listId, 'Soundcheck', { dueDate: due, status: 'todo', priority: 'high' })
    await seedItem(listId, 'Load in')

    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      headers: bearer(envVars.EVENTS_API_KEY),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<Record<string, unknown>>
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(2)
    const soundcheck = body.find((i) => i.title === 'Soundcheck')!
    expect(soundcheck).toMatchObject({
      listId,
      title: 'Soundcheck',
      status: 'todo',
      priority: 'high',
      dueDate: due.toISOString(),
    })
    // camelCase, no snake_case leakage from the UI serializer.
    expect(soundcheck).not.toHaveProperty('list_id')
    expect(soundcheck).not.toHaveProperty('due_date')
    expect(soundcheck).not.toHaveProperty('deleted_at')
    expect(soundcheck).not.toHaveProperty('tenantId')
  })

  it('404s items for a missing list', async () => {
    const res = await app.request('http://localhost/api/v1/sdk/lists/lst_does_not_exist/items', {
      headers: bearer(envVars.EVENTS_API_KEY),
    })
    expect(res.status).toBe(404)
  })

  it('404s items for a soft-deleted list', async () => {
    const groupId = `group_del_${Date.now()}`
    const listId = await seedList(groupId, 'Doomed')
    // D1 flat table names (no `lists_v1.` prefix).
    await env.DB.prepare('UPDATE lists SET deleted_at = ? WHERE id = ?')
      .bind(Date.now(), listId)
      .run()
    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      headers: bearer(envVars.EVENTS_API_KEY),
    })
    expect(res.status).toBe(404)
  })

  it('excludes soft-deleted items', async () => {
    const groupId = `group_softitem_${Date.now()}`
    const listId = await seedList(groupId, 'Tasks')
    await seedItem(listId, 'Keep me')
    const goneId = await seedItem(listId, 'Delete me')
    await repos.listItems.softDelete(goneId, new Date())

    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      headers: bearer(envVars.EVENTS_API_KEY),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<Record<string, unknown>>
    expect(body).toHaveLength(1)
    expect(body[0]!.title).toBe('Keep me')
  })

  it('round-trips customFields on items as camelCase JSONB', async () => {
    const groupId = `group_cf_${Date.now()}`
    const listId = await seedList(groupId, 'Budgeted tasks')
    const defId = await seedFieldDef(listId, { key: 'budget', label: 'Budget', fieldType: 'number' })
    await seedItem(listId, 'Catering', { customFields: { [defId]: 4200 } })

    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      headers: bearer(envVars.EVENTS_API_KEY),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<Record<string, unknown>>
    expect(body).toHaveLength(1)
    expect(body[0]!.customFields).toEqual({ [defId]: 4200 })
    expect(body[0]).not.toHaveProperty('custom_fields')
  })

  it('returns a flat camelCase FieldDefDto[] for a list', async () => {
    const groupId = `group_defs_${Date.now()}`
    const listId = await seedList(groupId, 'Has fields')
    const defId = await seedFieldDef(listId, { key: 'store', label: 'Store', fieldType: 'text' })

    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/fields`, {
      headers: bearer(envVars.EVENTS_API_KEY),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<Record<string, unknown>>
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({
      id: defId,
      listId,
      key: 'store',
      label: 'Store',
      fieldType: 'text',
      createdBy: 'user_seed',
    })
    expect(typeof body[0]!.createdAt).toBe('string')
    expect(body[0]).not.toHaveProperty('list_id')
    expect(body[0]).not.toHaveProperty('field_type')
    expect(body[0]).not.toHaveProperty('deleted_at')
    // tenantId is an internal column — never surfaced to peers.
    expect(body[0]).not.toHaveProperty('tenantId')
  })

  it('404s fields for a missing, soft-deleted, or private list', async () => {
    const missing = await app.request('http://localhost/api/v1/sdk/lists/lst_nope/fields', {
      headers: bearer(envVars.EVENTS_API_KEY),
    })
    expect(missing.status).toBe(404)

    const groupId = `group_deffdel_${Date.now()}`
    const deletedId = await seedList(groupId, 'Doomed')
    await env.DB.prepare('UPDATE lists SET deleted_at = ? WHERE id = ?')
      .bind(Date.now(), deletedId)
      .run()
    const deleted = await app.request(`http://localhost/api/v1/sdk/lists/${deletedId}/fields`, {
      headers: bearer(envVars.EVENTS_API_KEY),
    })
    expect(deleted.status).toBe(404)

    const privateId = await seedList(`group_defpriv_${Date.now()}`, 'Secret')
    await env.DB.prepare("UPDATE lists SET visibility = 'private' WHERE id = ?")
      .bind(privateId)
      .run()
    const priv = await app.request(`http://localhost/api/v1/sdk/lists/${privateId}/fields`, {
      headers: bearer(envVars.EVENTS_API_KEY),
    })
    expect(priv.status).toBe(404)
  })

  it('403s fields on a missing or wrong bearer', async () => {
    const groupId = `group_authdef_${Date.now()}`
    const listId = await seedList(groupId, 'Tasks')
    const none = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/fields`)
    expect(none.status).toBe(403)
    const wrong = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/fields`, {
      headers: bearer('not-the-key'),
    })
    expect(wrong.status).toBe(403)
  })

  it('403s items on a missing or wrong bearer', async () => {
    const groupId = `group_authitem_${Date.now()}`
    const listId = await seedList(groupId, 'Tasks')
    const none = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`)
    expect(none.status).toBe(403)
    const wrong = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/items`, {
      headers: bearer('not-the-key'),
    })
    expect(wrong.status).toBe(403)
  })
})
