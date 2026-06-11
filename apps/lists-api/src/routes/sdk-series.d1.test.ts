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

// D1 integration tests for the SDK series surface. Replaces sdk-series.it.test.ts.
// Raw SQL uses env.DB.prepare() with flat table names (no lists_v1. prefix).
// Timestamps are stored as integer milliseconds in D1; occurrence_date is text.
// is_exception is stored as integer 0/1.

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

describe('D1 integration — SDK series surface', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services, realtime: undefined })
  })

  async function seedList(name = 'Task list'): Promise<string> {
    const list = await repos.lists.create({
      id: `lst_${ulid()}`,
      tenantId: TENANT,
      scopeType: 'group',
      scopeId: `group_${ulid()}`,
      listType: 'tasks',
      name,
      visibility: 'all',
      color: null,
      createdBy: 'user_seed',
    })
    return list.id
  }

  function bearer(key: string): Record<string, string> {
    return { authorization: `Bearer ${key}` }
  }

  function sdkHeaders(actor = 'user_01JPSER0000000000000000001'): Record<string, string> {
    return { ...bearer(envVars.PLANNER_API_KEY), 'x-actor': actor }
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
    const listId = await seedList()
    const res = await noKeyApp.request(
      `http://localhost/api/v1/sdk/lists/${listId}/series`,
      {
        method: 'POST',
        headers: { ...bearer('y'.repeat(40)), 'x-actor': 'user_test', 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Test',
          freq: 'daily',
          interval: 1,
          dtstart: '2026-07-01',
        }),
      },
    )
    expect(res.status).toBe(404)
  })

  it('403s on a missing or wrong bearer for POST', async () => {
    const listId = await seedList()
    const none = await app.request(
      `http://localhost/api/v1/sdk/lists/${listId}/series`,
      {
        method: 'POST',
        headers: { 'x-actor': 'user_test', 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'T', freq: 'daily', interval: 1, dtstart: '2026-07-01' }),
      },
    )
    expect(none.status).toBe(403)

    const wrong = await app.request(
      `http://localhost/api/v1/sdk/lists/${listId}/series`,
      {
        method: 'POST',
        headers: { ...bearer('not-the-key'), 'x-actor': 'user_test', 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'T', freq: 'daily', interval: 1, dtstart: '2026-07-01' }),
      },
    )
    expect(wrong.status).toBe(403)
  })

  it('403s when EVENTS_API_KEY is used on the series read (planner-only) route', async () => {
    const listId = await seedList()
    // GET …/lists/:listId/series is NOT one of the three events-readable
    // routes — the sdkKeyGate must require PLANNER_API_KEY here too.
    const res = await app.request(
      `http://localhost/api/v1/sdk/lists/${listId}/series`,
      { headers: { ...bearer(envVars.EVENTS_API_KEY!), 'x-actor': 'user_01JPSER0000000000000000001' } },
    )
    expect(res.status).toBe(403)
  })

  // --- x-actor header tests -----------------------------------------

  it('400s when x-actor header is missing on create', async () => {
    const listId = await seedList()
    const res = await app.request(
      `http://localhost/api/v1/sdk/lists/${listId}/series`,
      {
        method: 'POST',
        // Series routes are planner-only; key must pass before x-actor is checked.
        headers: { ...bearer(envVars.PLANNER_API_KEY), 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Daily standup', freq: 'daily', interval: 1, dtstart: '2026-07-01' }),
      },
    )
    expect(res.status).toBe(400)
  })

  it('400s when x-actor is malformed (not a user_<ulid>) on series create', async () => {
    const listId = await seedList()
    const malformed = ['not_a_user', 'user_short', 'user_toolongAAAAAAAAAAAAAAAAAAAAAAAAAAAA']
    for (const actor of malformed) {
      const res = await app.request(
        `http://localhost/api/v1/sdk/lists/${listId}/series`,
        {
          method: 'POST',
          headers: { ...bearer(envVars.PLANNER_API_KEY), 'x-actor': actor, 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'Bad actor', freq: 'daily', interval: 1, dtstart: '2026-07-01' }),
        },
      )
      expect(res.status, `expected 400 for actor "${actor}"`).toBe(400)
    }
  })

  // --- create tests -------------------------------------------------

  it('creates a series + materialises occurrences into list_items', async () => {
    const listId = await seedList()
    const actor = 'user_01JPSER0000000000000000010'

    const dtstart = new Date().toISOString().slice(0, 10)
    const res = await app.request(
      `http://localhost/api/v1/sdk/lists/${listId}/series`,
      {
        method: 'POST',
        headers: { ...sdkHeaders(actor), 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Daily standup',
          freq: 'daily',
          interval: 1,
          dtstart,
          count: 3,
        }),
      },
    )
    expect(res.status).toBe(201)

    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      listId,
      title: 'Daily standup',
      freq: 'daily',
      interval: 1,
      dtstart,
      count: 3,
      createdBy: actor,
    })
    expect(typeof body.id).toBe('string')
    expect((body.id as string).startsWith('lse_')).toBe(true)
    expect(typeof body.createdAt).toBe('string')
    // No tenantId or deletedAt surfaced.
    expect(body).not.toHaveProperty('tenantId')
    expect(body).not.toHaveProperty('deletedAt')

    const seriesId = body.id as string

    // Verify exactly 3 list_items rows for this series in D1.
    // D1: occurrence_date is text, due_date is integer milliseconds.
    const rows = await env.DB.prepare(
      `SELECT id, occurrence_date, due_date, series_id
       FROM list_items
       WHERE series_id = ? AND deleted_at IS NULL
       ORDER BY occurrence_date`,
    )
      .bind(seriesId)
      .all<{ id: string; occurrence_date: string; due_date: number; series_id: string }>()
    expect(rows.results).toHaveLength(3)
    for (const row of rows.results) {
      expect(row.series_id).toBe(seriesId)
      // due_date is stored as integer milliseconds; it should correspond to midnight UTC
      // (i.e. ms % 86_400_000 === 0 when no timeOfDay is set).
      expect(row.due_date % 86_400_000).toBe(0)
    }
    // Occurrence dates are consecutive starting from dtstart.
    const today = new Date(dtstart)
    for (let i = 0; i < 3; i++) {
      const expected = new Date(today.getTime() + i * 86_400_000).toISOString().slice(0, 10)
      expect(rows.results[i]!.occurrence_date).toBe(expected)
    }
  })

  it('creates a series with a timeOfDay — dueDate carries the time', async () => {
    const listId = await seedList()
    const dtstart = '2026-07-07'
    const res = await app.request(
      `http://localhost/api/v1/sdk/lists/${listId}/series`,
      {
        method: 'POST',
        headers: { ...sdkHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Morning run',
          freq: 'daily',
          interval: 1,
          dtstart,
          count: 2,
          timeOfDay: '07:30',
        }),
      },
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    const seriesId = body.id as string

    const rows = await env.DB.prepare(
      `SELECT due_date FROM list_items WHERE series_id = ? AND deleted_at IS NULL ORDER BY occurrence_date`,
    )
      .bind(seriesId)
      .all<{ due_date: number }>()
    expect(rows.results).toHaveLength(2)
    // due_date % 86_400_000 should equal 07:30 in ms = 7*3600*1000 + 30*60*1000 = 27_000_000.
    const expectedOffset = (7 * 3600 + 30 * 60) * 1000
    for (const row of rows.results) {
      expect(row.due_date % 86_400_000).toBe(expectedOffset)
    }
  })

  it('count:3 → exactly 3 occurrences', async () => {
    const listId = await seedList()
    const dtstart = '2026-07-01'
    const res = await app.request(
      `http://localhost/api/v1/sdk/lists/${listId}/series`,
      {
        method: 'POST',
        headers: { ...sdkHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Weekly report',
          freq: 'weekly',
          interval: 1,
          dtstart,
          count: 3,
        }),
      },
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    const seriesId = body.id as string

    const rows = await env.DB.prepare(
      `SELECT id FROM list_items WHERE series_id = ? AND deleted_at IS NULL`,
    )
      .bind(seriesId)
      .all<{ id: string }>()
    expect(rows.results).toHaveLength(3)
  })

  // --- list tests ---------------------------------------------------

  it('GET /:listId/series returns active series', async () => {
    const listId = await seedList()
    const dtstart = '2026-07-01'

    await app.request(
      `http://localhost/api/v1/sdk/lists/${listId}/series`,
      {
        method: 'POST',
        headers: { ...sdkHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'First', freq: 'daily', interval: 1, dtstart, count: 1 }),
      },
    )
    await app.request(
      `http://localhost/api/v1/sdk/lists/${listId}/series`,
      {
        method: 'POST',
        headers: { ...sdkHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Second', freq: 'daily', interval: 1, dtstart, count: 1 }),
      },
    )

    const res = await app.request(
      `http://localhost/api/v1/sdk/lists/${listId}/series`,
      // GET /sdk/lists/:listId/series is planner-only — no x-actor needed for
      // the GET (no requireActor() call), just the key.
      { headers: bearer(envVars.PLANNER_API_KEY) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<Record<string, unknown>>
    expect(body).toHaveLength(2)
    const titles = body.map((s) => s.title).sort()
    expect(titles).toEqual(['First', 'Second'])
  })

  // --- update tests -------------------------------------------------

  it('PATCH /series/:seriesId updates the rule and re-projects future occurrences', async () => {
    const listId = await seedList()
    // Create a weekly series with interval=1, count=3.
    const dtstart = '2026-07-07' // A Monday
    const createRes = await app.request(
      `http://localhost/api/v1/sdk/lists/${listId}/series`,
      {
        method: 'POST',
        headers: { ...sdkHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Weekly meeting', freq: 'weekly', interval: 1, dtstart, count: 3 }),
      },
    )
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as Record<string, unknown>
    const seriesId = created.id as string

    // Mark one occurrence as exception (simulating a user override).
    // D1: is_exception is integer 0/1.
    const firstOccurrence = await env.DB.prepare(
      `SELECT id FROM list_items WHERE series_id = ? AND deleted_at IS NULL ORDER BY occurrence_date LIMIT 1`,
    )
      .bind(seriesId)
      .first<{ id: string }>()

    if (firstOccurrence) {
      await env.DB.prepare(`UPDATE list_items SET is_exception = 1 WHERE id = ?`)
        .bind(firstOccurrence.id)
        .run()
    }

    // Patch: bump interval to 2.
    const patchRes = await app.request(
      `http://localhost/api/v1/sdk/series/${seriesId}`,
      {
        method: 'PATCH',
        headers: { ...sdkHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ interval: 2 }),
      },
    )
    expect(patchRes.status).toBe(200)
    const patched = (await patchRes.json()) as Record<string, unknown>
    expect(patched.interval).toBe(2)
    expect(patched.id).toBe(seriesId)

    // The exception occurrence must still exist (not soft-deleted) AND must
    // not have been duplicated by the re-projection.
    if (firstOccurrence) {
      const exc = await env.DB.prepare(
        `SELECT deleted_at, occurrence_date FROM list_items WHERE id = ?`,
      )
        .bind(firstOccurrence.id)
        .first<{ deleted_at: number | null; occurrence_date: string }>()
      expect(exc?.deleted_at).toBeNull()
      const dup = await env.DB.prepare(
        `SELECT COUNT(*) AS cnt FROM list_items WHERE series_id = ? AND occurrence_date = ? AND deleted_at IS NULL`,
      )
        .bind(seriesId, exc!.occurrence_date)
        .first<{ cnt: number }>()
      expect(dup?.cnt).toBe(1)
    }

    // Live occurrences after update (excluding exception row) should
    // reflect the new interval=2 weekly rule.
    const liveRows = await env.DB.prepare(
      `SELECT occurrence_date, is_exception FROM list_items WHERE series_id = ? AND deleted_at IS NULL ORDER BY occurrence_date`,
    )
      .bind(seriesId)
      .all<{ occurrence_date: string; is_exception: number }>()
    expect(liveRows.results.length).toBeGreaterThan(0)
    // is_exception is 0/1 in D1.
    const nonException = liveRows.results.filter((r) => r.is_exception === 0)
    // All non-exception occurrences should be on Mondays 2 weeks apart (interval=2).
    for (let i = 1; i < nonException.length; i++) {
      const prev = new Date(nonException[i - 1]!.occurrence_date + 'T00:00:00Z')
      const curr = new Date(nonException[i]!.occurrence_date + 'T00:00:00Z')
      const diffDays = Math.round((curr.getTime() - prev.getTime()) / 86_400_000)
      expect(diffDays).toBe(14)
    }
  })

  it('PATCH re-projection does not resurrect a user-deleted (EXDATE) occurrence', async () => {
    const listId = await seedList()
    const todayISO = new Date().toISOString().slice(0, 10)
    const createRes = await app.request(
      `http://localhost/api/v1/sdk/lists/${listId}/series`,
      {
        method: 'POST',
        headers: { ...sdkHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Daily chore', freq: 'daily', interval: 1, dtstart: todayISO, count: 5 }),
      },
    )
    const seriesId = ((await createRes.json()) as Record<string, unknown>).id as string

    // The user deletes one future occurrence individually (soft-delete, NOT
    // an exception) — this is an EXDATE.
    // D1 doesn't support OFFSET in subqueries the same way; select all and pick index 2.
    const allOccurrences = await env.DB.prepare(
      `SELECT id, occurrence_date FROM list_items WHERE series_id = ? AND deleted_at IS NULL ORDER BY occurrence_date`,
    )
      .bind(seriesId)
      .all<{ id: string; occurrence_date: string }>()
    const victim = allOccurrences.results[2]
    if (!victim) throw new Error('Expected at least 3 occurrences')

    // Soft-delete: deleted_at is integer milliseconds in D1.
    await env.DB.prepare(`UPDATE list_items SET deleted_at = ? WHERE id = ?`)
      .bind(Date.now(), victim.id)
      .run()

    // Re-project via an unrelated rule edit (title bump leaves the dates intact).
    const patchRes = await app.request(
      `http://localhost/api/v1/sdk/series/${seriesId}`,
      {
        method: 'PATCH',
        headers: { ...sdkHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Renamed chore' }),
      },
    )
    expect(patchRes.status).toBe(200)

    // The EXDATE date must NOT have a live row again.
    const resurrected = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM list_items WHERE series_id = ? AND occurrence_date = ? AND deleted_at IS NULL`,
    )
      .bind(seriesId, victim.occurrence_date)
      .first<{ cnt: number }>()
    expect(resurrected?.cnt).toBe(0)
  })

  it('PATCH 404s for a soft-deleted series', async () => {
    const listId = await seedList()
    const createRes = await app.request(
      `http://localhost/api/v1/sdk/lists/${listId}/series`,
      {
        method: 'POST',
        headers: { ...sdkHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Doomed', freq: 'daily', interval: 1, dtstart: '2026-07-01', count: 2 }),
      },
    )
    const seriesId = ((await createRes.json()) as Record<string, unknown>).id as string
    await app.request(`http://localhost/api/v1/sdk/series/${seriesId}`, {
      method: 'DELETE',
      headers: sdkHeaders(),
    })
    const res = await app.request(`http://localhost/api/v1/sdk/series/${seriesId}`, {
      method: 'PATCH',
      headers: { ...sdkHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ interval: 3 }),
    })
    expect(res.status).toBe(404)
  })

  it('POST 404s for a non-existent list', async () => {
    const res = await app.request(
      `http://localhost/api/v1/sdk/lists/lst_doesnotexist/series`,
      {
        method: 'POST',
        headers: { ...sdkHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Orphan', freq: 'daily', interval: 1, dtstart: '2026-07-01', count: 1 }),
      },
    )
    expect(res.status).toBe(404)
  })

  it('PATCH 404s for a missing series', async () => {
    const res = await app.request(
      'http://localhost/api/v1/sdk/series/lse_doesnotexist',
      {
        method: 'PATCH',
        headers: { ...sdkHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ interval: 2 }),
      },
    )
    expect(res.status).toBe(404)
  })

  // --- delete tests -------------------------------------------------

  it('DELETE soft-deletes the series + future non-exception occurrences, preserves exceptions and past-dated rows', async () => {
    const listId = await seedList()
    // Create a series starting today with count=5 so we have 5 live occurrences.
    const todayISO = new Date().toISOString().slice(0, 10)

    const createRes = await app.request(
      `http://localhost/api/v1/sdk/lists/${listId}/series`,
      {
        method: 'POST',
        headers: { ...sdkHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Daily task', freq: 'daily', interval: 1, dtstart: todayISO, count: 5 }),
      },
    )
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as Record<string, unknown>
    const seriesId = created.id as string

    // Verify 5 occurrences exist before delete.
    const beforeCount = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM list_items WHERE series_id = ? AND deleted_at IS NULL`,
    )
      .bind(seriesId)
      .first<{ cnt: number }>()
    expect(beforeCount?.cnt).toBe(5)

    // Manually back-date 2 occurrences to simulate "past" rows.
    // D1: occurrence_date is text. Select the 2 earliest and update.
    const earliest = await env.DB.prepare(
      `SELECT id FROM list_items WHERE series_id = ? AND deleted_at IS NULL ORDER BY occurrence_date LIMIT 2`,
    )
      .bind(seriesId)
      .all<{ id: string }>()
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    for (const row of earliest.results) {
      await env.DB.prepare(`UPDATE list_items SET occurrence_date = ? WHERE id = ?`)
        .bind(yesterday, row.id)
        .run()
    }

    // Mark one future occurrence as an exception.
    const exceptionCandidate = await env.DB.prepare(
      `SELECT id FROM list_items WHERE series_id = ? AND occurrence_date >= ? AND deleted_at IS NULL ORDER BY occurrence_date LIMIT 1`,
    )
      .bind(seriesId, todayISO)
      .first<{ id: string }>()

    if (exceptionCandidate) {
      await env.DB.prepare(`UPDATE list_items SET is_exception = 1 WHERE id = ?`)
        .bind(exceptionCandidate.id)
        .run()
    }

    const delRes = await app.request(
      `http://localhost/api/v1/sdk/series/${seriesId}`,
      {
        method: 'DELETE',
        headers: sdkHeaders(),
      },
    )
    expect(delRes.status).toBe(204)

    // Series row should be soft-deleted. D1: deleted_at is integer.
    const seriesRow = await env.DB.prepare(
      `SELECT deleted_at FROM list_item_series WHERE id = ?`,
    )
      .bind(seriesId)
      .first<{ deleted_at: number | null }>()
    expect(seriesRow?.deleted_at).not.toBeNull()

    // Future non-exception occurrences should be soft-deleted.
    const futureAlive = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM list_items WHERE series_id = ? AND occurrence_date >= ? AND is_exception = 0 AND deleted_at IS NULL`,
    )
      .bind(seriesId, todayISO)
      .first<{ cnt: number }>()
    expect(futureAlive?.cnt).toBe(0)

    // Past (back-dated) occurrences should still be alive.
    const pastAlive = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM list_items WHERE series_id = ? AND occurrence_date < ? AND deleted_at IS NULL`,
    )
      .bind(seriesId, todayISO)
      .first<{ cnt: number }>()
    expect((pastAlive?.cnt ?? 0)).toBeGreaterThan(0)

    // The exception occurrence (if we had one) should still be alive.
    if (exceptionCandidate) {
      const excRow = await env.DB.prepare(
        `SELECT deleted_at FROM list_items WHERE id = ?`,
      )
        .bind(exceptionCandidate.id)
        .first<{ deleted_at: number | null }>()
      expect(excRow?.deleted_at).toBeNull()
    }
  })

  it('DELETE 404s for a missing or already-deleted series', async () => {
    const res = await app.request(
      'http://localhost/api/v1/sdk/series/lse_doesnotexist',
      { method: 'DELETE', headers: sdkHeaders() },
    )
    expect(res.status).toBe(404)
  })

  it('GET /series returns empty array for a list with no series', async () => {
    const listId = await seedList('Empty list')
    const res = await app.request(
      `http://localhost/api/v1/sdk/lists/${listId}/series`,
      // planner-only route — requires PLANNER key (no x-actor for GETs)
      { headers: bearer(envVars.PLANNER_API_KEY) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as unknown[]
    expect(body).toEqual([])
  })

  // --- actor-scoping on update/delete (Fix 3) -----------------------
  // Series on a `list_group` scope enforce membership via loadListForActor.
  // A foreign actor cannot update or delete a series they have no access to.
  // A legitimate list-member can update and delete their series.

  async function createPersonalGroup(actor: string): Promise<{ groupId: string; listId: string }> {
    const groupRes = await app.request('http://localhost/api/v1/sdk/groups', {
      method: 'POST',
      headers: { ...bearer(envVars.PLANNER_API_KEY), 'x-actor': actor, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Personal' }),
    })
    expect(groupRes.status).toBe(201)
    const groupId = ((await groupRes.json()) as Record<string, unknown>).id as string

    const listRes = await app.request('http://localhost/api/v1/sdk/lists', {
      method: 'POST',
      headers: { ...bearer(envVars.PLANNER_API_KEY), 'x-actor': actor, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Tasks', listType: 'tasks', scopeType: 'list_group', scopeId: groupId }),
    })
    expect(listRes.status).toBe(201)
    const listId = ((await listRes.json()) as Record<string, unknown>).id as string
    return { groupId, listId }
  }

  async function createSeriesInList(actor: string, listId: string): Promise<string> {
    const res = await app.request(`http://localhost/api/v1/sdk/lists/${listId}/series`, {
      method: 'POST',
      headers: { ...bearer(envVars.PLANNER_API_KEY), 'x-actor': actor, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Daily standup', freq: 'daily', interval: 1, dtstart: '2026-07-01', count: 2 }),
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as Record<string, unknown>).id as string
  }

  it('PATCH — foreign actor gets opaque 404 on a list_group-scoped series', async () => {
    const owner = `user_${ulid()}`
    const foreign = `user_${ulid()}`
    const { listId } = await createPersonalGroup(owner)
    const seriesId = await createSeriesInList(owner, listId)

    const res = await app.request(`http://localhost/api/v1/sdk/series/${seriesId}`, {
      method: 'PATCH',
      headers: { ...bearer(envVars.PLANNER_API_KEY), 'x-actor': foreign, 'content-type': 'application/json' },
      body: JSON.stringify({ interval: 2 }),
    })
    expect(res.status).toBe(404)
  })

  it('DELETE — foreign actor gets opaque 404 on a list_group-scoped series', async () => {
    const owner = `user_${ulid()}`
    const foreign = `user_${ulid()}`
    const { listId } = await createPersonalGroup(owner)
    const seriesId = await createSeriesInList(owner, listId)

    const res = await app.request(`http://localhost/api/v1/sdk/series/${seriesId}`, {
      method: 'DELETE',
      headers: { ...bearer(envVars.PLANNER_API_KEY), 'x-actor': foreign },
    })
    expect(res.status).toBe(404)

    // Series must still exist (not soft-deleted by the foreign actor).
    const row = await env.DB.prepare('SELECT deleted_at FROM list_item_series WHERE id = ?')
      .bind(seriesId)
      .first<{ deleted_at: number | null }>()
    expect(row?.deleted_at).toBeNull()
  })

  it('PATCH — owning actor can update a list_group-scoped series', async () => {
    const owner = `user_${ulid()}`
    const { listId } = await createPersonalGroup(owner)
    const seriesId = await createSeriesInList(owner, listId)

    const res = await app.request(`http://localhost/api/v1/sdk/series/${seriesId}`, {
      method: 'PATCH',
      headers: { ...bearer(envVars.PLANNER_API_KEY), 'x-actor': owner, 'content-type': 'application/json' },
      body: JSON.stringify({ interval: 3 }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as Record<string, unknown>).interval).toBe(3)
  })

  it('DELETE — owning actor can delete a list_group-scoped series', async () => {
    const owner = `user_${ulid()}`
    const { listId } = await createPersonalGroup(owner)
    const seriesId = await createSeriesInList(owner, listId)

    const res = await app.request(`http://localhost/api/v1/sdk/series/${seriesId}`, {
      method: 'DELETE',
      headers: { ...bearer(envVars.PLANNER_API_KEY), 'x-actor': owner },
    })
    expect(res.status).toBe(204)
  })
})
