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

// D1 integration tests for the WOD-template UI surface (slice 6). The
// migration that creates the table also seeds the canonical "Girls" +
// "Heroes" benchmark set; assertions below cover the global-vs-custom
// split, filter validation, and the find-or-create create path.

const CSRF = 'csrf_token_value_wod_templates_aaaaaaaaaaaaaa'

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

describe('D1 integration — WOD templates UI surface', () => {
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

  const CINDY_BODY = {
    wodType: 'amrap',
    durationS: 1200,
    movements: [
      { exerciseId: 'fx_seed_pull_up', reps: 5 },
      { exerciseId: 'fx_seed_push_up', reps: 10 },
      { exerciseId: 'fx_seed_air_squat', reps: 15 },
    ],
  }

  type WodDto = {
    id: string
    name: string
    isCustom: boolean
    isBenchmark: boolean
    kind: 'wod' | 'strength'
    wodType: string | null
    timeCapS: number | null
    body: { wodType?: string; kind?: string }
  }

  it('rejects unauthenticated reads with 401', async () => {
    const res = await app.request('http://localhost/api/v1/ui/wod-templates', {
      headers: { 'x-rp-csrf': CSRF, cookie: `${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}` },
    })
    expect(res.status).toBe(401)
  })

  it('returns the benchmark seed (Fran, Cindy, Murph, ...) with isCustom=false', async () => {
    const bearer = await loginAs('user_wod_seed')
    const res = await req(bearer, 'GET', '/api/v1/ui/wod-templates')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { wodTemplates: WodDto[] }
    const names = body.wodTemplates.map((w) => w.name)
    for (const name of ['Fran', 'Cindy', 'Helen', 'Murph']) {
      expect(names).toContain(name)
    }
    const fran = body.wodTemplates.find((w) => w.name === 'Fran')!
    expect(fran.isCustom).toBe(false)
    expect(fran.isBenchmark).toBe(true)
    expect(fran.wodType).toBe('for_time')
    expect(fran.body.wodType).toBe('for_time')
    // Legacy benchmark rows have kind=null in D1 — the repo maps that
    // back to 'wod' so the DTO is never null. (Ink redesign S0.)
    expect(fran.kind).toBe('wod')
  })

  it('creates a strength template and lists it with kind=strength', async () => {
    const bearer = await loginAs('user_wod_strength_create')
    const payload = {
      name: 'Strength A',
      description: 'Heavy day.',
      body: {
        kind: 'strength',
        blocks: [
          {
            exerciseId: 'fx_seed_back_squat',
            name: 'Back Squat',
            sets: [
              { reps: 5, loadKg: 100 },
              { reps: 5, loadKg: 100 },
              { reps: 5, loadKg: 100 },
            ],
          },
        ],
      },
    }
    const first = await req(bearer, 'POST', '/api/v1/ui/wod-templates', payload)
    expect(first.status).toBe(201)
    const firstBody = (await first.json()) as WodDto
    expect(firstBody.kind).toBe('strength')
    expect(firstBody.wodType).toBeNull()
    expect(firstBody.timeCapS).toBeNull()
    expect(firstBody.body.kind).toBe('strength')

    // Find-or-create idempotency: re-POST returns 200 + same row.
    const dupe = await req(bearer, 'POST', '/api/v1/ui/wod-templates', payload)
    expect(dupe.status).toBe(200)
    const dupeBody = (await dupe.json()) as WodDto
    expect(dupeBody.id).toBe(firstBody.id)

    // Lists return the strength template alongside benchmark WODs.
    const list = await req(bearer, 'GET', '/api/v1/ui/wod-templates')
    const listBody = (await list.json()) as { wodTemplates: WodDto[] }
    const strength = listBody.wodTemplates.find((w) => w.id === firstBody.id)
    expect(strength?.kind).toBe('strength')
  })

  it('round-trips a per-block restS on a strength template', async () => {
    const bearer = await loginAs('user_wod_strength_rest')
    type StrengthBlockDto = { restS?: number }
    const payload = {
      name: 'Rest day A',
      body: {
        kind: 'strength',
        blocks: [
          {
            exerciseId: 'fx_seed_deadlift',
            name: 'Deadlift',
            sets: [{ reps: 5, loadKg: 140 }],
            restS: 180,
          },
          {
            // No restS — stays absent, not defaulted, so the live
            // engine's fallback applies.
            exerciseId: 'fx_seed_pull_up',
            name: 'Pull Up',
            sets: [{ reps: 8 }],
          },
        ],
      },
    }
    const created = await req(bearer, 'POST', '/api/v1/ui/wod-templates', payload)
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as WodDto & {
      body: { blocks: StrengthBlockDto[] }
    }
    expect(createdBody.body.blocks[0]?.restS).toBe(180)
    expect(createdBody.body.blocks[1]?.restS).toBeUndefined()

    const got = await req(
      bearer,
      'GET',
      `/api/v1/ui/wod-templates/${encodeURIComponent(createdBody.id)}`,
    )
    expect(got.status).toBe(200)
    const gotBody = (await got.json()) as WodDto & { body: { blocks: StrengthBlockDto[] } }
    expect(gotBody.body.blocks[0]?.restS).toBe(180)
    expect(gotBody.body.blocks[1]?.restS).toBeUndefined()

    // Out-of-range restS is rejected at the boundary.
    const bad = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      name: 'Rest day B',
      body: {
        kind: 'strength',
        blocks: [
          {
            exerciseId: 'fx_seed_deadlift',
            name: 'Deadlift',
            sets: [{ reps: 5 }],
            restS: 601,
          },
        ],
      },
    })
    expect(bad.status).toBe(400)
  })

  it('allows same name across kinds per-owner (kind is part of the UNIQUE)', async () => {
    // Regression test for the kind-blind findCustomByName bug (code-
    // review F1): a user creating a WOD "Squats" and then a strength
    // "Squats" used to silently receive the existing WOD row back as
    // a 200, instead of creating a new strength row. After migration
    // 0011 + the repo's kind-aware find, the two are distinct rows.
    const bearer = await loginAs('user_kind_collision')
    const wodRes = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      name: 'Squats',
      wodType: 'for_time',
      timeCapS: 600,
      body: {
        wodType: 'for_time',
        rounds: 1,
        schemeRounds: [10],
        movements: [{ exerciseId: 'fx_seed_back_squat', reps: 10 }],
      },
    })
    expect(wodRes.status).toBe(201)
    const wod = (await wodRes.json()) as WodDto
    expect(wod.kind).toBe('wod')

    const strengthRes = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      name: 'Squats',
      body: {
        kind: 'strength',
        blocks: [
          {
            exerciseId: 'fx_seed_back_squat',
            name: 'Back Squat',
            sets: [{ reps: 5, loadKg: 100 }],
          },
        ],
      },
    })
    // 201 means a new row was created; before the fix this would have
    // been a 200 returning the existing WOD row (silent data loss).
    expect(strengthRes.status).toBe(201)
    const strength = (await strengthRes.json()) as WodDto
    expect(strength.kind).toBe('strength')
    expect(strength.id).not.toBe(wod.id)

    // Each find-or-create re-POST returns its own-kind row.
    const reWod = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      name: 'Squats',
      wodType: 'for_time',
      timeCapS: 600,
      body: {
        wodType: 'for_time',
        rounds: 1,
        schemeRounds: [10],
        movements: [{ exerciseId: 'fx_seed_back_squat', reps: 10 }],
      },
    })
    expect(reWod.status).toBe(200)
    expect(((await reWod.json()) as WodDto).id).toBe(wod.id)

    const reStrength = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      name: 'Squats',
      body: {
        kind: 'strength',
        blocks: [
          {
            exerciseId: 'fx_seed_back_squat',
            name: 'Back Squat',
            sets: [{ reps: 5, loadKg: 100 }],
          },
        ],
      },
    })
    expect(reStrength.status).toBe(200)
    expect(((await reStrength.json()) as WodDto).id).toBe(strength.id)
  })

  it('rejects contradictory top-level kind vs body.kind with 400 (no silent strength route)', async () => {
    // Code-review F6: previously `{kind:'wod', body:{kind:'strength',…}}`
    // silently routed to the strength branch because `bodyKind` won
    // the OR. Now the route detects the disagreement and rejects.
    const bearer = await loginAs('user_kind_contradict')
    const res = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      kind: 'wod',
      name: 'Contradicts itself',
      wodType: 'for_time',
      body: {
        kind: 'strength',
        blocks: [{ exerciseId: 'fx', name: 'X', sets: [{ reps: 5 }] }],
      },
    })
    expect(res.status).toBe(400)
  })

  it('rejects an unknown top-level kind with 400', async () => {
    const bearer = await loginAs('user_kind_typo')
    const res = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      kind: 'strenght', // typo
      name: 'X',
      body: {
        kind: 'strength',
        blocks: [{ exerciseId: 'fx', name: 'X', sets: [{ reps: 5 }] }],
      },
    })
    expect(res.status).toBe(400)
  })

  it('round-trips builder block fields (group/kind/restAfterS/rpe) on a strength template', async () => {
    const bearer = await loginAs('user_builder_fields')
    const body = {
      kind: 'strength' as const,
      blocks: [
        {
          exerciseId: 'fx_seed_back_squat',
          name: 'Back Squat',
          group: 'A',
          kind: 'load' as const,
          restS: 60,
          restAfterS: 150,
          sets: [
            { reps: 5, loadKg: 100, rpe: 8 },
            { reps: 5, loadKg: 105, rpe: 8.5 },
          ],
        },
        {
          exerciseId: 'fx_seed_pull_up',
          name: 'Pull-up',
          group: 'A',
          kind: 'body' as const,
          sets: [{ reps: 8 }],
        },
      ],
    }
    const created = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      kind: 'strength',
      name: 'Superset fixture',
      body,
    })
    expect(created.status).toBe(201)
    const dto = (await created.json()) as { id: string; body: typeof body }
    expect(dto.body).toEqual(body)

    const fetched = await req(bearer, 'GET', `/api/v1/ui/wod-templates/${dto.id}`)
    expect(fetched.status).toBe(200)
    expect(((await fetched.json()) as { body: typeof body }).body).toEqual(body)
  })

  it('round-trips max-effort (amrap) set targets on a strength template', async () => {
    const bearer = await loginAs('user_amrap_sets')
    const body = {
      kind: 'strength' as const,
      blocks: [
        {
          exerciseId: 'fx_seed_barbell_bench_press',
          name: 'Barbell Bench Press',
          sets: [
            { reps: 5, loadKg: 100 },
            // Max-effort: no rep target at all, and one with a hint.
            { amrap: true, loadKg: 100 },
            { amrap: true, reps: 12, loadKg: 80, rpe: 9.5 },
          ],
        },
      ],
    }
    const created = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      kind: 'strength',
      name: 'AMRAP finisher fixture',
      body,
    })
    expect(created.status).toBe(201)
    const dto = (await created.json()) as { id: string; body: typeof body }
    expect(dto.body).toEqual(body)

    const fetched = await req(bearer, 'GET', `/api/v1/ui/wod-templates/${dto.id}`)
    expect(fetched.status).toBe(200)
    expect(((await fetched.json()) as { body: typeof body }).body).toEqual(body)

    // A non-rep amrap prescription is still rejected by the shared schema.
    const bad = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      kind: 'strength',
      name: 'Bad amrap fixture',
      body: {
        kind: 'strength',
        blocks: [
          {
            exerciseId: 'fx_seed_assault_bike',
            name: 'Assault Bike',
            sets: [{ amrap: true, calories: 15 }],
          },
        ],
      },
    })
    expect(bad.status).toBe(400)
  })

  it('PATCH replaces a custom WOD body (+ wodType) — the Builder edits every kind', async () => {
    const bearer = await loginAs('user_wod_body_patch')
    const created = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      name: 'Editable wod fixture',
      wodType: 'for_time',
      body: {
        wodType: 'for_time',
        rounds: 3,
        schemeRounds: [21, 15, 9],
        movements: [{ exerciseId: 'fx_seed_thruster', reps: 21, loadKg: 43 }],
      },
    })
    expect([200, 201]).toContain(created.status)
    const dto = (await created.json()) as { id: string }

    const newBody = {
      wodType: 'amrap' as const,
      durationS: 1200,
      movements: [{ exerciseId: 'fx_seed_burpee', reps: 10 }],
    }
    const patched = await req(bearer, 'PATCH', `/api/v1/ui/wod-templates/${dto.id}`, {
      wodType: 'amrap',
      body: newBody,
    })
    expect(patched.status).toBe(200)
    const pd = (await patched.json()) as { wodType: string; body: typeof newBody }
    expect(pd.wodType).toBe('amrap')
    expect(pd.body).toEqual(newBody)

    // Round-trip: the type filter sees the row under its new type.
    const listed = await req(bearer, 'GET', '/api/v1/ui/wod-templates?type=amrap&custom_only=1')
    const rows = ((await listed.json()) as { wodTemplates: { id: string }[] }).wodTemplates
    expect(rows.some((r) => r.id === dto.id)).toBe(true)
  })

  it('rejects PATCH wodType without a body, and a body/wodType mismatch', async () => {
    const bearer = await loginAs('user_wod_type_desync')
    const created = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      name: 'Desync fixture',
      wodType: 'amrap',
      body: {
        wodType: 'amrap',
        durationS: 600,
        movements: [{ exerciseId: 'fx_seed_burpee', reps: 10 }],
      },
    })
    const dto = (await created.json()) as { id: string }
    const noBody = await req(bearer, 'PATCH', `/api/v1/ui/wod-templates/${dto.id}`, {
      wodType: 'for_time',
    })
    expect(noBody.status).toBe(400)
    const mismatch = await req(bearer, 'PATCH', `/api/v1/ui/wod-templates/${dto.id}`, {
      wodType: 'for_time',
      body: {
        wodType: 'amrap',
        durationS: 600,
        movements: [{ exerciseId: 'fx_seed_burpee', reps: 10 }],
      },
    })
    expect(mismatch.status).toBe(400)
  })

  it('PATCH body on a benchmark stays blocked (404 — globally owned)', async () => {
    const bearer = await loginAs('user_benchmark_body_patch')
    const res = await req(bearer, 'PATCH', '/api/v1/ui/wod-templates/wt_seed_fran', {
      body: {
        wodType: 'for_time',
        rounds: 1,
        movements: [{ exerciseId: 'fx_seed_thruster', reps: 1 }],
      },
    })
    expect(res.status).toBe(404)
  })

  it('PATCH a deleted template returns 404 (re-select, not a stale in-memory success)', async () => {
    // The update path re-selects the row after the UPDATE so a concurrent
    // delete surfaces as not-found rather than a fabricated success built
    // from the pre-check snapshot (epic #675).
    const bearer = await loginAs('user_wod_patch_deleted')
    const created = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      name: 'Doomed fixture',
      wodType: 'for_time',
      body: {
        wodType: 'for_time',
        rounds: 1,
        movements: [{ exerciseId: 'fx_seed_thruster', reps: 5 }],
      },
    })
    const dto = (await created.json()) as { id: string }
    expect((await req(bearer, 'DELETE', `/api/v1/ui/wod-templates/${dto.id}`)).status).toBe(200)

    const patched = await req(bearer, 'PATCH', `/api/v1/ui/wod-templates/${dto.id}`, {
      name: 'Back from the dead',
    })
    expect(patched.status).toBe(404)
  })

  it('PATCH body replaces a strength template’s blocks; kind-mismatched bodies 400', async () => {
    const bearer = await loginAs('user_strength_body_patch')
    const created = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      kind: 'strength',
      name: 'Editable strength fixture',
      body: {
        kind: 'strength',
        blocks: [
          { exerciseId: 'fx_seed_deadlift', name: 'Deadlift', sets: [{ reps: 5, loadKg: 140 }] },
        ],
      },
    })
    expect([200, 201]).toContain(created.status)
    const dto = (await created.json()) as { id: string }

    const newBody = {
      kind: 'strength' as const,
      blocks: [
        { exerciseId: 'fx_seed_back_squat', name: 'Back Squat', sets: [{ reps: 3, loadKg: 120 }, { reps: 3, loadKg: 125 }] },
      ],
    }
    const patched = await req(bearer, 'PATCH', `/api/v1/ui/wod-templates/${dto.id}`, {
      body: newBody,
    })
    expect(patched.status).toBe(200)
    const pd = (await patched.json()) as { body: typeof newBody }
    expect(pd.body).toEqual(newBody)

    // A strength body PATCHed onto a WOD row is a 400.
    const wodCreated = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      name: 'Immutable wod fixture',
      wodType: 'amrap',
      body: {
        wodType: 'amrap',
        durationS: 600,
        movements: [{ exerciseId: 'fx_seed_burpee', reps: 10 }],
      },
    })
    const wodDto = (await wodCreated.json()) as { id: string }
    const rejected = await req(bearer, 'PATCH', `/api/v1/ui/wod-templates/${wodDto.id}`, {
      body: newBody,
    })
    expect(rejected.status).toBe(400)
  })

  it('rejects PATCH timeCapS on a strength template with 400 (no silent swallow)', async () => {
    // Code-review F-PATCH-timeCapS-on-strength: the repo silently
    // dropped the field, leaving the client unaware. Now the route
    // pre-fetches the row and rejects mismatched fields.
    const bearer = await loginAs('user_patch_strength_cap')
    const createRes = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      name: 'Strength patch target',
      body: {
        kind: 'strength',
        blocks: [
          {
            exerciseId: 'fx_seed_back_squat',
            name: 'Back Squat',
            sets: [{ reps: 5, loadKg: 100 }],
          },
        ],
      },
    })
    expect(createRes.status).toBe(201)
    const tpl = (await createRes.json()) as WodDto
    const patchRes = await req(bearer, 'PATCH', `/api/v1/ui/wod-templates/${tpl.id}`, {
      timeCapS: 60,
    })
    expect(patchRes.status).toBe(400)
  })

  it('filters by ?type=amrap and ?benchmark_only=1', async () => {
    const bearer = await loginAs('user_wod_filter')
    const onlyAmrap = await req(bearer, 'GET', '/api/v1/ui/wod-templates?type=amrap')
    expect(onlyAmrap.status).toBe(200)
    const amrapBody = (await onlyAmrap.json()) as { wodTemplates: WodDto[] }
    expect(amrapBody.wodTemplates.length).toBeGreaterThan(0)
    expect(amrapBody.wodTemplates.every((w) => w.wodType === 'amrap')).toBe(true)

    const onlyBench = await req(bearer, 'GET', '/api/v1/ui/wod-templates?benchmark_only=1')
    expect(onlyBench.status).toBe(200)
    const benchBody = (await onlyBench.json()) as { wodTemplates: WodDto[] }
    expect(benchBody.wodTemplates.every((w) => w.isBenchmark === true)).toBe(true)
  })

  it('filters by ?custom_only=1 (only the actor’s own rows)', async () => {
    const bearer = await loginAs('user_wod_custom_filter')
    // Baseline: no customs yet → empty list, benchmarks excluded.
    const empty = await req(bearer, 'GET', '/api/v1/ui/wod-templates?custom_only=1')
    expect(empty.status).toBe(200)
    const emptyBody = (await empty.json()) as { wodTemplates: WodDto[] }
    expect(emptyBody.wodTemplates).toHaveLength(0)

    const createRes = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      name: 'Custom-only fixture',
      wodType: 'amrap',
      body: {
        wodType: 'amrap',
        durationS: 600,
        movements: [{ exerciseId: 'fx_seed_burpee', reps: 10 }],
      },
    })
    expect([200, 201]).toContain(createRes.status)

    const res = await req(bearer, 'GET', '/api/v1/ui/wod-templates?custom_only=1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { wodTemplates: WodDto[] }
    expect(body.wodTemplates).toHaveLength(1)
    expect(body.wodTemplates.every((w) => w.isCustom === true)).toBe(true)
  })

  it('rejects an unknown ?type= with 400 (not a silent empty list)', async () => {
    const bearer = await loginAs('user_wod_bad_type')
    const res = await req(bearer, 'GET', '/api/v1/ui/wod-templates?type=tabata')
    expect(res.status).toBe(400)
  })

  it('filters by ?kind=wod and ?kind=strength (S8)', async () => {
    // Code-review F8/F18-ish: the WOD library used to fetch both kinds
    // and filter client-side. Now the server drops the off-kind rows
    // before sending. Owner-private strength row makes the assertion
    // unambiguous against the benchmark seed (which is all kind=wod).
    const bearer = await loginAs('user_wod_kind_filter')
    const stRes = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      kind: 'strength',
      name: 'Kind-filter strength fixture',
      body: {
        kind: 'strength',
        blocks: [
          {
            exerciseId: 'fx_seed_deadlift',
            name: 'Deadlift',
            sets: [{ reps: 5, loadKg: 140 }],
          },
        ],
      },
    })
    expect([200, 201]).toContain(stRes.status)

    const onlyWod = await req(bearer, 'GET', '/api/v1/ui/wod-templates?kind=wod')
    expect(onlyWod.status).toBe(200)
    const wb = (await onlyWod.json()) as { wodTemplates: WodDto[] }
    expect(wb.wodTemplates.length).toBeGreaterThan(0)
    expect(wb.wodTemplates.every((w) => w.kind === 'wod')).toBe(true)

    const onlyStrength = await req(bearer, 'GET', '/api/v1/ui/wod-templates?kind=strength')
    expect(onlyStrength.status).toBe(200)
    const sb = (await onlyStrength.json()) as { wodTemplates: WodDto[] }
    expect(sb.wodTemplates.length).toBeGreaterThan(0)
    expect(sb.wodTemplates.every((w) => w.kind === 'strength')).toBe(true)
  })

  it('rejects an unknown ?kind= with 400', async () => {
    const bearer = await loginAs('user_wod_bad_kind')
    const res = await req(bearer, 'GET', '/api/v1/ui/wod-templates?kind=cardio')
    expect(res.status).toBe(400)
  })

  it('creates a private custom WOD (find-or-create idempotent)', async () => {
    const bearer = await loginAs('user_wod_create')
    const payload = {
      name: 'Custom Cindy v1',
      wodType: 'amrap',
      timeCapS: 1200,
      description: 'My twist on Cindy.',
      body: CINDY_BODY,
    }
    const first = await req(bearer, 'POST', '/api/v1/ui/wod-templates', payload)
    expect(first.status).toBe(201)
    const dto = (await first.json()) as WodDto
    expect(dto.isCustom).toBe(true)
    expect(dto.isBenchmark).toBe(false)

    // Resubmitting the same name returns 200 with the same id.
    const again = await req(bearer, 'POST', '/api/v1/ui/wod-templates', payload)
    expect(again.status).toBe(200)
    const dto2 = (await again.json()) as WodDto
    expect(dto2.id).toBe(dto.id)
  })

  it('keeps customs private to the owner', async () => {
    const ua = await loginAs('user_wod_priv_a')
    const created = await req(ua, 'POST', '/api/v1/ui/wod-templates', {
      name: 'Secret Cindy',
      wodType: 'amrap',
      body: CINDY_BODY,
    })
    const { id } = (await created.json()) as { id: string }

    const ub = await loginAs('user_wod_priv_b')
    const list = await req(ub, 'GET', '/api/v1/ui/wod-templates')
    const body = (await list.json()) as { wodTemplates: { id: string }[] }
    expect(body.wodTemplates.some((w) => w.id === id)).toBe(false)
    const direct = await req(ub, 'GET', `/api/v1/ui/wod-templates/${id}`)
    expect(direct.status).toBe(404)
  })

  it('rejects body / type mismatch with 400', async () => {
    const bearer = await loginAs('user_wod_mismatch')
    const res = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      name: 'Frankenstein',
      wodType: 'for_time',
      body: CINDY_BODY, // AMRAP body under for_time
    })
    expect(res.status).toBe(400)
  })

  it('owner can PATCH name + DELETE; benchmarks resist mutation (404 for owner)', async () => {
    const bearer = await loginAs('user_wod_mutate')
    const created = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      name: 'My WOD',
      wodType: 'amrap',
      body: CINDY_BODY,
    })
    const { id } = (await created.json()) as { id: string }

    const renamed = await req(bearer, 'PATCH', `/api/v1/ui/wod-templates/${id}`, {
      name: 'My WOD Renamed',
    })
    expect(renamed.status).toBe(200)
    expect(((await renamed.json()) as WodDto).name).toBe('My WOD Renamed')

    // Attempting to PATCH a benchmark returns 404 (no editing curated rows).
    const benchEdit = await req(bearer, 'PATCH', '/api/v1/ui/wod-templates/wt_seed_fran', {
      name: 'Fran Pro',
    })
    expect(benchEdit.status).toBe(404)
    const benchDel = await req(bearer, 'DELETE', '/api/v1/ui/wod-templates/wt_seed_fran')
    expect(benchDel.status).toBe(404)

    const removed = await req(bearer, 'DELETE', `/api/v1/ui/wod-templates/${id}`)
    expect(removed.status).toBe(200)
    const gone = await req(bearer, 'GET', `/api/v1/ui/wod-templates/${id}`)
    expect(gone.status).toBe(404)
  })

  // --- P3 fix: update WHERE clause scoped to ownerUserId ----------------

  it('update is owner-scoped: another user cannot update a custom template they do not own', async () => {
    // Verifies that the UPDATE in D1WodTemplateRepo.update includes the
    // ownerUserId predicate so a TOCTOU race (ownership check passes for
    // actor A, then actor B takes ownership before the UPDATE lands) cannot
    // mutate a row the actor no longer owns.
    // In D1 (single-isolate) we simulate this by testing the negative:
    // userB must get a 404 when trying to PATCH userA's template.
    const userA = `user_wod_owner_scope_a_${Date.now()}`
    const userB = `user_wod_owner_scope_b_${Date.now()}`
    const bearerA = await loginAs(userA)
    const bearerB = await loginAs(userB)

    // userA creates a custom template.
    const created = await req(bearerA, 'POST', '/api/v1/ui/wod-templates', {
      name: `Owner Scope Test ${Date.now()}`,
      wodType: 'amrap',
      timeCapS: 1200,
      body: CINDY_BODY,
    })
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }

    // userB tries to update userA's template → must 404.
    const stolen = await req(bearerB, 'PATCH', `/api/v1/ui/wod-templates/${id}`, {
      name: 'Stolen',
    })
    expect(stolen.status).toBe(404)

    // userA's template name is unchanged.
    const check = await req(bearerA, 'GET', `/api/v1/ui/wod-templates/${id}`)
    expect(check.status).toBe(200)
    const dto = (await check.json()) as WodDto
    // Name not 'Stolen'; it's the original name.
    expect(dto.name).not.toBe('Stolen')
  })

  it('update owner-scoped: direct repo.update with wrong userId returns null (no mutation)', async () => {
    // Exercises the repo layer directly: D1WodTemplateRepo.update with a
    // userId that does NOT own the row must return null (WHERE clause
    // includes ownerUserId = userId as well as id = id).
    const userA = `user_wod_repo_scope_a_${Date.now()}`
    const userB = `user_wod_repo_scope_b_${Date.now()}`
    const bearerA = await loginAs(userA)

    const created = await req(bearerA, 'POST', '/api/v1/ui/wod-templates', {
      name: `Repo Scope Test ${Date.now()}`,
      wodType: 'amrap',
      timeCapS: 1200,
      body: CINDY_BODY,
    })
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }

    // repo.update called with userB (not the owner) → null.
    const result = await repos.wodTemplates.update(userB, id, { name: 'Injected' })
    expect(result).toBeNull()

    // The row in DB still has userA as owner and the original name.
    const stillThere = await repos.wodTemplates.update(userA, id, {})
    expect(stillThere).not.toBeNull()
    expect(stillThere!.name).not.toBe('Injected')
  })
})
