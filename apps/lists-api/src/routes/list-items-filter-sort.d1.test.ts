import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { LISTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'
import { validateListQuery } from '@rallypoint/lists-shared'

// D1 integration tests for filter & sort query params. Replaces
// list-items-filter-sort.it.test.ts.
// Note: the D1 repo translates `has_any` (multi_select containment) to a
// json_each membership probe in SQL (no `@>` / GIN on D1) — semantics are
// identical to the memory repo (#327).

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — item filter & sort', () => {
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
  ): Promise<{ id: string; options: { choices: Array<{ id: string; label: string }> } }> {
    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/fields`, body)
    expect(res.status).toBe(201)
    return (await res.json()) as never
  }

  async function createItem(
    bearer: string,
    listId: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, body)
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }

  // Build a GET with repeatable filter/sort params, return matched titles
  // in result order.
  async function query(
    bearer: string,
    listId: string,
    filters: string[],
    sorts: string[],
  ): Promise<string[]> {
    const qs = [
      ...filters.map((f) => `filter=${encodeURIComponent(f)}`),
      ...sorts.map((s) => `sort=${encodeURIComponent(s)}`),
    ].join('&')
    const path = `/api/v1/ui/lists/${listId}/items${qs ? `?${qs}` : ''}`
    const res = await req(bearer, 'GET', path)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<{ title: string }> }
    return body.items.map((i) => i.title)
  }

  // One shared list seeded with three items spanning every field shape the
  // filters/sorts exercise. Each title is unique so assertions read clearly.
  let bearer: string
  let listId: string
  let budgetId: string
  let storeId: string
  let tagsId: string
  let costcoId: string
  let targetId: string
  let redId: string
  let ripeId: string

  beforeAll(async () => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })

    bearer = await loginAs(`user_${Date.now()}_fs`)
    listId = await makeList(bearer)
    const budget = await makeField(bearer, listId, { label: 'Budget', fieldType: 'number' })
    budgetId = budget.id
    const store = await makeField(bearer, listId, {
      label: 'Store',
      fieldType: 'single_select',
      choices: [{ label: 'Costco' }, { label: 'Target' }],
    })
    storeId = store.id
    costcoId = store.options.choices[0]!.id
    targetId = store.options.choices[1]!.id
    const tags = await makeField(bearer, listId, {
      label: 'Tags',
      fieldType: 'multi_select',
      choices: [{ label: 'Red' }, { label: 'Ripe' }],
    })
    tagsId = tags.id
    redId = tags.options.choices[0]!.id
    ripeId = tags.options.choices[1]!.id

    await createItem(bearer, listId, {
      title: 'apples',
      customFields: { [budgetId]: 30, [storeId]: costcoId, [tagsId]: [redId] },
    })
    await createItem(bearer, listId, {
      title: 'bananas',
      customFields: { [budgetId]: 10, [storeId]: targetId },
    })
    await createItem(bearer, listId, {
      title: 'cherries',
      customFields: { [budgetId]: 20, [tagsId]: [redId, ripeId] },
    })
    // Check off cherries so the built-in boolean filter has a true row.
    const items = (await (await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/items`)).json()) as {
      items: Array<{ id: string; title: string }>
    }
    const cherryId = items.items.find((i) => i.title === 'cherries')!.id
    await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/items/${cherryId}`, { completed: true })
  })

  it('returns all rows in default (position) order with no specs', async () => {
    expect(await query(bearer, listId, [], [])).toEqual(['apples', 'bananas', 'cherries'])
  })

  it('filters a built-in boolean column', async () => {
    expect(await query(bearer, listId, ['completed:eq:true'], [])).toEqual(['cherries'])
    expect(await query(bearer, listId, ['completed:eq:false'], [])).toEqual(['apples', 'bananas'])
  })

  it('filters a custom number field with a range op (::numeric cast)', async () => {
    expect(await query(bearer, listId, [`${budgetId}:gte:20`], [])).toEqual(['apples', 'cherries'])
    expect(await query(bearer, listId, [`${budgetId}:lt:20`], [])).toEqual(['bananas'])
  })

  it('filters a custom single-select by choice id', async () => {
    expect(await query(bearer, listId, [`${storeId}:eq:${targetId}`], [])).toEqual(['bananas'])
  })

  it('treats an absent custom value as is_empty', async () => {
    expect(await query(bearer, listId, [`${storeId}:is_empty`], [])).toEqual(['cherries'])
  })

  it('filters a multi-select with has_any (json_each containment)', async () => {
    expect(await query(bearer, listId, [`${tagsId}:has_any:${redId}`], [])).toEqual([
      'apples',
      'cherries',
    ])
    expect(await query(bearer, listId, [`${tagsId}:has_any:${ripeId}`], [])).toEqual(['cherries'])
    // A value no row selected matches nothing (EXISTS finds no json_each row);
    // rows with an absent tags array (bananas) are never matched either.
    expect(await query(bearer, listId, [`${tagsId}:has_any:opt_unselected`], [])).toEqual([])
  })

  it('repo listForList bounds rows at `limit` on real D1 (#472 scan cap)', async () => {
    // The LIMIT short-circuits the per-row json_each scan once enough rows match.
    expect((await repos.listItems.listForList(listId, { limit: 2 })).length).toBe(2)
    // Unset → every row (the bulk-update id-resolution path relies on this).
    expect((await repos.listItems.listForList(listId)).length).toBe(3)
  })

  it('the items endpoint reports filter_truncated:false under the cap (#472)', async () => {
    const res = await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/items`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[]; filter_truncated: boolean }
    expect(body.filter_truncated).toBe(false)
    expect(body.items).toHaveLength(3)
  })

  it('sorts by a custom number ascending and descending (nulls last)', async () => {
    expect(await query(bearer, listId, [], [`${budgetId}:asc`])).toEqual([
      'bananas',
      'cherries',
      'apples',
    ])
    expect(await query(bearer, listId, [], [`${budgetId}:desc`])).toEqual([
      'apples',
      'cherries',
      'bananas',
    ])
  })

  it('sorts by a built-in text column', async () => {
    expect(await query(bearer, listId, [], ['title:desc'])).toEqual([
      'cherries',
      'bananas',
      'apples',
    ])
  })

  it('combines a filter and a sort', async () => {
    expect(await query(bearer, listId, [`${budgetId}:gte:20`], [`${budgetId}:desc`])).toEqual([
      'apples',
      'cherries',
    ])
  })

  it('drops a stale/unknown field spec rather than erroring', async () => {
    // Unknown field id is dropped during validation → no filter applied.
    expect(await query(bearer, listId, ['lfd_ghost:eq:x'], [])).toEqual([
      'apples',
      'bananas',
      'cherries',
    ])
  })

  // Regression: a built-in date column (due_date) is an integer epoch-ms
  // column in D1. Comparing it to an ISO text literal makes SQLite coerce the
  // text to ~year and always mis-compare, so the filter must bind the value as
  // epoch-ms (matches memory.ts's Date.parse compare). dueDate is a tasks-only
  // field, so this uses its own tasks list.
  it('filters a built-in date column (due_date) chronologically', async () => {
    const groupRes = await req(bearer, 'POST', '/api/v1/ui/groups', {
      name: `DateGroup ${Date.now()}_${Math.random().toString(36).slice(2)}`,
    })
    const groupId = ((await groupRes.json()) as { id: string }).id
    const listRes = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'Tasks',
      listType: 'tasks',
      scopeType: 'list_group',
      scopeId: groupId,
    })
    expect(listRes.status).toBe(201)
    const taskListId = ((await listRes.json()) as { id: string }).id

    await createItem(bearer, taskListId, { title: 'early', dueDate: '2025-01-10T00:00:00.000Z' })
    await createItem(bearer, taskListId, { title: 'mid', dueDate: '2025-06-15T00:00:00.000Z' })
    await createItem(bearer, taskListId, { title: 'late', dueDate: '2025-12-20T00:00:00.000Z' })

    expect(await query(bearer, taskListId, ['due_date:gt:2025-06-01'], [])).toEqual(['mid', 'late'])
    expect(await query(bearer, taskListId, ['due_date:lt:2025-06-01'], [])).toEqual(['early'])
    expect(await query(bearer, taskListId, ['due_date:gte:2025-06-15'], [])).toEqual(['mid', 'late'])
    expect(await query(bearer, taskListId, [], ['due_date:desc'])).toEqual(['late', 'mid', 'early'])
  })

  // Regression (P1): the `contains` op builds `LIKE ... ESCAPE '\\'`. Written
  // as `'\'` in the JS template literal it collapses to `ESCAPE ''`, which
  // SQLite rejects at parse time — 500ing every contains filter. This asserts
  // contains works AND that LIKE metacharacters in the search value are
  // escaped (matched literally, not as wildcards). Own list to avoid
  // perturbing the shared-seed ordering assertions above.
  it('filters a built-in text column with contains (LIKE ESCAPE, literal metachars)', async () => {
    const groupRes = await req(bearer, 'POST', '/api/v1/ui/groups', {
      name: `ContainsGroup ${Date.now()}_${Math.random().toString(36).slice(2)}`,
    })
    const groupId = ((await groupRes.json()) as { id: string }).id
    const listRes = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'Contains',
      listType: 'standard',
      scopeType: 'list_group',
      scopeId: groupId,
    })
    expect(listRes.status).toBe(201)
    const clistId = ((await listRes.json()) as { id: string }).id

    await createItem(bearer, clistId, { title: 'apple pie' })
    await createItem(bearer, clistId, { title: 'banana split' })
    await createItem(bearer, clistId, { title: '100% juice' })

    // Basic substring match — this request 500s pre-fix (empty ESCAPE).
    expect(await query(bearer, clistId, ['title:contains:pie'], [])).toEqual(['apple pie'])
    // A '%' in the search value is escaped → matched literally.
    expect(await query(bearer, clistId, ['title:contains:100%'], [])).toEqual(['100% juice'])
    // '%' is NOT a wildcard: 'a%pie' would match 'apple pie' if % were a
    // wildcard, but escaped it is a literal substring → no match.
    expect(await query(bearer, clistId, ['title:contains:a%pie'], [])).toEqual([])
  })

  // Regression guard for the `json_type = 'array'` defensive check in
  // filterToSql's `multi` branch. The validated write path (validateCustomFields)
  // always stores multi values as arrays, so a scalar at a multi-field id is
  // unreachable through normal HTTP writes. We bypass the validator here and
  // insert directly via the repo, then assert that `has_any` returns NO match
  // for the item — confirming the json_type guard blocks the scalar row that
  // json_each would otherwise false-match.
  it('has_any: a scalar stored at a multi-field id is not matched (json_type guard)', async () => {
    // Create an isolated group + list + multi-select field for this test.
    const groupRes = await req(bearer, 'POST', '/api/v1/ui/groups', {
      name: `ScalarGuardGroup ${Date.now()}_${Math.random().toString(36).slice(2)}`,
    })
    const groupId = ((await groupRes.json()) as { id: string }).id
    const listRes = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'ScalarGuardList',
      listType: 'standard',
      scopeType: 'list_group',
      scopeId: groupId,
    })
    expect(listRes.status).toBe(201)
    const sgListId = ((await listRes.json()) as { id: string }).id

    // Create the multi-select field via the API so it exists in the DB.
    const fieldRes = await req(bearer, 'POST', `/api/v1/ui/lists/${sgListId}/fields`, {
      label: 'Tags',
      fieldType: 'multi_select',
      choices: [{ label: 'Alpha' }],
    })
    expect(fieldRes.status).toBe(201)
    const field = (await fieldRes.json()) as {
      id: string
      options: { choices: Array<{ id: string; label: string }> }
    }
    const multiFieldId = field.id
    const alphaId = field.options.choices[0]!.id

    // Resolve the list's tenant for the direct repo insert.
    const listBody = (await (
      await req(bearer, 'GET', `/api/v1/ui/lists/${sgListId}`)
    ).json()) as { tenantId: string }
    const tenantId = listBody.tenantId

    // Insert an item whose multi-field key holds a plain STRING (not an
    // array) — this state is unreachable via the write API but can exist
    // if data is written directly (e.g. migration, backfill, or bug).
    // We bypass validateCustomFields intentionally to plant the scalar.
    await repos.listItems.create({
      id: `lit_${ulid()}`,
      tenantId,
      listId: sgListId,
      title: 'scalar-stored',
      createdBy: 'user_scalar_test',
      customFields: { [multiFieldId]: alphaId }, // scalar string, not an array
    })

    // has_any must return NO match — the json_type guard rejects non-arrays.
    const { filters } = validateListQuery(
      { filters: [{ field: multiFieldId, op: 'has_any', value: alphaId }], sort: [] },
      [{ id: multiFieldId, fieldType: 'multi_select' }],
    )
    const result = await repos.listItems.listForList(sgListId, { filters })
    expect(result.map((i) => i.title)).toEqual([])
  })
})
