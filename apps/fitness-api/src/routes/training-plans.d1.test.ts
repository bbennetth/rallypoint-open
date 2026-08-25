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

// D1 integration coverage for the multi-plan UI surface (Ink redesign
// S7). Covers create-find-or-create, owner isolation, the item add /
// patch / delete CRUD, the "schedule a WOD that isn't yours" 404, and
// the destructive cascade on plan delete.

const CSRF = 'csrf_token_value_plans_aaaaaaaaaaaaaaaaaaaaaaaa'

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

describe('D1 integration — training plans', () => {
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

  it('rejects unauthenticated reads with 401', async () => {
    const res = await app.request('http://localhost/api/v1/ui/training-plans', {
      headers: { 'x-rp-csrf': CSRF, cookie: `${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}` },
    })
    expect(res.status).toBe(401)
  })

  it('lists an empty array for a fresh user', async () => {
    const bearer = await loginAs('user_plan_empty')
    const res = await req(bearer, 'GET', '/api/v1/ui/training-plans')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { trainingPlans: unknown[] }).trainingPlans).toEqual([])
  })

  it('creates a plan and find-or-creates on repost (idempotent)', async () => {
    const bearer = await loginAs('user_plan_create')
    const first = await req(bearer, 'POST', '/api/v1/ui/training-plans', {
      name: 'My plan',
      lengthWeeks: 4,
    })
    expect(first.status).toBe(201)
    const firstBody = (await first.json()) as { trainingPlan: { id: string; name: string; lengthWeeks: number | null } }
    expect(firstBody.trainingPlan.name).toBe('My plan')
    expect(firstBody.trainingPlan.lengthWeeks).toBe(4)

    const dupe = await req(bearer, 'POST', '/api/v1/ui/training-plans', {
      name: 'My plan',
    })
    expect(dupe.status).toBe(200)
    const dupeBody = (await dupe.json()) as { trainingPlan: { id: string } }
    expect(dupeBody.trainingPlan.id).toBe(firstBody.trainingPlan.id)
  })

  it('isolates plans across users', async () => {
    const alice = await loginAs('user_plan_alice')
    const bob = await loginAs('user_plan_bob')
    await req(alice, 'POST', '/api/v1/ui/training-plans', { name: "Alice's plan" })
    const bobList = await req(bob, 'GET', '/api/v1/ui/training-plans')
    expect(((await bobList.json()) as { trainingPlans: unknown[] }).trainingPlans).toEqual([])
  })

  it('rejects an unknown lengthWeeks value with 400', async () => {
    const bearer = await loginAs('user_plan_bad_length')
    const res = await req(bearer, 'POST', '/api/v1/ui/training-plans', {
      name: 'bad length',
      lengthWeeks: 2,
    })
    expect(res.status).toBe(400)
  })

  it('adds a strength item with a note and lists it under the plan', async () => {
    const bearer = await loginAs('user_plan_item_add')
    const planRes = await req(bearer, 'POST', '/api/v1/ui/training-plans', {
      name: 'Item plan',
    })
    const plan = ((await planRes.json()) as { trainingPlan: { id: string } }).trainingPlan
    const itemRes = await req(
      bearer,
      'POST',
      `/api/v1/ui/training-plans/${plan.id}/items`,
      {
        dayKey: 'mon',
        position: 0,
        sourceKind: 'strength',
        note: '5x5 squat',
      },
    )
    expect(itemRes.status).toBe(201)

    const list = await req(bearer, 'GET', `/api/v1/ui/training-plans/${plan.id}/items`)
    const items = ((await list.json()) as { items: { dayKey: string; note: string | null }[] }).items
    expect(items).toHaveLength(1)
    expect(items[0]?.note).toBe('5x5 squat')
    expect(items[0]?.dayKey).toBe('mon')
  })

  // Code-review F2/F3: until S4 the Plan tab DnD couldn't store
  // strength-template rows at all (`sourceKind: 'wod_template'` was
  // hardcoded), so a dragged strength row either lost its kind or
  // failed lookup on Start. Confirm the route now accepts the new
  // `strength_template` source kind end-to-end, and rejects a kind
  // mismatch (e.g. labelling a WOD template as `strength_template`).
  it('schedules a strength_template item end-to-end', async () => {
    const bearer = await loginAs('user_plan_strength_tpl')
    // 1. Save a strength template via POST /wod-templates with kind=strength.
    const tplRes = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      kind: 'strength',
      name: 'Strength Test 5x5',
      body: {
        kind: 'strength',
        blocks: [
          { exerciseId: 'fx_seed_back_squat', name: 'Back squat', sets: [
            { reps: 5, loadKg: 100 }, { reps: 5, loadKg: 100 }, { reps: 5, loadKg: 100 },
          ] },
        ],
      },
    })
    expect([200, 201]).toContain(tplRes.status)
    const tpl = (await tplRes.json()) as { id: string; kind: string }
    expect(tpl.kind).toBe('strength')

    // 2. Make a plan and schedule the strength template on Tuesday.
    const planRes = await req(bearer, 'POST', '/api/v1/ui/training-plans', {
      name: 'Strength schedule',
    })
    const plan = ((await planRes.json()) as { trainingPlan: { id: string } }).trainingPlan
    const itemRes = await req(
      bearer,
      'POST',
      `/api/v1/ui/training-plans/${plan.id}/items`,
      {
        dayKey: 'tue',
        position: 0,
        sourceKind: 'strength_template',
        sourceId: tpl.id,
      },
    )
    expect(itemRes.status).toBe(201)

    const list = await req(bearer, 'GET', `/api/v1/ui/training-plans/${plan.id}/items`)
    const items = (await list.json()) as {
      items: { sourceKind: string; sourceId: string | null }[]
    }
    expect(items.items).toHaveLength(1)
    expect(items.items[0]?.sourceKind).toBe('strength_template')
    expect(items.items[0]?.sourceId).toBe(tpl.id)
  })

  // Kind-mismatch guard: a WOD-kind template can't be scheduled as
  // a strength_template row (and vice versa) — silent mismatch would
  // route to the wrong engine on Start.
  it('rejects strength_template pointing at a WOD-kind template (400)', async () => {
    const bearer = await loginAs('user_plan_kind_mismatch')
    const wodRes = await req(bearer, 'POST', '/api/v1/ui/wod-templates', {
      name: 'Custom WOD A',
      wodType: 'amrap',
      body: {
        wodType: 'amrap',
        durationS: 600,
        movements: [{ exerciseId: 'fx_seed_pull_up', reps: 10 }],
      },
    })
    const wod = (await wodRes.json()) as { id: string }
    const planRes = await req(bearer, 'POST', '/api/v1/ui/training-plans', {
      name: 'Mismatch plan',
    })
    const plan = ((await planRes.json()) as { trainingPlan: { id: string } }).trainingPlan
    const res = await req(bearer, 'POST', `/api/v1/ui/training-plans/${plan.id}/items`, {
      dayKey: 'wed',
      position: 0,
      sourceKind: 'strength_template',
      sourceId: wod.id,
    })
    expect(res.status).toBe(400)
  })

  // Exercise source kind (Plan inline-build): a single catalog exercise
  // can be dropped on a day as a checklist-only entry. It must reference
  // an exercise the actor can see; an unknown id 404s.
  it('schedules an exercise item end-to-end', async () => {
    const bearer = await loginAs('user_plan_exercise')
    const planRes = await req(bearer, 'POST', '/api/v1/ui/training-plans', {
      name: 'Exercise plan',
    })
    const plan = ((await planRes.json()) as { trainingPlan: { id: string } }).trainingPlan
    const itemRes = await req(
      bearer,
      'POST',
      `/api/v1/ui/training-plans/${plan.id}/items`,
      {
        dayKey: 'fri',
        position: 0,
        sourceKind: 'exercise',
        sourceId: 'fx_seed_pull_up',
      },
    )
    expect(itemRes.status).toBe(201)

    const list = await req(bearer, 'GET', `/api/v1/ui/training-plans/${plan.id}/items`)
    const items = (await list.json()) as {
      items: { sourceKind: string; sourceId: string | null }[]
    }
    expect(items.items).toHaveLength(1)
    expect(items.items[0]?.sourceKind).toBe('exercise')
    expect(items.items[0]?.sourceId).toBe('fx_seed_pull_up')
  })

  it('rejects an exercise item with an unknown exercise id (404)', async () => {
    const bearer = await loginAs('user_plan_bad_exercise')
    const planRes = await req(bearer, 'POST', '/api/v1/ui/training-plans', {
      name: 'Bad-exercise plan',
    })
    const plan = ((await planRes.json()) as { trainingPlan: { id: string } }).trainingPlan
    const res = await req(bearer, 'POST', `/api/v1/ui/training-plans/${plan.id}/items`, {
      dayKey: 'mon',
      position: 0,
      sourceKind: 'exercise',
      sourceId: 'fx_does_not_exist',
    })
    expect(res.status).toBe(404)
  })

  // Schema guard: an exercise item without a sourceId is rejected at
  // validation (the superRefine requires it for id-backed kinds).
  it('rejects an exercise item with no sourceId (400)', async () => {
    const bearer = await loginAs('user_plan_exercise_no_src')
    const planRes = await req(bearer, 'POST', '/api/v1/ui/training-plans', {
      name: 'No-src plan',
    })
    const plan = ((await planRes.json()) as { trainingPlan: { id: string } }).trainingPlan
    const res = await req(bearer, 'POST', `/api/v1/ui/training-plans/${plan.id}/items`, {
      dayKey: 'mon',
      position: 0,
      sourceKind: 'exercise',
    })
    expect(res.status).toBe(400)
  })

  it('rejects scheduling a WOD template the actor cannot see (404)', async () => {
    const bearer = await loginAs('user_plan_bad_wod')
    const planRes = await req(bearer, 'POST', '/api/v1/ui/training-plans', {
      name: 'Bad-wod plan',
    })
    const plan = ((await planRes.json()) as { trainingPlan: { id: string } }).trainingPlan
    const res = await req(bearer, 'POST', `/api/v1/ui/training-plans/${plan.id}/items`, {
      dayKey: 'mon',
      position: 0,
      sourceKind: 'wod_template',
      sourceId: 'wt_does_not_exist',
    })
    expect(res.status).toBe(404)
  })

  it('moves an item between days (PATCH dayKey + position)', async () => {
    const bearer = await loginAs('user_plan_move')
    const planRes = await req(bearer, 'POST', '/api/v1/ui/training-plans', {
      name: 'Move plan',
    })
    const plan = ((await planRes.json()) as { trainingPlan: { id: string } }).trainingPlan
    const addRes = await req(
      bearer,
      'POST',
      `/api/v1/ui/training-plans/${plan.id}/items`,
      { dayKey: 'mon', position: 0, sourceKind: 'strength', note: 'A' },
    )
    const item = ((await addRes.json()) as { item: { id: string } }).item

    const moveRes = await req(
      bearer,
      'PATCH',
      `/api/v1/ui/training-plans/${plan.id}/items/${item.id}`,
      { dayKey: 'thu', position: 1 },
    )
    expect(moveRes.status).toBe(200)
    const moved = ((await moveRes.json()) as { item: { dayKey: string; position: number } }).item
    expect(moved.dayKey).toBe('thu')
    expect(moved.position).toBe(1)
  })

  it('does NOT cascade-delete a victim\'s items when called by a non-owner (S14 P1 IDOR fix)', async () => {
    // Victim creates a plan + item.
    const victim = await loginAs('user_plan_victim')
    const planRes = await req(victim, 'POST', '/api/v1/ui/training-plans', {
      name: 'Victim plan',
    })
    const plan = ((await planRes.json()) as { trainingPlan: { id: string } }).trainingPlan
    await req(victim, 'POST', `/api/v1/ui/training-plans/${plan.id}/items`, {
      dayKey: 'mon',
      position: 0,
      sourceKind: 'strength',
      note: 'Squat',
    })

    // Attacker (different actor) tries to delete the victim's plan.
    const attacker = await loginAs('user_plan_attacker')
    const attack = await req(attacker, 'DELETE', `/api/v1/ui/training-plans/${plan.id}`)
    expect(attack.status).toBe(404)

    // Victim's items survive unchanged.
    const list = await req(victim, 'GET', `/api/v1/ui/training-plans/${plan.id}/items`)
    expect(list.status).toBe(200)
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1)
  })

  it('deletes a plan and cascades its items', async () => {
    const bearer = await loginAs('user_plan_delete')
    const planRes = await req(bearer, 'POST', '/api/v1/ui/training-plans', {
      name: 'Delete plan',
    })
    const plan = ((await planRes.json()) as { trainingPlan: { id: string } }).trainingPlan
    await req(bearer, 'POST', `/api/v1/ui/training-plans/${plan.id}/items`, {
      dayKey: 'mon',
      position: 0,
      sourceKind: 'strength',
      note: 'X',
    })
    const del = await req(bearer, 'DELETE', `/api/v1/ui/training-plans/${plan.id}`)
    expect(del.status).toBe(200)

    // The plan-scoped items endpoint now 404s because the plan itself
    // is gone (the cascade also nuked the items).
    const orphaned = await req(bearer, 'GET', `/api/v1/ui/training-plans/${plan.id}/items`)
    expect(orphaned.status).toBe(404)
  })
})
