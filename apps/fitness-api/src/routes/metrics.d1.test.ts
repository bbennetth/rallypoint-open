import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb, type Db } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { encryptBearer } from '../crypto/encryption.js'
import { FITNESS_SESSION_BEARER_PREFIX } from '../middleware/session.js'
import type { MetricDto } from '@rallypoint/fitness-shared'

// D1 integration tests for the body/health metric time-series UI surface.
// Runs inside a workerd isolate (Miniflare D1); migrations are applied by
// test/apply-d1-migrations.ts. No catalog seed needed — metrics reference
// no foreign keys.

const CSRF = 'csrf_token_value_metrics_aaaaaaaaaaaaaaaa'

const services: Services = {
  idClient: {
    verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
    signoutRpidBearer: async () => {},
  },
  rpidSso: { exchange: async () => ({ ok: false as const, reason: 'invalid' as const }) },
  profiles: { lookup: async () => null },
  settings: { get: async () => ({}), patch: async (_u, _n, p) => p },
  offClient: { lookup: async () => null },
}

describe('D1 integration — metric time-series UI surface', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>
  let db: Db

  beforeAll(async () => {
    db = createDb(env.DB)
    repos = buildD1Repos(db)
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })

  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(FITNESS_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { FITNESS_SESSION_KEY_V1: envVars.FITNESS_SESSION_KEY_V1 },
      keyVersion: envVars.FITNESS_SESSION_KEY_VERSION,
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
      cookie: `${envVars.FITNESS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      'content-type': 'application/json',
      origin: envVars.FITNESS_UI_ORIGIN,
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

  it('rejects metric list without a session (401)', async () => {
    const res = await app.request('http://localhost/api/v1/ui/metrics', {
      headers: { 'x-rp-csrf': CSRF, cookie: `${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}` },
    })
    expect(res.status).toBe(401)
  })

  it('creates a metric (201) and it persists via GET list', async () => {
    const bearer = await loginAs('user_mt_create')
    const res = await req(bearer, 'POST', '/api/v1/ui/metrics', {
      recordedAt: '2026-06-01T08:00:00.000Z',
      kind: 'bodyweight',
      value: 82.5,
      unit: 'kg',
      note: 'Morning fasted',
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as MetricDto
    expect(dto.id).toMatch(/^fm_/)
    expect(dto.kind).toBe('bodyweight')
    expect(dto.value).toBe(82.5)
    expect(dto.unit).toBe('kg')
    expect(dto.note).toBe('Morning fasted')
    expect(dto.recordedAt).toBe('2026-06-01T08:00:00.000Z')

    // Verify persisted via list.
    const listRes = await req(bearer, 'GET', '/api/v1/ui/metrics')
    expect(listRes.status).toBe(200)
    const listBody = (await listRes.json()) as { metrics: MetricDto[] }
    expect(listBody.metrics.some((m) => m.id === dto.id)).toBe(true)
  })

  it('lists metrics newest recordedAt first', async () => {
    const bearer = await loginAs('user_mt_list_order')

    await req(bearer, 'POST', '/api/v1/ui/metrics', {
      recordedAt: '2026-05-01T08:00:00.000Z',
      kind: 'bodyweight',
      value: 83.0,
    })
    await req(bearer, 'POST', '/api/v1/ui/metrics', {
      recordedAt: '2026-06-10T08:00:00.000Z',
      kind: 'bodyweight',
      value: 82.0,
    })
    await req(bearer, 'POST', '/api/v1/ui/metrics', {
      recordedAt: '2026-06-20T08:00:00.000Z',
      kind: 'bodyweight',
      value: 81.5,
    })

    const res = await req(bearer, 'GET', '/api/v1/ui/metrics')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { metrics: MetricDto[] }
    expect(body.metrics).toHaveLength(3)
    // newest first
    const dates = body.metrics.map((m) => m.recordedAt)
    expect(dates[0] >= dates[1] && dates[1] >= dates[2]).toBe(true)
    expect(dates[0]).toContain('2026-06-20')
  })

  it('filters by kind', async () => {
    const bearer = await loginAs('user_mt_filter_kind')

    await req(bearer, 'POST', '/api/v1/ui/metrics', {
      recordedAt: '2026-06-01T08:00:00.000Z',
      kind: 'bodyweight',
      value: 80.0,
    })
    await req(bearer, 'POST', '/api/v1/ui/metrics', {
      recordedAt: '2026-06-01T08:00:00.000Z',
      kind: 'sleep',
      value: 7.5,
      unit: 'h',
    })

    const res = await req(bearer, 'GET', '/api/v1/ui/metrics?kind=sleep')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { metrics: MetricDto[] }
    expect(body.metrics).toHaveLength(1)
    expect(body.metrics[0].kind).toBe('sleep')
  })

  it('filters by date range', async () => {
    const bearer = await loginAs('user_mt_filter_date')

    await req(bearer, 'POST', '/api/v1/ui/metrics', {
      recordedAt: '2026-04-15T08:00:00.000Z',
      kind: 'hrv',
      value: 55,
    })
    await req(bearer, 'POST', '/api/v1/ui/metrics', {
      recordedAt: '2026-05-20T08:00:00.000Z',
      kind: 'hrv',
      value: 60,
    })
    await req(bearer, 'POST', '/api/v1/ui/metrics', {
      recordedAt: '2026-06-15T08:00:00.000Z',
      kind: 'hrv',
      value: 65,
    })

    const res = await req(
      bearer,
      'GET',
      '/api/v1/ui/metrics?from=2026-05-01T00:00:00.000Z&to=2026-05-31T23:59:59.000Z',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { metrics: MetricDto[] }
    expect(body.metrics).toHaveLength(1)
    expect(body.metrics[0].recordedAt).toContain('2026-05-20')
  })

  it('respects the limit parameter', async () => {
    const bearer = await loginAs('user_mt_limit')

    // Insert 5 metrics.
    for (let i = 1; i <= 5; i++) {
      await req(bearer, 'POST', '/api/v1/ui/metrics', {
        recordedAt: `2026-06-0${i}T08:00:00.000Z`,
        kind: 'steps',
        value: i * 1000,
      })
    }

    const res = await req(bearer, 'GET', '/api/v1/ui/metrics?limit=3')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { metrics: MetricDto[] }
    expect(body.metrics).toHaveLength(3)
    // Should be the 3 newest.
    expect(body.metrics[0].recordedAt).toContain('2026-06-05')
  })

  it('PATCH updates value, recordedAt, unit, and note', async () => {
    const bearer = await loginAs('user_mt_patch')
    const created = await req(bearer, 'POST', '/api/v1/ui/metrics', {
      recordedAt: '2026-06-10T08:00:00.000Z',
      kind: 'bodyweight',
      value: 84.0,
      unit: 'kg',
      note: 'Pre-patch',
    })
    const dto = (await created.json()) as MetricDto

    const patched = await req(bearer, 'PATCH', `/api/v1/ui/metrics/${dto.id}`, {
      value: 83.5,
      recordedAt: '2026-06-10T09:00:00.000Z',
      unit: 'kg',
      note: 'Post-patch',
    })
    expect(patched.status).toBe(200)
    const patchedDto = (await patched.json()) as MetricDto
    expect(patchedDto.value).toBe(83.5)
    expect(patchedDto.recordedAt).toBe('2026-06-10T09:00:00.000Z')
    expect(patchedDto.note).toBe('Post-patch')
  })

  it('PATCH can clear nullable unit and note', async () => {
    const bearer = await loginAs('user_mt_patch_clear')
    const created = await req(bearer, 'POST', '/api/v1/ui/metrics', {
      recordedAt: '2026-06-11T08:00:00.000Z',
      kind: 'soreness',
      value: 6,
      unit: 'scale',
      note: 'Leg day soreness',
    })
    const dto = (await created.json()) as MetricDto
    expect(dto.unit).toBe('scale')
    expect(dto.note).toBe('Leg day soreness')

    const patched = await req(bearer, 'PATCH', `/api/v1/ui/metrics/${dto.id}`, {
      unit: null,
      note: null,
    })
    expect(patched.status).toBe(200)
    const patchedDto = (await patched.json()) as MetricDto
    expect(patchedDto.unit).toBeNull()
    expect(patchedDto.note).toBeNull()
  })

  it('DELETE removes the metric and returns 404 after', async () => {
    const bearer = await loginAs('user_mt_delete')
    const created = await req(bearer, 'POST', '/api/v1/ui/metrics', {
      recordedAt: '2026-06-12T08:00:00.000Z',
      kind: 'resting_hr',
      value: 52,
    })
    const dto = (await created.json()) as MetricDto

    const del = await req(bearer, 'DELETE', `/api/v1/ui/metrics/${dto.id}`)
    expect(del.status).toBe(200)
    const delBody = (await del.json()) as { ok: boolean }
    expect(delBody.ok).toBe(true)

    // Verify list is now empty for this user.
    const list = await req(bearer, 'GET', '/api/v1/ui/metrics')
    const listBody = (await list.json()) as { metrics: MetricDto[] }
    expect(listBody.metrics).toHaveLength(0)

    // Verify PATCH after delete returns 404.
    const patch = await req(bearer, 'PATCH', `/api/v1/ui/metrics/${dto.id}`, { value: 55 })
    expect(patch.status).toBe(404)
  })

  it('cross-user isolation: PATCH/DELETE return 404, list excludes other user metrics', async () => {
    const ua = await loginAs('user_mt_iso_a')
    const ub = await loginAs('user_mt_iso_b')

    const created = await req(ua, 'POST', '/api/v1/ui/metrics', {
      recordedAt: '2026-06-13T08:00:00.000Z',
      kind: 'bodyweight',
      value: 75.0,
    })
    const dto = (await created.json()) as MetricDto

    // User B's list is empty.
    const listByB = await req(ub, 'GET', '/api/v1/ui/metrics')
    const listBody = (await listByB.json()) as { metrics: MetricDto[] }
    expect(listBody.metrics).toHaveLength(0)

    // User B cannot PATCH user A's metric.
    const patchByB = await req(ub, 'PATCH', `/api/v1/ui/metrics/${dto.id}`, { value: 99 })
    expect(patchByB.status).toBe(404)

    // User B cannot DELETE user A's metric.
    const deleteByB = await req(ub, 'DELETE', `/api/v1/ui/metrics/${dto.id}`)
    expect(deleteByB.status).toBe(404)

    // User A's metric is still intact.
    const listByA = await req(ua, 'GET', '/api/v1/ui/metrics')
    const listBodyA = (await listByA.json()) as { metrics: MetricDto[] }
    expect(listBodyA.metrics.some((m) => m.id === dto.id)).toBe(true)
  })

  it('rejects a non-slug kind like "Body Weight" (400)', async () => {
    const bearer = await loginAs('user_mt_bad_kind')
    const res = await req(bearer, 'POST', '/api/v1/ui/metrics', {
      recordedAt: '2026-06-14T08:00:00.000Z',
      kind: 'Body Weight',
      value: 80.0,
    })
    expect(res.status).toBe(400)
  })

  it('rejects a non-finite value (400)', async () => {
    const bearer = await loginAs('user_mt_bad_value')

    const nanRes = await req(bearer, 'POST', '/api/v1/ui/metrics', {
      recordedAt: '2026-06-14T08:00:00.000Z',
      kind: 'bodyweight',
      value: NaN,
    })
    expect(nanRes.status).toBe(400)

    const infRes = await req(bearer, 'POST', '/api/v1/ui/metrics', {
      recordedAt: '2026-06-14T08:00:00.000Z',
      kind: 'bodyweight',
      value: Infinity,
    })
    expect(infRes.status).toBe(400)
  })

  it('rejects an unparseable ?from / ?to query param with 400', async () => {
    const bearer = await loginAs('user_mt_bad_query')
    const badFrom = await req(bearer, 'GET', '/api/v1/ui/metrics?from=garbage')
    expect(badFrom.status).toBe(400)
    const badTo = await req(bearer, 'GET', '/api/v1/ui/metrics?to=not-a-date')
    expect(badTo.status).toBe(400)
  })

  it('rejects out-of-scale values on bounded kinds (soreness 1-10) on POST and PATCH', async () => {
    const bearer = await loginAs('user_mt_scale')
    // POST: out of range
    const badPost = await req(bearer, 'POST', '/api/v1/ui/metrics', {
      recordedAt: '2026-06-26T07:00:00.000Z',
      kind: 'soreness',
      value: 999,
    })
    expect(badPost.status).toBe(400)

    // POST: in range
    const okPost = await req(bearer, 'POST', '/api/v1/ui/metrics', {
      recordedAt: '2026-06-26T07:00:00.000Z',
      kind: 'soreness',
      value: 7,
    })
    expect(okPost.status).toBe(201)
    const { id } = (await okPost.json()) as { id: string }

    // PATCH: out of range — must be blocked using the existing row's kind.
    const badPatch = await req(bearer, 'PATCH', `/api/v1/ui/metrics/${id}`, { value: 0 })
    expect(badPatch.status).toBe(400)

    // PATCH: in range still works.
    const okPatch = await req(bearer, 'PATCH', `/api/v1/ui/metrics/${id}`, { value: 5 })
    expect(okPatch.status).toBe(200)
  })
})
