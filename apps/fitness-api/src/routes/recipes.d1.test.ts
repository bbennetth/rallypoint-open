import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import type { PreparedMealDto, RecipeDto } from '@rallypoint/fitness-shared'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb, type Db } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { encryptBearer } from '../crypto/encryption.js'
import { FITNESS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 integration tests for recipes (save-as-recipe + cook-from-recipe).
// Real D1 via vitest-pool-workers.

const CSRF = 'csrf_token_value_recipe_aaaaaaaaaaaaaaaa'

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

const ING_A = { name: 'Chicken', gramsAdded: 100, kcal: 200, proteinG: 10, carbsG: 20, fatG: 5, source: 'barcode' as const }
const ING_B = { name: 'Rice', gramsAdded: 150, kcal: 300, proteinG: 5, carbsG: 40, fatG: 12, source: 'manual' as const }

describe('D1 integration — recipes surface', () => {
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

  async function cookAB(bearer: string, name = 'Source meal'): Promise<PreparedMealDto> {
    const created = (await (await req(bearer, 'POST', '/api/v1/ui/meal-prep', { name })).json()) as PreparedMealDto
    await req(bearer, 'POST', `/api/v1/ui/meal-prep/${created.id}/ingredients`, ING_A)
    return (await (
      await req(bearer, 'POST', `/api/v1/ui/meal-prep/${created.id}/ingredients`, ING_B)
    ).json()) as PreparedMealDto
  }

  it('save-as-recipe snapshots the ingredients and totals', async () => {
    const bearer = await loginAs('user_rcp_save')
    const meal = await cookAB(bearer)
    const res = await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/save-as-recipe`, {
      name: 'Chicken & rice',
      notes: 'weekly prep',
      servings: 5,
    })
    expect(res.status).toBe(201)
    const recipe = (await res.json()) as RecipeDto
    expect(recipe.name).toBe('Chicken & rice')
    expect(recipe.servings).toBe(5)
    expect(recipe.yieldGrams).toBe(250)
    expect(recipe.totalKcal).toBe(500)
    expect(recipe.ingredients).toHaveLength(2)

    // Snapshot independence: deleting the source meal leaves the recipe.
    expect((await req(bearer, 'DELETE', `/api/v1/ui/meal-prep/${meal.id}`)).status).toBe(200)
    const still = await req(bearer, 'GET', `/api/v1/ui/recipes/${recipe.id}`)
    expect(still.status).toBe(200)
    const recheck = (await still.json()) as RecipeDto
    expect(recheck.ingredients).toHaveLength(2)
    expect(recheck.totalKcal).toBe(500)
  })

  it('save-as-recipe rejects an empty meal (409)', async () => {
    const bearer = await loginAs('user_rcp_empty')
    const created = (await (await req(bearer, 'POST', '/api/v1/ui/meal-prep', {})).json()) as PreparedMealDto
    const res = await req(bearer, 'POST', `/api/v1/ui/meal-prep/${created.id}/save-as-recipe`, {
      name: 'Nothing',
    })
    expect(res.status).toBe(409)
  })

  it('cook-from-recipe clones the ingredient lines into a new cooking batch', async () => {
    const bearer = await loginAs('user_rcp_cook')
    const meal = await cookAB(bearer)
    const recipe = (await (
      await req(bearer, 'POST', `/api/v1/ui/meal-prep/${meal.id}/save-as-recipe`, {
        name: 'Repeatable',
        servings: 4,
      })
    ).json()) as RecipeDto

    const cooked = (await (
      await req(bearer, 'POST', '/api/v1/ui/meal-prep', { fromRecipeId: recipe.id })
    ).json()) as PreparedMealDto
    expect(cooked.status).toBe('cooking')
    expect(cooked.name).toBe('Repeatable')
    expect(cooked.recipeId).toBe(recipe.id)
    expect(cooked.totalGrams).toBe(250)
    expect(cooked.totalKcal).toBe(500)
    const detail = (await (await req(bearer, 'GET', `/api/v1/ui/meal-prep/${cooked.id}`)).json()) as PreparedMealDto
    expect(detail.ingredients).toHaveLength(2)

    // The clone is adjustable before finishing.
    const added = await req(bearer, 'POST', `/api/v1/ui/meal-prep/${cooked.id}/ingredients`, ING_A)
    expect(added.status).toBe(201)
    expect(((await added.json()) as PreparedMealDto).totalGrams).toBe(350)
  })

  it('lists, patches, and deletes recipes with ownership isolation', async () => {
    const owner = await loginAs('user_rcp_owner')
    const other = await loginAs('user_rcp_other')
    const meal = await cookAB(owner)
    const recipe = (await (
      await req(owner, 'POST', `/api/v1/ui/meal-prep/${meal.id}/save-as-recipe`, { name: 'Mine' })
    ).json()) as RecipeDto

    const list = (await (await req(owner, 'GET', '/api/v1/ui/recipes')).json()) as { recipes: RecipeDto[] }
    expect(list.recipes.some((r) => r.id === recipe.id)).toBe(true)

    // rename + set servings
    const patched = await req(owner, 'PATCH', `/api/v1/ui/recipes/${recipe.id}`, {
      name: 'Renamed',
      servings: 3,
    })
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as RecipeDto).name).toBe('Renamed')

    // other user is isolated
    expect((await req(other, 'GET', `/api/v1/ui/recipes/${recipe.id}`)).status).toBe(404)
    expect((await req(other, 'PATCH', `/api/v1/ui/recipes/${recipe.id}`, { name: 'Hijack' })).status).toBe(404)
    expect((await req(other, 'DELETE', `/api/v1/ui/recipes/${recipe.id}`)).status).toBe(404)
    const otherList = (await (await req(other, 'GET', '/api/v1/ui/recipes')).json()) as { recipes: RecipeDto[] }
    expect(otherList.recipes.some((r) => r.id === recipe.id)).toBe(false)

    // owner deletes
    expect((await req(owner, 'DELETE', `/api/v1/ui/recipes/${recipe.id}`)).status).toBe(200)
    expect((await req(owner, 'GET', `/api/v1/ui/recipes/${recipe.id}`)).status).toBe(404)
  })
})
