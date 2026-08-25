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

// D1 integration tests for the repo-wide "offline create retries must be
// idempotent" fix (server-side ref dedup mirroring money-api's expenses
// ref pattern — apps/money-api/src/routes/expense-ref-idempotency.d1.test.ts).
// Covers a plain always-insert route (workouts), an owner-scoped route that
// ALSO carries a pre-existing name-uniqueness constraint (wod-templates —
// the CAUTION case: a name collision must never be silently reported as a
// ref replay), and the plan-scoped training-plan-items route.

const CSRF = 'csrf_token_value_ref_idem_aaaaaaaaaaaaaaaaaaaa'

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

describe('D1 integration — create-ref idempotency (offline retry dedup)', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>
  let _db: Db

  beforeAll(() => {
    _db = createDb(env.DB)
    repos = buildD1Repos(_db)
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

  // --- workouts (plain always-insert create) ---------------------------

  describe('workouts', () => {
    it('same ref twice returns the existing row (200, idempotent:true, one row)', async () => {
      const bearer = await loginAs('user_wk_ref_idem')
      const payload = {
        performedAt: '2026-07-01T12:00:00.000Z',
        modality: 'strength',
        sets: [],
        ref: 'tmp_wk_replay',
      }
      const first = await req(bearer, 'POST', '/api/v1/ui/workouts', payload)
      expect(first.status).toBe(201)
      const a = (await first.json()) as { id: string; idempotent?: boolean; ref?: string | null }
      expect(a.idempotent).toBeUndefined()
      expect(a.ref).toBe('tmp_wk_replay')

      const second = await req(bearer, 'POST', '/api/v1/ui/workouts', {
        ...payload,
        // A real retry replays the exact same body, but even a divergent
        // body must still resolve to the FIRST writer's row.
        notes: 'retry payload should be ignored',
      })
      expect(second.status).toBe(200)
      const b = (await second.json()) as { id: string; idempotent?: boolean }
      expect(b.id).toBe(a.id)
      expect(b.idempotent).toBe(true)

      const list = (await (await req(bearer, 'GET', '/api/v1/ui/workouts')).json()) as {
        workouts: unknown[]
      }
      expect(list.workouts).toHaveLength(1)
    })

    it('different refs create distinct rows', async () => {
      const bearer = await loginAs('user_wk_ref_distinct')
      const base = { performedAt: '2026-07-01T12:00:00.000Z', modality: 'strength', sets: [] }
      const a = await req(bearer, 'POST', '/api/v1/ui/workouts', { ...base, ref: 'tmp_wk_a' })
      const b = await req(bearer, 'POST', '/api/v1/ui/workouts', { ...base, ref: 'tmp_wk_b' })
      expect(a.status).toBe(201)
      expect(b.status).toBe(201)
      const list = (await (await req(bearer, 'GET', '/api/v1/ui/workouts')).json()) as {
        workouts: unknown[]
      }
      expect(list.workouts).toHaveLength(2)
    })

    it('workouts without a ref are unconstrained — duplicates allowed', async () => {
      const bearer = await loginAs('user_wk_no_ref')
      const base = { performedAt: '2026-07-01T12:00:00.000Z', modality: 'strength', sets: [] }
      await req(bearer, 'POST', '/api/v1/ui/workouts', base)
      await req(bearer, 'POST', '/api/v1/ui/workouts', base)
      const list = (await (await req(bearer, 'GET', '/api/v1/ui/workouts')).json()) as {
        workouts: unknown[]
      }
      expect(list.workouts).toHaveLength(2)
    })
  })

  // --- wod-templates (owner-scoped; ALSO carries a name-uniqueness
  // constraint — the disambiguation case) ------------------------------

  describe('wod-templates', () => {
    const wodBody = (reps: number) => ({
      wodType: 'for_time',
      timeCapS: 600,
      body: {
        wodType: 'for_time',
        rounds: 1,
        movements: [{ exerciseId: 'fx_seed_back_squat', reps }],
      },
    })

    it('same ref twice returns the existing template (200, idempotent:true, same id)', async () => {
      const bearer = await loginAs('user_wt_ref_idem')
      const first = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
        name: 'Ref Replay Test',
        ...wodBody(21),
        ref: 'tmp_wt_replay',
      })
      expect(first.status).toBe(201)
      const a = (await first.json()) as { id: string; idempotent?: boolean }
      expect(a.idempotent).toBeUndefined()

      const second = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
        name: 'Ref Replay Test',
        ...wodBody(21),
        ref: 'tmp_wt_replay',
      })
      expect(second.status).toBe(200)
      const b = (await second.json()) as { id: string; idempotent?: boolean }
      expect(b.id).toBe(a.id)
      expect(b.idempotent).toBe(true)
    })

    it('different refs create distinct templates', async () => {
      const bearer = await loginAs('user_wt_ref_distinct')
      const a = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
        name: 'Distinct Ref A',
        ...wodBody(10),
        ref: 'tmp_wt_a',
      })
      const b = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
        name: 'Distinct Ref B',
        ...wodBody(10),
        ref: 'tmp_wt_b',
      })
      expect(a.status).toBe(201)
      expect(b.status).toBe(201)
      const aId = ((await a.json()) as { id: string }).id
      const bId = ((await b.json()) as { id: string }).id
      expect(aId).not.toBe(bId)
    })

    it('templates without a ref are unconstrained — duplicates allowed', async () => {
      const bearer = await loginAs('user_wt_no_ref')
      const a = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
        name: 'No Ref Distinct A',
        ...wodBody(5),
      })
      const b = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
        name: 'No Ref Distinct B',
        ...wodBody(5),
      })
      expect(a.status).toBe(201)
      expect(b.status).toBe(201)
    })

    // The CAUTION case: wod_templates carries BOTH a name-uniqueness
    // partial-unique index (wod_templates_custom_name_uq) and the new
    // ref-uniqueness index (fitness_wod_templates_owner_ref_uq). A name
    // collision with a FRESH (never-seen) ref must resolve via the
    // pre-existing name find-or-create — NOT be reported as an
    // idempotent ref replay — and the fresh ref must never be silently
    // persisted onto the pre-existing row.
    it('a NAME collision with a different ref is NOT reported as a ref replay', async () => {
      const bearer = await loginAs('user_wt_name_vs_ref')
      const first = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
        name: 'Name Vs Ref Test',
        ...wodBody(21),
        ref: 'tmp_wt_name_1',
      })
      expect(first.status).toBe(201)
      const original = (await first.json()) as { id: string; ref?: string | null }
      expect(original.ref).toBe('tmp_wt_name_1')

      // Same name, brand-new ref never seen before. Existing
      // find-or-create-by-name semantics win: 200, same id, but NOT
      // flagged idempotent (that flag is reserved for a genuine ref
      // replay) and the original row's ref must stay untouched.
      const collision = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
        name: 'Name Vs Ref Test',
        ...wodBody(21),
        ref: 'tmp_wt_name_2',
      })
      expect(collision.status).toBe(200)
      const replayed = (await collision.json()) as {
        id: string
        idempotent?: boolean
        ref?: string | null
      }
      expect(replayed.id).toBe(original.id)
      expect(replayed.idempotent).toBeUndefined()
      // The pre-existing row's ref is untouched — proves the second
      // request's ref was never persisted anywhere.
      expect(replayed.ref).toBe('tmp_wt_name_1')

      const got = await req(bearer, 'GET', `/api/v1/ui/wod-templates/${original.id}`)
      expect(((await got.json()) as { ref?: string | null }).ref).toBe('tmp_wt_name_1')

      // Because 'tmp_wt_name_2' was never actually claimed, it's still
      // free — a THIRD create with that ref + a genuinely different
      // name produces a brand-new row (proves no phantom ref-claim).
      const third = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
        name: 'Name Vs Ref Test — Different',
        ...wodBody(21),
        ref: 'tmp_wt_name_2',
      })
      expect(third.status).toBe(201)
      const brandNew = (await third.json()) as { id: string }
      expect(brandNew.id).not.toBe(original.id)
    })
  })

  // --- training-plan items (plan-scoped) --------------------------------

  describe('training-plan items', () => {
    async function createPlan(bearer: string, name: string): Promise<string> {
      const res = await req(bearer, 'POST', '/api/v1/ui/training-plans', { name })
      const body = (await res.json()) as { trainingPlan: { id: string } }
      return body.trainingPlan.id
    }

    it('same ref twice returns the existing item (200, idempotent:true, same id)', async () => {
      const bearer = await loginAs('user_tpi_ref_idem')
      const planId = await createPlan(bearer, 'Ref Item Plan A')
      const payload = {
        dayKey: 'mon',
        position: 0,
        sourceKind: 'strength',
        note: '5x5 squat',
        ref: 'tmp_tpi_replay',
      }
      const first = await req(
        bearer,
        'POST',
        `/api/v1/ui/training-plans/${planId}/items`,
        payload,
      )
      expect(first.status).toBe(201)
      const a = (await first.json()) as { item: { id: string; idempotent?: boolean } }
      expect(a.item.idempotent).toBeUndefined()

      const second = await req(
        bearer,
        'POST',
        `/api/v1/ui/training-plans/${planId}/items`,
        payload,
      )
      expect(second.status).toBe(200)
      const b = (await second.json()) as { item: { id: string }; idempotent?: boolean }
      expect(b.item.id).toBe(a.item.id)
      expect(b.idempotent).toBe(true)

      const list = (await (
        await req(bearer, 'GET', `/api/v1/ui/training-plans/${planId}/items`)
      ).json()) as { items: unknown[] }
      expect(list.items).toHaveLength(1)
    })

    it('different refs create distinct items', async () => {
      const bearer = await loginAs('user_tpi_ref_distinct')
      const planId = await createPlan(bearer, 'Ref Item Plan B')
      const base = { dayKey: 'tue', position: 0, sourceKind: 'strength', note: 'note' }
      await req(bearer, 'POST', `/api/v1/ui/training-plans/${planId}/items`, {
        ...base,
        ref: 'tmp_tpi_a',
      })
      await req(bearer, 'POST', `/api/v1/ui/training-plans/${planId}/items`, {
        ...base,
        ref: 'tmp_tpi_b',
      })
      const list = (await (
        await req(bearer, 'GET', `/api/v1/ui/training-plans/${planId}/items`)
      ).json()) as { items: unknown[] }
      expect(list.items).toHaveLength(2)
    })

    it('items without a ref are unconstrained — duplicates allowed', async () => {
      const bearer = await loginAs('user_tpi_no_ref')
      const planId = await createPlan(bearer, 'Ref Item Plan C')
      const base = { dayKey: 'wed', position: 0, sourceKind: 'strength', note: 'note' }
      await req(bearer, 'POST', `/api/v1/ui/training-plans/${planId}/items`, base)
      await req(bearer, 'POST', `/api/v1/ui/training-plans/${planId}/items`, base)
      const list = (await (
        await req(bearer, 'GET', `/api/v1/ui/training-plans/${planId}/items`)
      ).json()) as { items: unknown[] }
      expect(list.items).toHaveLength(2)
    })

    it('the same ref in two different plans does NOT collide (scoped per plan)', async () => {
      const bearer = await loginAs('user_tpi_ref_scoped')
      const planA = await createPlan(bearer, 'Ref Item Plan D')
      const planB = await createPlan(bearer, 'Ref Item Plan E')
      const payload = { dayKey: 'thu', position: 0, sourceKind: 'strength', note: 'note', ref: 'shared' }
      const a = await req(bearer, 'POST', `/api/v1/ui/training-plans/${planA}/items`, payload)
      const b = await req(bearer, 'POST', `/api/v1/ui/training-plans/${planB}/items`, payload)
      expect(a.status).toBe(201)
      expect(b.status).toBe(201)
    })
  })

  // --- exercises (owner-scoped; ALSO carries a name find-or-create rule —
  // the same dual-key disambiguation as wod-templates) ------------------

  describe('exercises', () => {
    const exBody = (name: string) => ({
      name,
      discipline: 'bodyweight',
      movementPattern: 'carry',
      metricShape: 'distance_time',
      muscles: [{ muscleId: 'quads', role: 'primary' }],
    })

    it('same ref twice returns the existing exercise (200, idempotent:true, same id)', async () => {
      const bearer = await loginAs('user_ex_ref_idem')
      const first = await req(bearer, 'POST', '/api/v1/ui/exercises', {
        ...exBody('Ref Replay Move'),
        ref: 'tmp_ex_replay',
      })
      expect(first.status).toBe(201)
      const a = (await first.json()) as { id: string; idempotent?: boolean; ref?: string | null }
      expect(a.idempotent).toBeUndefined()
      expect(a.ref).toBe('tmp_ex_replay')

      const second = await req(bearer, 'POST', '/api/v1/ui/exercises', {
        ...exBody('Ref Replay Move'),
        ref: 'tmp_ex_replay',
      })
      expect(second.status).toBe(200)
      const b = (await second.json()) as { id: string; idempotent?: boolean }
      expect(b.id).toBe(a.id)
      expect(b.idempotent).toBe(true)
    })

    // The CAUTION case, same as wod-templates: a NAME collision with a fresh
    // ref must resolve via the pre-existing name find-or-create (200, NOT
    // idempotent-flagged), never silently persisting the fresh ref onto the
    // pre-existing row.
    it('a NAME collision with a different ref is NOT reported as a ref replay', async () => {
      const bearer = await loginAs('user_ex_name_vs_ref')
      const first = await req(bearer, 'POST', '/api/v1/ui/exercises', {
        ...exBody('Name Vs Ref Move'),
        ref: 'tmp_ex_name_1',
      })
      expect(first.status).toBe(201)
      const original = (await first.json()) as { id: string; ref?: string | null }
      expect(original.ref).toBe('tmp_ex_name_1')

      const collision = await req(bearer, 'POST', '/api/v1/ui/exercises', {
        ...exBody('Name Vs Ref Move'),
        ref: 'tmp_ex_name_2',
      })
      expect(collision.status).toBe(200)
      const replayed = (await collision.json()) as {
        id: string
        idempotent?: boolean
        ref?: string | null
      }
      expect(replayed.id).toBe(original.id)
      expect(replayed.idempotent).toBeUndefined()
      // The original row's ref is untouched — the fresh ref was never persisted.
      expect(replayed.ref).toBe('tmp_ex_name_1')

      // Because 'tmp_ex_name_2' was never claimed, a create with that ref + a
      // genuinely different name produces a brand-new row (no phantom claim).
      const third = await req(bearer, 'POST', '/api/v1/ui/exercises', {
        ...exBody('Name Vs Ref Move — Different'),
        ref: 'tmp_ex_name_2',
      })
      expect(third.status).toBe(201)
      const brandNew = (await third.json()) as { id: string }
      expect(brandNew.id).not.toBe(original.id)
    })
  })

  // --- metrics (plain always-insert create) ----------------------------

  describe('metrics', () => {
    const metricBody = { recordedAt: '2026-07-01T07:00:00.000Z', kind: 'bodyweight', value: 80 }

    it('same ref twice returns the existing row (200, idempotent:true, same id)', async () => {
      const bearer = await loginAs('user_metric_ref_idem')
      const first = await req(bearer, 'POST', '/api/v1/ui/metrics', {
        ...metricBody,
        ref: 'tmp_metric_replay',
      })
      expect(first.status).toBe(201)
      const a = (await first.json()) as { id: string; idempotent?: boolean }
      expect(a.idempotent).toBeUndefined()

      const second = await req(bearer, 'POST', '/api/v1/ui/metrics', {
        ...metricBody,
        value: 81, // a divergent retry body must still resolve to the first row
        ref: 'tmp_metric_replay',
      })
      expect(second.status).toBe(200)
      const b = (await second.json()) as { id: string; idempotent?: boolean }
      expect(b.id).toBe(a.id)
      expect(b.idempotent).toBe(true)
    })

    it('different refs create distinct rows; omitting ref allows duplicates', async () => {
      const bearer = await loginAs('user_metric_ref_distinct')
      const a = await req(bearer, 'POST', '/api/v1/ui/metrics', { ...metricBody, ref: 'tmp_metric_a' })
      const b = await req(bearer, 'POST', '/api/v1/ui/metrics', { ...metricBody, ref: 'tmp_metric_b' })
      expect(a.status).toBe(201)
      expect(b.status).toBe(201)
      expect(((await a.json()) as { id: string }).id).not.toBe(((await b.json()) as { id: string }).id)

      const c1 = await req(bearer, 'POST', '/api/v1/ui/metrics', metricBody)
      const c2 = await req(bearer, 'POST', '/api/v1/ui/metrics', metricBody)
      expect(c1.status).toBe(201)
      expect(c2.status).toBe(201)
      expect(((await c1.json()) as { id: string }).id).not.toBe(
        ((await c2.json()) as { id: string }).id,
      )
    })
  })
})
