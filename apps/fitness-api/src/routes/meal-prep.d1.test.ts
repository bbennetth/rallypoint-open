import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import type { FoodLogEntryDto, PreparedMealDto } from '@rallypoint/fitness-shared'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb, type Db } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { encryptBearer } from '../crypto/encryption.js'
import { FITNESS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 integration tests for the meal-prep tool. Real D1 via
// vitest-pool-workers; the food-scan external services are stubbed but
// unused here (meal-prep persists already-resolved ingredients). Exercises
// the cooking → active → finished lifecycle, the guarded decrement, and the
// diary/dashboard reuse (a logged portion is a normal food_log_entries row).

const CSRF = 'csrf_token_value_meal_aaaaaaaaaaaaaaaaaa'

const services: Services = {
  idClient: {
    verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
    signoutRpidBearer: async () => {},
  },
  rpidSso: { exchange: async () => ({ ok: false as const, reason: 'invalid' as const }) },
  profiles: { lookup: async () => null },
  settings: { get: async () => ({}), patch: async (_u, _n, p) => p },
  offClient: { lookup: async () => null, search: async () => [] },
  foodVision: {
    analyzeFoodImage: async () => ({}) as never,
    analyzeDrinkImage: async () => ({}) as never,
    analyzeNutritionLabel: async () => ({}) as never,
  },
  aiTraces: { recordTrace: async () => {}, recordFeedback: async () => ({ ok: true }) },
}

// Two ingredients with round macros so totals/density are checkable:
//   A: 100 g, 200 kcal, 10 P, 20 C, 5 F
//   B: 150 g, 300 kcal, 5 P, 40 C, 12 F
//   → total 250 g, 500 kcal, 15 P, 60 C, 17 F ; density/100g = 200/6/24/6.8
const ING_A = { name: 'Chicken', gramsAdded: 100, kcal: 200, proteinG: 10, carbsG: 20, fatG: 5, source: 'barcode' as const }
const ING_B = { name: 'Rice', gramsAdded: 150, kcal: 300, proteinG: 5, carbsG: 40, fatG: 12, source: 'manual' as const }

describe('D1 integration — meal-prep surface', () => {
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

  async function req(bearer: string, method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: headers(bearer),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  // Create a 'cooking' meal, add A + B, return its id.
  async function cookAB(bearer: string, name = 'Test meal'): Promise<PreparedMealDto> {
    const created = (await (await req(bearer, 'POST', '/api/v1/ui/meal-prep', { name })).json()) as PreparedMealDto
    await req(bearer, 'POST', `/api/v1/ui/meal-prep/${created.id}/ingredients`, ING_A)
    const after = (await (
      await req(bearer, 'POST', `/api/v1/ui/meal-prep/${created.id}/ingredients`, ING_B)
    ).json()) as PreparedMealDto
    return after
  }

  it('rejects meal-prep routes without a session (401)', async () => {
    for (const [method, path] of [
      ['POST', '/api/v1/ui/meal-prep'],
      ['GET', '/api/v1/ui/meal-prep'],
      ['GET', '/api/v1/ui/meal-prep/pmeal_x'],
      ['POST', '/api/v1/ui/meal-prep/pmeal_x/ingredients'],
      ['POST', '/api/v1/ui/meal-prep/pmeal_x/finish'],
      ['POST', '/api/v1/ui/meal-prep/pmeal_x/mark-finished'],
      ['POST', '/api/v1/ui/meal-prep/pmeal_x/log'],
      ['POST', '/api/v1/ui/meal-prep/pmeal_x/save-as-recipe'],
      ['GET', '/api/v1/ui/recipes'],
    ] as const) {
      const res = await app.request(`http://localhost${path}`, {
        method,
        headers: {
          'x-rp-csrf': CSRF,
          cookie: `${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}`,
          'content-type': 'application/json',
          origin: envVars.FITNESS_UI_ORIGIN,
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      })
      expect(res.status, `${method} ${path}`).toBe(401)
    }
  })

  it('creates an empty cooking meal', async () => {
    const bearer = await loginAs('user_mp_empty')
    const res = await req(bearer, 'POST', '/api/v1/ui/meal-prep', {})
    expect(res.status).toBe(201)
    const meal = (await res.json()) as PreparedMealDto
    expect(meal.status).toBe('cooking')
    expect(meal.totalGrams).toBe(0)
    expect(meal.gramsRemaining).toBe(0)
    expect(meal.servings).toBeNull()
    expect(meal.servingGrams).toBeNull()
    expect(meal.servingsRemaining).toBeNull()
    expect(meal.name).toBe('Prepared meal')
  })

  it('adding ingredients refreshes the meal totals', async () => {
    const bearer = await loginAs('user_mp_totals')
    const meal = await cookAB(bearer)
    expect(meal.totalGrams).toBe(250)
    expect(meal.totalKcal).toBe(500)
    expect(meal.totalProteinG).toBe(15)
    expect(meal.totalCarbsG).toBe(60)
    expect(meal.totalFatG).toBe(17)
    // detail carries the ingredient lines
    const detail = (await (await req(bearer, 'GET', `/api/v1/ui/meal-prep/${meal.id}`)).json()) as PreparedMealDto
    expect(detail.ingredients).toHaveLength(2)
  })

  it('removing an ingredient re-derives the totals', async () => {
    const bearer = await loginAs('user_mp_remove')
    const meal = await cookAB(bearer)
    const detail = (await (await req(bearer, 'GET', `/api/v1/ui/meal-prep/${meal.id}`)).json()) as PreparedMealDto
    const ingId = detail.ingredients!.find((i) => i.name === 'Rice')!.id
    const res = await req(bearer, 'DELETE', `/api/v1/ui/meal-prep/${meal.id}/ingredients/${ingId}`)
    expect(res.status).toBe(200)
    const after = (await res.json()) as PreparedMealDto
    expect(after.totalGrams).toBe(100)
    expect(after.totalKcal).toBe(200)
  })

  it('editing an ingredient replaces its snapshot and re-derives the totals', async () => {
    const bearer = await loginAs('user_mp_edit')
    const meal = await cookAB(bearer)
    const detail = (await (await req(bearer, 'GET', `/api/v1/ui/meal-prep/${meal.id}`)).json()) as PreparedMealDto
    const ing = detail.ingredients!.find((i) => i.name === 'Rice')!
    const res = await req(bearer, 'PATCH', `/api/v1/ui/meal-prep/${meal.id}/ingredients/${ing.id}`, {
      name: 'Brown rice',
      brand: 'Lundberg',
      gramsAdded: 200,
      kcal: 400,
      proteinG: 8,
      carbsG: 80,
      fatG: 4,
    })
    expect(res.status).toBe(200)
    const after = (await res.json()) as PreparedMealDto
    // A (100/200/10/20/5) + edited B (200/400/8/80/4)
    expect(after.totalGrams).toBe(300)
    expect(after.totalKcal).toBe(600)
    expect(after.totalProteinG).toBe(18)
    expect(after.totalCarbsG).toBe(100)
    expect(after.totalFatG).toBe(9)
    const line = after.ingredients!.find((i) => i.id === ing.id)!
    expect(line.name).toBe('Brown rice')
    expect(line.brand).toBe('Lundberg')
    expect(line.gramsAdded).toBe(200)
    // Frozen provenance fields survive the edit untouched.
    expect(line.source).toBe(ing.source)
    expect(line.foodItemId).toBe(ing.foodItemId)
  })

  it('editing an ingredient 404s for a missing line, meal, or another actor', async () => {
    const bearer = await loginAs('user_mp_edit_404')
    const meal = await cookAB(bearer)
    const detail = (await (await req(bearer, 'GET', `/api/v1/ui/meal-prep/${meal.id}`)).json()) as PreparedMealDto
    const ing = detail.ingredients![0]!
    const patch = { name: 'X', gramsAdded: 50, kcal: 100, proteinG: 1, carbsG: 2, fatG: 3 }
    // missing ingredient line
    expect(
      (await req(bearer, 'PATCH', `/api/v1/ui/meal-prep/${meal.id}/ingredients/pmi_missing`, patch)).status,
    ).toBe(404)
    // missing meal
    expect(
      (await req(bearer, 'PATCH', `/api/v1/ui/meal-prep/pmeal_missing/ingredients/${ing.id}`, patch)).status,
    ).toBe(404)
    // another actor can't touch it
    const other = await loginAs('user_mp_edit_404_other')
    expect(
      (await req(other, 'PATCH', `/api/v1/ui/meal-prep/${meal.id}/ingredients/${ing.id}`, patch)).status,
    ).toBe(404)
    // …and nothing changed
    const fresh = (await (await req(bearer, 'GET', `/api/v1/ui/meal-prep/${meal.id}`)).json()) as PreparedMealDto
    expect(fresh.totalGrams).toBe(250)
  })

  it('editing an ingredient 409s once the meal is no longer cooking', async () => {
    const bearer = await loginAs('user_mp_edit_409')
    const meal = await cookAB(bearer)
    const detail = (await (await req(bearer, 'GET', `/api/v1/ui/meal-prep/${meal.id}`)).json()) as PreparedMealDto
    const ing = detail.ingredients![0]!
    await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/finish`, {})
    const res = await req(bearer, 'PATCH', `/api/v1/ui/meal-prep/${meal.id}/ingredients/${ing.id}`, {
      name: 'X',
      gramsAdded: 50,
      kcal: 100,
      proteinG: 1,
      carbsG: 2,
      fatG: 3,
    })
    expect(res.status).toBe(409)
  })

  it('editing an ingredient validates the body (400)', async () => {
    const bearer = await loginAs('user_mp_edit_400')
    const meal = await cookAB(bearer)
    const detail = (await (await req(bearer, 'GET', `/api/v1/ui/meal-prep/${meal.id}`)).json()) as PreparedMealDto
    const ing = detail.ingredients![0]!
    for (const bad of [
      {},
      { name: '', gramsAdded: 50, kcal: 100, proteinG: 1, carbsG: 2, fatG: 3 },
      { name: 'X', gramsAdded: 0, kcal: 100, proteinG: 1, carbsG: 2, fatG: 3 },
      { name: 'X', gramsAdded: 50, kcal: -1, proteinG: 1, carbsG: 2, fatG: 3 },
    ]) {
      const res = await req(bearer, 'PATCH', `/api/v1/ui/meal-prep/${meal.id}/ingredients/${ing.id}`, bad)
      expect(res.status).toBe(400)
    }
  })

  it('rejects an ingredient referencing a food item the actor cannot see (404)', async () => {
    const bearer = await loginAs('user_mp_phantom')
    const created = (await (await req(bearer, 'POST', '/api/v1/ui/meal-prep', {})).json()) as PreparedMealDto
    const res = await req(bearer, 'POST', `/api/v1/ui/meal-prep/${created.id}/ingredients`, {
      ...ING_A,
      foodItemId: 'ff_does_not_exist',
    })
    expect(res.status).toBe(404)
    // …and nothing was added to the meal.
    const detail = (await (await req(bearer, 'GET', `/api/v1/ui/meal-prep/${created.id}`)).json()) as PreparedMealDto
    expect(detail.ingredients ?? []).toHaveLength(0)
  })

  it('finish rejects an empty meal, then lists by status', async () => {
    const bearer = await loginAs('user_mp_finish_empty')
    const created = (await (await req(bearer, 'POST', '/api/v1/ui/meal-prep', {})).json()) as PreparedMealDto
    const res = await req(bearer, 'POST', `/api/v1/ui/meal-prep/${created.id}/finish`, {})
    expect(res.status).toBe(409)
    const cooking = (await (
      await req(bearer, 'GET', '/api/v1/ui/meal-prep?status=cooking')
    ).json()) as { meals: PreparedMealDto[] }
    expect(cooking.meals.some((m) => m.id === created.id)).toBe(true)
  })

  it('finish seeds gramsRemaining + derives servings', async () => {
    const bearer = await loginAs('user_mp_finish')
    const meal = await cookAB(bearer)
    const res = await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/finish`, { servings: 5 })
    expect(res.status).toBe(200)
    const active = (await res.json()) as PreparedMealDto
    expect(active.status).toBe('active')
    expect(active.gramsRemaining).toBe(250)
    expect(active.servings).toBe(5)
    expect(active.servingGrams).toBe(50)
    expect(active.servingsRemaining).toBe(5)
    expect(active.preparedAt).not.toBeNull()
  })

  it('rejects add/remove after cooking has finished (409)', async () => {
    const bearer = await loginAs('user_mp_frozen')
    const meal = await cookAB(bearer)
    await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/finish`, {})
    const addRes = await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/ingredients`, ING_A)
    expect(addRes.status).toBe(409)
    const detail = (await (await req(bearer, 'GET', `/api/v1/ui/meal-prep/${meal.id}`)).json()) as PreparedMealDto
    const rmRes = await req(
      bearer,
      'DELETE',
      `/api/v1/ui/meal-prep/${meal.id}/ingredients/${detail.ingredients![0]!.id}`,
    )
    expect(rmRes.status).toBe(409)
  })

  it('logs a portion by weight — appears in the diary + calorie dashboard', async () => {
    const bearer = await loginAs('user_mp_logweight')
    const meal = await cookAB(bearer)
    await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/finish`, { servings: 5 })

    const loggedAt = new Date().toISOString()
    const res = await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/log`, {
      loggedAt,
      quantityGrams: 50,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { meal: PreparedMealDto; entry: FoodLogEntryDto }
    // 50 g of a 200 kcal/100 g meal = 100 kcal; density-derived server-side.
    expect(body.entry.kcal).toBe(100)
    expect(body.entry.source).toBe('prepared_meal')
    expect(body.entry.preparedMealId).toBe(meal.id)
    expect(body.meal.gramsRemaining).toBe(200)
    expect(body.meal.servingsRemaining).toBe(4)

    // The portion is a normal diary row (GET /food/log).
    const diary = (await (await req(bearer, 'GET', '/api/v1/ui/food/log')).json()) as {
      entries: FoodLogEntryDto[]
    }
    expect(diary.entries.some((e) => e.preparedMealId === meal.id && e.kcal === 100)).toBe(true)

    // …and shows on the calorie dashboard (GET /food/summary).
    const summary = (await (await req(bearer, 'GET', '/api/v1/ui/food/summary?tz=0')).json()) as {
      days: { date: string; kcal: number }[]
    }
    expect(summary.days.some((d) => d.kcal >= 100)).toBe(true)
  })

  it('logs a portion by serving unit (stores the display pair)', async () => {
    const bearer = await loginAs('user_mp_logserving')
    const meal = await cookAB(bearer)
    await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/finish`, { servings: 5 })
    // Client converts "1 serving" → 50 g canonical; server stores both.
    const res = await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/log`, {
      loggedAt: new Date().toISOString(),
      quantityGrams: 50,
      quantityUnit: 'serving',
      quantityAmount: 1,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entry: FoodLogEntryDto }
    expect(body.entry.quantityUnit).toBe('serving')
    expect(body.entry.quantityAmount).toBe(1)
    expect(body.entry.quantityGrams).toBe(50)
  })

  it('over-request is rejected (409) and writes nothing', async () => {
    const bearer = await loginAs('user_mp_over')
    const meal = await cookAB(bearer)
    await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/finish`, {})
    const res = await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/log`, {
      loggedAt: new Date().toISOString(),
      quantityGrams: 1000, // only 250 g available
    })
    expect(res.status).toBe(409)
    // remaining untouched, no diary row inserted
    const detail = (await (await req(bearer, 'GET', `/api/v1/ui/meal-prep/${meal.id}`)).json()) as PreparedMealDto
    expect(detail.gramsRemaining).toBe(250)
    const diary = (await (await req(bearer, 'GET', '/api/v1/ui/food/log')).json()) as {
      entries: FoodLogEntryDto[]
    }
    expect(diary.entries.some((e) => e.preparedMealId === meal.id)).toBe(false)
  })

  it('logging exactly the remaining amount auto-finishes the batch', async () => {
    const bearer = await loginAs('user_mp_drain')
    const meal = await cookAB(bearer)
    await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/finish`, { servings: 2 })
    const res = await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/log`, {
      loggedAt: new Date().toISOString(),
      quantityGrams: 250,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { meal: PreparedMealDto }
    expect(body.meal.gramsRemaining).toBe(0)
    expect(body.meal.status).toBe('finished')
    expect(body.meal.servingsRemaining).toBe(0)
    // a further log is rejected — no longer active
    const again = await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/log`, {
      loggedAt: new Date().toISOString(),
      quantityGrams: 1,
    })
    expect(again.status).toBe(409)
  })

  it('mark-finished writes off the leftovers WITHOUT a diary entry', async () => {
    const bearer = await loginAs('user_mp_markfin')
    const meal = await cookAB(bearer)
    await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/finish`, { servings: 5 })
    // eat one serving, then bin the rest
    await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/log`, {
      loggedAt: new Date().toISOString(),
      quantityGrams: 50,
    })
    const res = await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/mark-finished`, {})
    expect(res.status).toBe(200)
    const done = (await res.json()) as PreparedMealDto
    expect(done.status).toBe('finished')
    expect(done.gramsRemaining).toBe(0)
    expect(done.servingsRemaining).toBe(0)
    // totals are the batch's history — untouched by the write-off
    expect(done.totalGrams).toBe(250)
    expect(done.totalKcal).toBe(500)
    expect(done.totalProteinG).toBe(15)
    expect(done.totalCarbsG).toBe(60)
    expect(done.totalFatG).toBe(17)

    // The one logged portion is the ONLY diary row: the 200 g written off
    // must not land in the diary as eaten.
    const diary = (await (await req(bearer, 'GET', '/api/v1/ui/food/log')).json()) as {
      entries: FoodLogEntryDto[]
    }
    const fromBatch = diary.entries.filter((e) => e.preparedMealId === meal.id)
    expect(fromBatch).toHaveLength(1)
    expect(fromBatch[0]!.quantityGrams).toBe(50)

    // it lists under the finished filter now
    const finished = (await (
      await req(bearer, 'GET', '/api/v1/ui/meal-prep?status=finished')
    ).json()) as { meals: PreparedMealDto[] }
    expect(finished.meals.some((m) => m.id === meal.id)).toBe(true)
  })

  it('mark-finished blocks further portion logs (409)', async () => {
    const bearer = await loginAs('user_mp_markfin_relog')
    const meal = await cookAB(bearer)
    await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/finish`, {})
    expect((await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/mark-finished`, {})).status).toBe(200)
    const relog = await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/log`, {
      loggedAt: new Date().toISOString(),
      quantityGrams: 10,
    })
    expect(relog.status).toBe(409)
  })

  it('mark-finished 409s while still cooking and when already finished', async () => {
    const bearer = await loginAs('user_mp_markfin_status')
    const meal = await cookAB(bearer)
    // still cooking — /finish is the right call, not this one
    expect((await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/mark-finished`, {})).status).toBe(409)
    await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/finish`, {})
    expect((await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/mark-finished`, {})).status).toBe(200)
    // already finished — not idempotent, it reports the conflict
    const again = await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/mark-finished`, {})
    expect(again.status).toBe(409)
    const body = (await again.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('meal_not_active')
  })

  it('mark-finished is actor-scoped (404) and leaves the batch active', async () => {
    const owner = await loginAs('user_mp_markfin_owner')
    const other = await loginAs('user_mp_markfin_other')
    const meal = await cookAB(owner)
    await req(owner, 'POST', `/api/v1/ui/meal-prep/${meal.id}/finish`, {})
    expect((await req(other, 'POST', `/api/v1/ui/meal-prep/${meal.id}/mark-finished`, {})).status).toBe(404)
    const still = (await (await req(owner, 'GET', `/api/v1/ui/meal-prep/${meal.id}`)).json()) as PreparedMealDto
    expect(still.status).toBe('active')
    expect(still.gramsRemaining).toBe(250)
  })

  it('cannot log from a meal still cooking (409)', async () => {
    const bearer = await loginAs('user_mp_stillcooking')
    const meal = await cookAB(bearer)
    const res = await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/log`, {
      loggedAt: new Date().toISOString(),
      quantityGrams: 10,
    })
    expect(res.status).toBe(409)
  })

  it('isolates meals across users (404) and cascades on delete', async () => {
    const owner = await loginAs('user_mp_owner')
    const other = await loginAs('user_mp_other')
    const meal = await cookAB(owner)
    // other user can't see it
    expect((await req(other, 'GET', `/api/v1/ui/meal-prep/${meal.id}`)).status).toBe(404)
    expect((await req(other, 'DELETE', `/api/v1/ui/meal-prep/${meal.id}`)).status).toBe(404)
    // owner deletes it → gone (ingredient rows cascade)
    expect((await req(owner, 'DELETE', `/api/v1/ui/meal-prep/${meal.id}`)).status).toBe(200)
    expect((await req(owner, 'GET', `/api/v1/ui/meal-prep/${meal.id}`)).status).toBe(404)
  })
})
