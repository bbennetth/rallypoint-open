import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { TENANT_DEFAULT } from '@rallypoint/shared'
import { normalizeFoodSearchQuery } from '@rallypoint/fitness-shared'
import type { FoodItemDto, FoodLogEntryDto, NormalizedOffProduct } from '@rallypoint/fitness-shared'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb, type Db } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { FoodLookupHit, Services } from '../services/types.js'
import { encryptBearer } from '../crypto/encryption.js'
import { FITNESS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 integration tests for the food logger (issue #700): barcode lookup
// (cache-miss → stubbed OFF → cache-hit), AI photo scan (stubbed
// foodVision), and the diary CRUD. Real D1 via vitest-pool-workers;
// only the two external services are stubbed.

const CSRF = 'csrf_token_value_food_aaaaaaaaaaaaaaaaaa'

const OFF_PRODUCT: NormalizedOffProduct = {
  upc: '737628064502',
  name: 'Rice Noodles',
  brand: 'Thai Kitchen',
  servingGrams: 45,
  servingQuantity: 45,
  servingUnit: 'g',
  isLiquid: false,
  per100g: { kcal: 360, proteinG: 7.1, carbsG: 80, fatG: 1.2 },
}

// An ml-basis liquid (milk-like) — exercises the volume-unit metadata.
const OFF_LIQUID: NormalizedOffProduct = {
  upc: '011110491503',
  name: 'Fat Free Milk',
  brand: 'Fairlife',
  servingGrams: 240,
  servingQuantity: 240,
  servingUnit: 'ml',
  isLiquid: true,
  per100g: { kcal: 33, proteinG: 5.4, carbsG: 2.5, fatG: 0 },
}

const offLookup = vi.fn<(upc: string) => Promise<FoodLookupHit | null>>()
// Wrap a product the way the real client returns it (OFF-sourced hit).
const offHit = (product: NormalizedOffProduct): FoodLookupHit => ({ product, source: 'off' })
const offSearch = vi.fn<(terms: string) => Promise<NormalizedOffProduct[]>>()
const analyzeFoodImage = vi.fn()
const analyzeFoodText = vi.fn()
const analyzeDrinkImage = vi.fn()
const analyzeNutritionLabel = vi.fn()
const recordFeedback = vi.fn(async () => ({ ok: true }))
const recordTrace = vi.fn(async () => {})

const services: Services = {
  idClient: {
    verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
    signoutRpidBearer: async () => {},
  },
  rpidSso: { exchange: async () => ({ ok: false as const, reason: 'invalid' as const }) },
  profiles: { lookup: async () => null },
  settings: { get: async () => ({}), patch: async (_u, _n, p) => p },
  offClient: { lookup: offLookup, search: offSearch },
  foodVision: { analyzeFoodImage, analyzeFoodText, analyzeDrinkImage, analyzeNutritionLabel },
  aiTraces: { recordTrace, recordFeedback },
}

// A 1x1 transparent PNG.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('D1 integration — food logger surface', () => {
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

  it('rejects every food route without a session (401)', async () => {
    for (const [method, path] of [
      ['POST', '/api/v1/ui/food/barcode'],
      ['GET', '/api/v1/ui/food/search'],
      ['POST', '/api/v1/ui/food/scan'],
      ['POST', '/api/v1/ui/food/text'],
      ['POST', '/api/v1/ui/food/label'],
      ['POST', '/api/v1/ui/food/log'],
      ['GET', '/api/v1/ui/food/log'],
      ['GET', '/api/v1/ui/food/summary'],
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

  // --- barcode --------------------------------------------------------

  it('barcode miss → OFF lookup → caches; second scan hits the cache', async () => {
    const bearer = await loginAs('user_food_barcode')
    offLookup.mockResolvedValueOnce(offHit(OFF_PRODUCT))

    const first = await req(bearer, 'POST', '/api/v1/ui/food/barcode', {
      upc: OFF_PRODUCT.upc,
    })
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as { item: FoodItemDto; cached: boolean }
    expect(firstBody.cached).toBe(false)
    expect(firstBody.item.id).toMatch(/^ff_/)
    expect(firstBody.item.name).toBe('Rice Noodles')
    expect(firstBody.item.source).toBe('off')
    expect(firstBody.item.per100g).toEqual(OFF_PRODUCT.per100g)
    expect(offLookup).toHaveBeenCalledTimes(1)

    // Second scan (any user) is served from our D1 cache — no OFF call.
    const second = await req(bearer, 'POST', '/api/v1/ui/food/barcode', {
      upc: OFF_PRODUCT.upc,
    })
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as { item: FoodItemDto; cached: boolean }
    expect(secondBody.cached).toBe(true)
    expect(secondBody.item.id).toBe(firstBody.item.id)
    expect(offLookup).toHaveBeenCalledTimes(1)
  })

  it('barcode persists serving metadata and GET /food/items/:id returns it', async () => {
    const bearer = await loginAs('user_food_liquid')
    offLookup.mockResolvedValueOnce(offHit(OFF_LIQUID))

    const scanned = await req(bearer, 'POST', '/api/v1/ui/food/barcode', {
      upc: OFF_LIQUID.upc,
    })
    expect(scanned.status).toBe(200)
    const { item } = (await scanned.json()) as { item: FoodItemDto }
    expect(item.servingQuantity).toBe(240)
    expect(item.servingUnit).toBe('ml')
    expect(item.isLiquid).toBe(true)
    expect(item.servingGrams).toBe(240)

    // The edit flow re-reads the item by id to rebuild unit options.
    const got = await req(bearer, 'GET', `/api/v1/ui/food/items/${item.id}`)
    expect(got.status).toBe(200)
    expect(((await got.json()) as { item: FoodItemDto }).item).toEqual(item)

    const missing = await req(bearer, 'GET', '/api/v1/ui/food/items/ff_nope')
    expect(missing.status).toBe(404)
  })

  it('pre-migration cache rows read null serving metadata and emit isLiquid: false', async () => {
    // Simulate a legacy row: insert without the new columns.
    await db.run(
      sql`INSERT INTO food_items (id, upc, source, name, kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g)
          VALUES ('ff_legacy_row', '444444444444', 'off', 'Legacy Bar', 400, 20, 40, 15)`,
    )
    const bearer = await loginAs('user_food_legacy')
    const got = await req(bearer, 'GET', '/api/v1/ui/food/items/ff_legacy_row')
    expect(got.status).toBe(200)
    const { item } = (await got.json()) as { item: FoodItemDto }
    expect(item.servingQuantity).toBeNull()
    expect(item.servingUnit).toBeNull()
    expect(item.isLiquid).toBe(false)
  })

  it('barcode unknown to OFF → { item: null }', async () => {
    const bearer = await loginAs('user_food_barcode_miss')
    offLookup.mockResolvedValueOnce(null)
    const res = await req(bearer, 'POST', '/api/v1/ui/food/barcode', { upc: '00000000' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ item: null, cached: false })
  })

  it('barcode heals a serving-less search write-through row from OFF', async () => {
    const bearer = await loginAs('user_food_heal')
    // A search write-through (Search-a-licious carries no serving fields).
    const servingless: NormalizedOffProduct = {
      upc: '901111111119',
      name: 'Quest Bar',
      brand: 'Quest',
      servingGrams: null,
      servingQuantity: null,
      servingUnit: null,
      isLiquid: false,
      per100g: { kcal: 350, proteinG: 35, carbsG: 25, fatG: 14 },
    }
    offSearch.mockReset()
    offSearch.mockResolvedValueOnce([servingless])
    await req(bearer, 'GET', '/api/v1/ui/food/search?q=zzquesthealbar')

    // Picking it goes through the barcode route, which re-reads the full
    // OFF product (serving fields present) and refreshes the row in place.
    offLookup.mockResolvedValueOnce(offHit({ ...servingless, servingGrams: 60, servingQuantity: 60, servingUnit: 'g' }))
    const res = await req(bearer, 'POST', '/api/v1/ui/food/barcode', { upc: servingless.upc })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { item: FoodItemDto; cached: boolean }
    expect(body.cached).toBe(true)
    expect(body.item.servingGrams).toBe(60)
    expect(body.item.source).toBe('off')

    // The heal persisted — the next scan serves the cache without OFF.
    const callsAfter = offLookup.mock.calls.length
    const again = await req(bearer, 'POST', '/api/v1/ui/food/barcode', { upc: servingless.upc })
    expect(((await again.json()) as { item: FoodItemDto }).item.servingGrams).toBe(60)
    expect(offLookup.mock.calls.length).toBe(callsAfter)
  })

  it('barcode serves the cached row as-is when the serving refresh fails or misses', async () => {
    const bearer = await loginAs('user_food_heal_err')
    const servingless: NormalizedOffProduct = {
      upc: '902222222226',
      name: 'Mystery Snack',
      brand: null,
      servingGrams: null,
      servingQuantity: null,
      servingUnit: null,
      isLiquid: false,
      per100g: { kcal: 500, proteinG: 5, carbsG: 60, fatG: 25 },
    }
    offSearch.mockReset()
    offSearch.mockResolvedValueOnce([servingless])
    await req(bearer, 'GET', '/api/v1/ui/food/search?q=zzmysteryheal')

    // OFF down → cached row, not a 502.
    offLookup.mockRejectedValueOnce(new Error('off down'))
    const res = await req(bearer, 'POST', '/api/v1/ui/food/barcode', { upc: servingless.upc })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { item: FoodItemDto; cached: boolean }
    expect(body.cached).toBe(true)
    expect(body.item.servingGrams).toBeNull()
    expect(body.item.name).toBe('Mystery Snack')
  })

  it('barcode memoizes "OFF has no serving data" and stops re-fetching', async () => {
    const bearer = await loginAs('user_food_heal_memo')
    const servingless: NormalizedOffProduct = {
      upc: '904444444442',
      name: 'Bulk Oats',
      brand: null,
      servingGrams: null,
      servingQuantity: null,
      servingUnit: null,
      isLiquid: false,
      per100g: { kcal: 380, proteinG: 13, carbsG: 68, fatG: 7 },
    }
    offSearch.mockReset()
    offSearch.mockResolvedValueOnce([servingless])
    await req(bearer, 'GET', '/api/v1/ui/food/search?q=zzbulkoatsheal')

    // First scan: OFF re-read still has no serving → memoized.
    offLookup.mockResolvedValueOnce(offHit(servingless))
    const first = await req(bearer, 'POST', '/api/v1/ui/food/barcode', { upc: servingless.upc })
    expect(first.status).toBe(200)
    const calls = offLookup.mock.calls.length

    // Second scan inside the memo TTL: served from cache, no OFF fetch.
    const second = await req(bearer, 'POST', '/api/v1/ui/food/barcode', { upc: servingless.upc })
    expect(second.status).toBe(200)
    const body = (await second.json()) as { item: FoodItemDto; cached: boolean }
    expect(body.item.servingGrams).toBeNull()
    expect(offLookup.mock.calls.length).toBe(calls)
  })

  it('barcode never refreshes a user-corrected row', async () => {
    const bearer = await loginAs('user_food_heal_user')
    // Seed a global row, then apply a correction (source flips to 'user',
    // serving still null).
    await repos.foodItems.upsertByUpc({
      id: 'ff_heal_user',
      upc: '903333333333',
      source: 'off',
      name: 'Before Fix',
      brand: null,
      servingGrams: null,
      servingQuantity: null,
      servingUnit: null,
      isLiquid: false,
      per100g: { kcal: 100, proteinG: 1, carbsG: 2, fatG: 3 },
      createdBy: 'user_food_heal_user',
    })
    await repos.foodItems.overrideByUpc('903333333333', {
      name: 'Corrected Snack',
      brand: null,
      servingGrams: null,
      servingQuantity: null,
      servingUnit: null,
      isLiquid: null,
      per100g: { kcal: 120, proteinG: 2, carbsG: 3, fatG: 4 },
      raw: null,
    })

    const callsBefore = offLookup.mock.calls.length
    const res = await req(bearer, 'POST', '/api/v1/ui/food/barcode', { upc: '903333333333' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { item: FoodItemDto; cached: boolean }
    expect(body.item.name).toBe('Corrected Snack')
    expect(body.item.source).toBe('user')
    // No OFF fetch for a corrected row.
    expect(offLookup.mock.calls.length).toBe(callsBefore)
  })

  it('barcode OFF transport error → enveloped 503; malformed upc → 400', async () => {
    const bearer = await loginAs('user_food_barcode_err')
    offLookup.mockRejectedValueOnce(new Error('boom'))
    const res = await req(bearer, 'POST', '/api/v1/ui/food/barcode', { upc: '11111111' })
    expect(res.status).toBe(503)
    // Enveloped (code + message) so the web client's parseError can show
    // the real message instead of "Request failed (503)."
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('upstream_unavailable')
    expect(body.error.message).toBe('Barcode lookup is unavailable right now.')

    const bad = await req(bearer, 'POST', '/api/v1/ui/food/barcode', { upc: 'abc' })
    expect(bad.status).toBe(400)
  })

  it('barcode resolved via the FDC fallback caches with source fdc', async () => {
    const bearer = await loginAs('user_food_barcode_fdc')
    offLookup.mockResolvedValueOnce({
      product: { ...OFF_PRODUCT, upc: '905555555550' },
      source: 'fdc',
    })
    const res = await req(bearer, 'POST', '/api/v1/ui/food/barcode', { upc: '905555555550' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { item: FoodItemDto; cached: boolean }
    expect(body.item.source).toBe('fdc')
    expect(body.cached).toBe(false)
  })

  // --- name search ----------------------------------------------------

  const SEARCH_HITS: NormalizedOffProduct[] = [
    {
      upc: '900000000001',
      name: 'Granola Bar',
      brand: 'Nature',
      servingGrams: 40,
      servingQuantity: 40,
      servingUnit: 'g',
      isLiquid: false,
      per100g: { kcal: 450, proteinG: 8, carbsG: 60, fatG: 18 },
    },
    {
      upc: '900000000002',
      name: 'Granola Clusters',
      brand: 'Oaty',
      servingGrams: 55,
      servingQuantity: 55,
      servingUnit: 'g',
      isLiquid: false,
      per100g: { kcal: 430, proteinG: 9, carbsG: 62, fatG: 15 },
    },
  ]

  it('search misses locally → OFF → write-through cache; repeat is served locally', async () => {
    const bearer = await loginAs('user_food_search')
    offSearch.mockReset()
    offSearch.mockResolvedValueOnce(SEARCH_HITS)

    const first = await req(bearer, 'GET', '/api/v1/ui/food/search?q=granola')
    expect(first.status).toBe(200)
    const b1 = (await first.json()) as { items: FoodItemDto[]; external: boolean }
    expect(b1.external).toBe(true)
    expect(b1.items).toHaveLength(2)
    expect(b1.items.map((i) => i.name)).toContain('Granola Bar')
    expect(b1.items.every((i) => i.id.startsWith('ff_'))).toBe(true)
    expect(offSearch).toHaveBeenCalledTimes(1)

    // Same query inside the memo TTL → local-only, no second OFF call.
    const second = await req(bearer, 'GET', '/api/v1/ui/food/search?q=granola')
    expect(second.status).toBe(200)
    const b2 = (await second.json()) as { items: FoodItemDto[]; external: boolean }
    expect(b2.external).toBe(false)
    expect(b2.items.length).toBeGreaterThanOrEqual(2)
    expect(offSearch).toHaveBeenCalledTimes(1)
  })

  it('search degrades to local-only when OFF errors', async () => {
    const bearer = await loginAs('user_food_search_err')
    offSearch.mockReset()
    offSearch.mockRejectedValueOnce(new Error('off down'))

    const res = await req(bearer, 'GET', '/api/v1/ui/food/search?q=quinoa')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: FoodItemDto[]; external: boolean }
    expect(body.external).toBe(false)
    expect(Array.isArray(body.items)).toBe(true)
  })

  it('search matches words across name and brand (tokenized AND)', async () => {
    const bearer = await loginAs('user_food_search_tok')
    offSearch.mockReset()
    offSearch.mockResolvedValueOnce(SEARCH_HITS)
    // Seed the cache (Granola Clusters / brand Oaty; Granola Bar / Nature).
    await req(bearer, 'GET', '/api/v1/ui/food/search?q=granola')
    offSearch.mockReset()
    offSearch.mockResolvedValue([])

    // "oaty clusters": neither name nor brand alone contains the phrase —
    // each word matches a different column.
    const res = await req(bearer, 'GET', '/api/v1/ui/food/search?q=oaty%20clusters')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: FoodItemDto[]; external: boolean }
    expect(body.items.map((i) => i.name)).toContain('Granola Clusters')
    expect(body.items.map((i) => i.name)).not.toContain('Granola Bar')
  })

  it('search matches across straight/curly apostrophes (iOS smart punctuation)', async () => {
    const bearer = await loginAs('user_food_search_apos')
    offSearch.mockReset()
    offSearch.mockResolvedValue([])

    // Label-scan saves store a straight apostrophe; the ABC Bars row from
    // the screenshots is name="ABC Bars (Trader Joe's)".
    await repos.foodItems.upsertByUpc({
      id: 'ff_abc_bars_straight',
      upc: '900000000901',
      source: 'off',
      name: "ABC Bars (Trader Joe's)",
      per100g: { kcal: 457, proteinG: 8.6, carbsG: 57, fatG: 20 },
    })
    // An OFF row that stores a curly apostrophe in the brand.
    await repos.foodItems.upsertByUpc({
      id: 'ff_reese_curly',
      upc: '900000000902',
      source: 'off',
      name: 'Peanut Butter Cups',
      brand: 'Reese’s',
      per100g: { kcal: 515, proteinG: 9, carbsG: 55, fatG: 30 },
    })

    // Fresh non-empty memos so the route serves local-only — this test
    // exercises the DB apostrophe matching, not the OFF/rate-limit path
    // (and so it doesn't drain the shared off:search bucket).
    const curlyQuery = 'Trader Joe’s abc bar'
    const straightQuery = "reese's cups"
    await repos.foodSearchQueries.record(normalizeFoodSearchQuery(curlyQuery).toLowerCase(), 1, new Date())
    await repos.foodSearchQueries.record(normalizeFoodSearchQuery(straightQuery).toLowerCase(), 1, new Date())

    // Curly-apostrophe query (what iOS types) finds the straight-stored row.
    const curly = await req(bearer, 'GET', `/api/v1/ui/food/search?q=${encodeURIComponent(curlyQuery)}`)
    expect(curly.status).toBe(200)
    const curlyItems = ((await curly.json()) as { items: FoodItemDto[] }).items
    expect(curlyItems.map((i) => i.name)).toContain("ABC Bars (Trader Joe's)")

    // Straight-apostrophe query finds the curly-stored brand row.
    const straight = await req(bearer, 'GET', `/api/v1/ui/food/search?q=${encodeURIComponent(straightQuery)}`)
    expect(straight.status).toBe(200)
    const straightItems = ((await straight.json()) as { items: FoodItemDto[] }).items
    expect(straightItems.map((i) => i.name)).toContain('Peanut Butter Cups')
    expect(offSearch).not.toHaveBeenCalled()
  })

  it('an empty OFF memo expires quickly; a non-empty memo suppresses the re-fetch', async () => {
    const bearer = await loginAs('user_food_search_memo')
    offSearch.mockReset()
    offSearch.mockResolvedValue([])

    // Zero-result memo from 20 minutes ago (past the short empty TTL) →
    // the same query fetches from OFF again.
    await repos.foodSearchQueries.record('zzmemoempty', 0, new Date(Date.now() - 20 * 60 * 1000))
    await req(bearer, 'GET', '/api/v1/ui/food/search?q=zzmemoempty')
    expect(offSearch).toHaveBeenCalledTimes(1)

    // Non-empty memo of the same age (inside the 24 h TTL) → no re-fetch.
    offSearch.mockClear()
    await repos.foodSearchQueries.record('zzmemofull', 2, new Date(Date.now() - 20 * 60 * 1000))
    await req(bearer, 'GET', '/api/v1/ui/food/search?q=zzmemofull')
    expect(offSearch).not.toHaveBeenCalled()
  })

  it('search degrades to local-only when the OFF budget is spent', async () => {
    const bearer = await loginAs('user_food_search_rl')
    offSearch.mockReset()
    offSearch.mockResolvedValue(SEARCH_HITS)
    // Drain the global off:search bucket (limit 8/min).
    for (let i = 0; i < 8; i++) {
      await repos.rateLimit.takeToken({
        tenantId: TENANT_DEFAULT,
        bucketKey: 'off:search',
        limit: 8,
        windowSeconds: 60,
      })
    }
    const res = await req(bearer, 'GET', '/api/v1/ui/food/search?q=zznovelquery')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: FoodItemDto[]; external: boolean }
    expect(body.external).toBe(false)
    expect(offSearch).not.toHaveBeenCalled()
  })

  // The off:search bucket writes to D1 on every miss, so a storage blip must
  // degrade like a spent budget rather than 500 the search box — we can't
  // account for the spend, so we don't spend it against a third party.
  it('search degrades to local-only when the rate-limit store blips transiently', async () => {
    const bearer = await loginAs('user_food_search_store_blip')
    offSearch.mockReset()
    offSearch.mockResolvedValue(SEARCH_HITS)
    const realTakeToken = repos.rateLimit.takeToken.bind(repos.rateLimit)
    // The production shape: drizzle's wrapper around a D1 storage reset.
    repos.rateLimit.takeToken = async () => {
      throw new Error('Failed query: insert into "rate_limits" …', {
        cause: new Error(
          'D1 DB storage operation exceeded timeout which caused object to be reset.',
        ),
      })
    }
    try {
      const res = await req(bearer, 'GET', '/api/v1/ui/food/search?q=zzblipquery')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { items: FoodItemDto[]; external: boolean }
      expect(body.external).toBe(false)
      expect(offSearch).not.toHaveBeenCalled()
    } finally {
      repos.rateLimit.takeToken = realTakeToken
    }
  })

  it('search still fails loudly when the rate-limit store raises a real bug', async () => {
    const bearer = await loginAs('user_food_search_store_bug')
    offSearch.mockReset()
    const realTakeToken = repos.rateLimit.takeToken.bind(repos.rateLimit)
    // Deterministic (a SQL bug) — must NOT be silently swallowed as "budget
    // spent", or a broken limiter reads as normal degradation forever.
    repos.rateLimit.takeToken = async () => {
      throw new Error('Failed query: too many SQL variables')
    }
    try {
      const res = await req(bearer, 'GET', '/api/v1/ui/food/search?q=zzbugquery')
      expect(res.status).toBe(500)
    } finally {
      repos.rateLimit.takeToken = realTakeToken
    }
  })

  it('search ignores a too-short query without touching OFF', async () => {
    const bearer = await loginAs('user_food_search_short')
    offSearch.mockReset()
    const res = await req(bearer, 'GET', '/api/v1/ui/food/search?q=a')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [], external: false })
    expect(offSearch).not.toHaveBeenCalled()
  })

  // --- scan -----------------------------------------------------------

  it('photo scan returns items + clarifying questions from the vision service', async () => {
    const bearer = await loginAs('user_food_scan')
    const scan = {
      mealName: 'Lean ground beef plate',
      estimatedServings: 1,
      items: [
        {
          name: 'Lean ground beef',
          estimatedGrams: 300,
          kcal: 750,
          proteinG: 78,
          carbsG: 0,
          fatG: 45,
        },
      ],
      questions: ['Is the rice white or brown?'],
    }
    analyzeFoodImage.mockResolvedValueOnce(scan)

    const res = await req(bearer, 'POST', '/api/v1/ui/food/scan', {
      imageBase64: TINY_PNG_B64,
      mimeType: 'image/png',
      context: 'total weight 300g, lean ground beef',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ scan, portionBias: 1.0, responseId: null })
    expect(analyzeFoodImage).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'image/png',
      'total weight 300g, lean ground beef',
      undefined,
      expect.objectContaining({ userId: expect.any(String), contentOptOut: expect.any(Boolean) }),
    )
  })

  it('passes a separately validated supporting image to the food vision service', async () => {
    const bearer = await loginAs('user_food_scan_support')
    const scan = {
      mealName: 'Menu pasta',
      estimatedServings: 1.5,
      items: [
        { name: 'Pasta', estimatedGrams: 450, kcal: 700, proteinG: 24, carbsG: 110, fatG: 18 },
      ],
      questions: [],
    }
    analyzeFoodImage.mockResolvedValueOnce(scan)
    const res = await req(bearer, 'POST', '/api/v1/ui/food/scan', {
      imageBase64: TINY_PNG_B64,
      mimeType: 'image/png',
      supportingImage: { imageBase64: TINY_PNG_B64, mimeType: 'image/jpeg' },
    })
    expect(res.status).toBe(200)
    expect(analyzeFoodImage).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'image/png',
      undefined,
      { image: expect.any(Uint8Array), mimeType: 'image/jpeg' },
      expect.objectContaining({ userId: expect.any(String) }),
    )
  })

  it('scan?mode=drink runs the drink pass and returns the spirit/mixer guess', async () => {
    const bearer = await loginAs('user_drink_scan')
    const drink = { spirit: 'vodka', mixer: 'cola', confidence: 'high' as const }
    analyzeDrinkImage.mockResolvedValueOnce(drink)
    // The food pass must NOT run for a drink request (mock accumulates
    // across tests, so compare the delta).
    const foodCallsBefore = analyzeFoodImage.mock.calls.length

    const res = await req(bearer, 'POST', '/api/v1/ui/food/scan?mode=drink', {
      imageBase64: TINY_PNG_B64,
      mimeType: 'image/png',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ drink, responseId: null })
    expect(analyzeDrinkImage).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'image/png',
      undefined,
      expect.objectContaining({ userId: expect.any(String) }),
    )
    expect(analyzeFoodImage.mock.calls.length).toBe(foodCallsBefore)
  })

  it('text scan estimates a meal and returns the scan + responseId', async () => {
    const bearer = await loginAs('user_food_text')
    const scan = {
      mealName: '5 cherries',
      estimatedServings: 1,
      items: [
        { name: 'Cherries', count: 5, unit: 'cherry', estimatedGrams: 40, kcal: 25, proteinG: 0.4, carbsG: 6, fatG: 0.1 },
      ],
      questions: [],
    }
    analyzeFoodText.mockResolvedValueOnce(scan)
    const res = await req(bearer, 'POST', '/api/v1/ui/food/text', {
      text: 'I ate 5 cherries',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ scan, responseId: null })
    expect(analyzeFoodText).toHaveBeenCalledWith(
      'I ate 5 cherries',
      undefined,
      expect.objectContaining({ userId: expect.any(String), contentOptOut: expect.any(Boolean) }),
    )
  })

  it('text scan 400s on an empty/oversized description', async () => {
    const bearer = await loginAs('user_food_text_bad')
    const before = analyzeFoodText.mock.calls.length
    expect((await req(bearer, 'POST', '/api/v1/ui/food/text', { text: '' })).status).toBe(400)
    expect((await req(bearer, 'POST', '/api/v1/ui/food/text', { text: 'x'.repeat(501) })).status).toBe(400)
    // The model must not run on invalid input.
    expect(analyzeFoodText.mock.calls.length).toBe(before)
  })

  it('text scan maps a vision failure to an enveloped 502', async () => {
    const bearer = await loginAs('user_food_text_err')
    analyzeFoodText.mockRejectedValueOnce(new Error('no json'))
    const res = await req(bearer, 'POST', '/api/v1/ui/food/text', { text: 'asdf' })
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('scan_failed')
  })

  it('a text-described entry logs with source text', async () => {
    const bearer = await loginAs('user_text_log')
    const res = await req(bearer, 'POST', '/api/v1/ui/food/log', {
      loggedAt: new Date().toISOString(),
      name: 'Cherries',
      quantityGrams: 40,
      kcal: 25,
      proteinG: 0.4,
      carbsG: 6,
      fatG: 0.1,
      source: 'text',
      scanResponseId: 'resp_text_1',
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as FoodLogEntryDto
    expect(body.source).toBe('text')
    expect(body.kcal).toBe(25)
  })

  it('rejects estimatedGrams on a text entry (photo-only field)', async () => {
    const bearer = await loginAs('user_text_estgrams')
    const res = await req(bearer, 'POST', '/api/v1/ui/food/log', {
      loggedAt: new Date().toISOString(),
      name: 'Cherries',
      quantityGrams: 40,
      kcal: 25,
      proteinG: 0.4,
      carbsG: 6,
      fatG: 0.1,
      source: 'text',
      estimatedGrams: 40,
    })
    expect(res.status).toBe(400)
  })

  it('a mixed-drink entry logs with source drink', async () => {
    const bearer = await loginAs('user_drink_log')
    const res = await req(bearer, 'POST', '/api/v1/ui/food/log', {
      loggedAt: new Date().toISOString(),
      name: 'Vodka + Cola',
      kcal: 292,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      source: 'drink',
      note: 'Gay pour · 3 shots Vodka · 27.8 g alcohol',
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as FoodLogEntryDto
    expect(body.source).toBe('drink')
    expect(body.kcal).toBe(292)
  })

  it('photo scan maps a non-capacity vision failure to an enveloped 502', async () => {
    const bearer = await loginAs('user_food_scan_err')
    analyzeFoodImage.mockRejectedValueOnce(new Error('no json'))
    const res = await req(bearer, 'POST', '/api/v1/ui/food/scan', {
      imageBase64: TINY_PNG_B64,
      mimeType: 'image/png',
    })
    expect(res.status).toBe(502)
    // Enveloped {error:{code,message}} — not a bare {error: string} — so
    // the browser client's parseError surfaces a real code + message.
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('scan_failed')
    expect(body.error.message).toContain('Could not read the food')

    const empty = await req(bearer, 'POST', '/api/v1/ui/food/scan', {
      imageBase64: '',
      mimeType: 'image/png',
    })
    expect(empty.status).toBe(400)
  })

  it('photo scan maps a Workers AI capacity error to a retryable 503 ai_capacity', async () => {
    const bearer = await loginAs('user_food_scan_cap')
    analyzeFoodImage.mockRejectedValueOnce(
      Object.assign(new Error('3040: Capacity temporarily exceeded, please try again'), {
        name: 'AiError',
      }),
    )
    const res = await req(bearer, 'POST', '/api/v1/ui/food/scan', {
      imageBase64: TINY_PNG_B64,
      mimeType: 'image/png',
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as {
      error: { code: string; details?: { retry_after_seconds?: number } }
    }
    expect(body.error.code).toBe('ai_capacity')
    expect(body.error.details?.retry_after_seconds).toBeGreaterThan(0)
  })

  it('photo scan rejects an oversized image with the specific image_too_large error', async () => {
    const bearer = await loginAs('user_food_scan_big')
    // One char past the base64 ceiling for the 4 MiB binary cap.
    const overCap = Math.ceil((4 * 1024 * 1024 * 4) / 3) + 5
    const callsBefore = analyzeFoodImage.mock.calls.length
    const res = await req(bearer, 'POST', '/api/v1/ui/food/scan', {
      imageBase64: 'A'.repeat(overCap),
      mimeType: 'image/jpeg',
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('image_too_large')
    expect(body.error.message).toContain('too large')
    expect(analyzeFoodImage.mock.calls.length).toBe(callsBefore)
  })

  it('applies the 4 MiB limit independently to the supporting image', async () => {
    const bearer = await loginAs('user_food_scan_support_big')
    const overCap = Math.ceil((4 * 1024 * 1024 * 4) / 3) + 5
    const res = await req(bearer, 'POST', '/api/v1/ui/food/scan', {
      imageBase64: TINY_PNG_B64,
      mimeType: 'image/png',
      supportingImage: { imageBase64: 'A'.repeat(overCap), mimeType: 'image/jpeg' },
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('image_too_large')
  })

  // --- nutrition-label fallback (unknown UPC → AI read → shared cache) --

  // A clean read: 50 g serving keeps the per-100g math integer end-to-end.
  const LABEL_READ = {
    name: 'Store Granola',
    brand: 'Store',
    servingGrams: 50,
    servingUnit: 'g' as const,
    perServing: { kcal: 200, proteinG: 20, carbsG: 20, fatG: 10 },
  }
  const LABEL_UPC = '012345678905'

  it('label scan returns an unsaved AI candidate; nothing is persisted yet', async () => {
    const bearer = await loginAs('user_label_scan')
    analyzeNutritionLabel.mockResolvedValueOnce(LABEL_READ)

    const res = await req(bearer, 'POST', '/api/v1/ui/food/label', {
      upc: LABEL_UPC,
      imageBase64: TINY_PNG_B64,
      mimeType: 'image/png',
    })
    expect(res.status).toBe(200)
    const { item } = (await res.json()) as { item: FoodItemDto }
    expect(item.source).toBe('ai')
    expect(item.upc).toBe(LABEL_UPC)
    expect(item.name).toBe('Store Granola')
    expect(item.brand).toBe('Store')
    expect(item.servingGrams).toBe(50)
    expect(item.per100g).toEqual({ kcal: 400, proteinG: 40, carbsG: 40, fatG: 20 })
    // Scan-never-writes: the shared cache still has no row for this upc.
    expect(await repos.foodItems.getByUpc(LABEL_UPC)).toBeNull()
  })

  it('passes the optional product photo to the vision service', async () => {
    const bearer = await loginAs('user_label_product')
    analyzeNutritionLabel.mockResolvedValueOnce(LABEL_READ)
    await req(bearer, 'POST', '/api/v1/ui/food/label', {
      upc: '012345678929',
      imageBase64: TINY_PNG_B64,
      mimeType: 'image/png',
      productImage: { imageBase64: TINY_PNG_B64, mimeType: 'image/jpeg' },
      context: 'front of the box',
    })
    expect(analyzeNutritionLabel).toHaveBeenLastCalledWith(
      expect.any(Uint8Array),
      'image/png',
      { image: expect.any(Uint8Array), mimeType: 'image/jpeg' },
      'front of the box',
      expect.objectContaining({ userId: expect.any(String) }),
    )
  })

  it('saveAsUpc logs against a private row and files a review-queue submission (no global row yet)', async () => {
    const owner = await loginAs('user_label_owner')
    analyzeNutritionLabel.mockResolvedValueOnce(LABEL_READ)
    const scan = await req(owner, 'POST', '/api/v1/ui/food/label', {
      upc: LABEL_UPC,
      imageBase64: TINY_PNG_B64,
      mimeType: 'image/png',
    })
    const { item: candidate, contributionToken } = (await scan.json()) as {
      item: FoodItemDto
      contributionToken: string
    }
    expect(contributionToken).toBeTruthy()

    // Save = log the diary row against a PRIVATE item AND file a pending
    // review-queue submission — no global row is written yet.
    const offCallsBefore = offLookup.mock.calls.length
    const logged = await req(owner, 'POST', '/api/v1/ui/food/log', {
      loggedAt: '2026-07-15T12:00:00.000Z',
      name: candidate.name,
      quantityGrams: 50,
      kcal: 200,
      proteinG: 20,
      carbsG: 20,
      fatG: 10,
      source: 'barcode',
      saveAsUpc: {
        upc: LABEL_UPC,
        token: contributionToken,
        brand: candidate.brand,
        servingGrams: candidate.servingGrams,
        servingUnit: candidate.servingUnit,
        isLiquid: candidate.isLiquid,
      },
    })
    expect(logged.status).toBe(201)
    const loggedDto = (await logged.json()) as FoodLogEntryDto & { contributionStatus?: string }
    expect(loggedDto.source).toBe('barcode')
    expect(loggedDto.contributionStatus).toBe('submitted')
    // The diary row is stitched to the fresh PRIVATE item.
    expect(loggedDto.foodItemId).toMatch(/^ff_/)

    // No global row was created — the shared cache stays empty for this upc.
    expect(await repos.foodItems.getByUpc(LABEL_UPC)).toBeNull()

    // The private item is owner-scoped, upc-less, and holds the reviewed
    // snapshot values.
    const privateItem = await repos.foodItems.getForActor('user_label_owner', loggedDto.foodItemId!)
    expect(privateItem).not.toBeNull()
    expect(privateItem!.upc).toBeNull()
    expect(privateItem!.ownerUserId).toBe('user_label_owner')
    expect(privateItem!.source).toBe('ai')
    expect(privateItem!.per100g).toEqual({ kcal: 400, proteinG: 40, carbsG: 40, fatG: 20 })

    // A pending submission was filed for this upc, snapshotting the
    // reviewed values, pointing at the private row.
    const pending = await repos.foodSubmissions.getPendingByUpc(LABEL_UPC)
    expect(pending).not.toBeNull()
    expect(pending!.userId).toBe('user_label_owner')
    expect(pending!.privateFoodItemId).toBe(loggedDto.foodItemId)
    expect(pending!.per100g).toEqual({ kcal: 400, proteinG: 40, carbsG: 40, fatG: 20 })

    // A SECOND user scanning the same barcode still misses the shared
    // cache (nothing global exists yet) — OFF is still consulted.
    const other = await loginAs('user_label_other')
    const rescan = await req(other, 'POST', '/api/v1/ui/food/barcode', { upc: LABEL_UPC })
    expect(rescan.status).toBe(200)
    const rescanBody = (await rescan.json()) as { item: FoodItemDto | null; cached: boolean }
    expect(rescanBody.cached).toBe(false)
    expect(offLookup.mock.calls.length).toBe(offCallsBefore + 1)
  })

  it('label scan → 422 when the read is unusable, 502 when the vision pass fails', async () => {
    const bearer = await loginAs('user_label_err')
    // Unusable read (no serving size can't be normalized to per-100g).
    analyzeNutritionLabel.mockResolvedValueOnce({ ...LABEL_READ, servingGrams: null })
    const unreadable = await req(bearer, 'POST', '/api/v1/ui/food/label', {
      upc: '012345678943',
      imageBase64: TINY_PNG_B64,
      mimeType: 'image/png',
    })
    expect(unreadable.status).toBe(422)
    expect(((await unreadable.json()) as { error: { code: string } }).error.code).toBe(
      'scan_unreadable',
    )
    expect(await repos.foodItems.getByUpc('012345678943')).toBeNull()

    analyzeNutritionLabel.mockRejectedValueOnce(new Error('no json'))
    const failed = await req(bearer, 'POST', '/api/v1/ui/food/label', {
      upc: '012345678950',
      imageBase64: TINY_PNG_B64,
      mimeType: 'image/png',
    })
    expect(failed.status).toBe(502)
    expect(((await failed.json()) as { error: { code: string } }).error.code).toBe('scan_failed')

    // Empty image is a 400 before the vision pass runs.
    const empty = await req(bearer, 'POST', '/api/v1/ui/food/label', {
      upc: '012345678967',
      imageBase64: '',
      mimeType: 'image/png',
    })
    expect(empty.status).toBe(400)
  })

  it('rejects saveAsUpc outside a positive-gram, unreferenced barcode entry', async () => {
    const bearer = await loginAs('user_label_saveupc_bad')
    const base = {
      loggedAt: '2026-07-15T08:00:00.000Z',
      name: 'Bad contribution',
      quantityGrams: 50,
      kcal: 200,
      proteinG: 20,
      carbsG: 20,
      fatG: 10,
      saveAsUpc: {
        upc: '012345678974',
        token: 'placeholder-token',
        servingGrams: 50,
        servingUnit: 'g' as const,
        isLiquid: false,
      },
    }
    // wrong source (schema refinement, before any token check)
    expect(
      (await req(bearer, 'POST', '/api/v1/ui/food/log', { ...base, source: 'manual' })).status,
    ).toBe(400)
    // missing grams
    expect(
      (
        await req(bearer, 'POST', '/api/v1/ui/food/log', {
          ...base,
          source: 'barcode',
          quantityGrams: undefined,
        })
      ).status,
    ).toBe(400)
    // nothing was written on the rejected requests
    expect(await repos.foodItems.getByUpc('012345678974')).toBeNull()
  })

  it('rejects a token-verified saveAsUpc whose reviewed macros are implausible (422 — no cache poisoning)', async () => {
    const bearer = await loginAs('user_label_implausible')
    analyzeNutritionLabel.mockResolvedValueOnce(LABEL_READ)
    const scan = await req(bearer, 'POST', '/api/v1/ui/food/label', {
      upc: '012345678998',
      imageBase64: TINY_PNG_B64,
      mimeType: 'image/png',
    })
    const { contributionToken } = (await scan.json()) as { contributionToken: string }

    // Valid token, but 20000 kcal in 0.1 g → 20,000,000 kcal/100g. The
    // write-path plausibility gate must reject it even though the token is real.
    const res = await req(bearer, 'POST', '/api/v1/ui/food/log', {
      loggedAt: '2026-07-15T12:00:00.000Z',
      name: 'Impossible Product',
      quantityGrams: 0.1,
      kcal: 20000,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      source: 'barcode',
      saveAsUpc: {
        upc: '012345678998',
        token: contributionToken,
        servingGrams: 0.1,
        servingUnit: 'g' as const,
        isLiquid: false,
      },
    })
    expect(res.status).toBe(422)
    expect(await repos.foodItems.getByUpc('012345678998')).toBeNull()
    // The whole request is rejected before the batched write — no diary row either.
    const list = await req(bearer, 'GET', '/api/v1/ui/food/log')
    expect(((await list.json()) as { entries: unknown[] }).entries).toHaveLength(0)
  })

  it('rejects a saveAsUpc contribution whose token does not verify (403 — anti-forgery)', async () => {
    const bearer = await loginAs('user_label_forger')
    // A well-formed barcode entry with a fabricated token (no prior
    // /food/label read) must NOT be able to write the shared cache.
    const res = await req(bearer, 'POST', '/api/v1/ui/food/log', {
      loggedAt: '2026-07-15T08:00:00.000Z',
      name: 'Forged Product',
      quantityGrams: 50,
      kcal: 999,
      proteinG: 0,
      carbsG: 0,
      fatG: 99,
      source: 'barcode',
      saveAsUpc: {
        upc: '012345678981',
        token: 'not-a-real-token',
        servingGrams: 50,
        servingUnit: 'g' as const,
        isLiquid: false,
      },
    })
    expect(res.status).toBe(403)
    // The forged UPC never made it into the shared cache.
    expect(await repos.foodItems.getByUpc('012345678981')).toBeNull()
    // And the diary row wasn't written either (the whole request is rejected).
    const list = await req(bearer, 'GET', '/api/v1/ui/food/log')
    expect(((await list.json()) as { entries: unknown[] }).entries).toHaveLength(0)
  })

  // --- "Incorrect?" corrections (saveAsUpc + correction: true) ---------

  it('correction replaces a bad OFF row in place; future barcode scans serve it without OFF', async () => {
    const bearer = await loginAs('user_correction')
    // Milk with Open Food Facts' classic entry error: per-SERVING values
    // stored in the per-100g fields (the 110-kcal cup read as 110/100g).
    const BAD_MILK: NormalizedOffProduct = {
      upc: '842379147036',
      name: 'Lactose Free 1% Lowfat Milk',
      brand: 'Amazon',
      servingGrams: 240,
      servingQuantity: 240,
      servingUnit: 'ml',
      isLiquid: true,
      per100g: { kcal: 110, proteinG: 9, carbsG: 13, fatG: 2.5 },
    }
    offLookup.mockResolvedValueOnce(offHit(BAD_MILK))
    const scan = await req(bearer, 'POST', '/api/v1/ui/food/barcode', { upc: BAD_MILK.upc })
    const badItem = ((await scan.json()) as { item: FoodItemDto }).item
    expect(badItem.source).toBe('off')

    // The user re-photographs the Nutrition Facts panel.
    analyzeNutritionLabel.mockResolvedValueOnce({
      name: 'Lactose Free 1% Lowfat Milk',
      brand: 'Amazon',
      servingGrams: 240,
      servingUnit: 'ml' as const,
      perServing: { kcal: 110, proteinG: 9, carbsG: 13, fatG: 2.5 },
    })
    const label = await req(bearer, 'POST', '/api/v1/ui/food/label', {
      upc: BAD_MILK.upc,
      imageBase64: TINY_PNG_B64,
      mimeType: 'image/png',
    })
    expect(label.status).toBe(200)
    const { contributionToken } = (await label.json()) as { contributionToken: string }

    // Reviewed values: 50 g at the label's true density (110 kcal/240 g).
    const offCallsBefore = offLookup.mock.calls.length
    const logged = await req(bearer, 'POST', '/api/v1/ui/food/log', {
      loggedAt: '2026-07-15T12:00:00.000Z',
      name: 'Lactose Free 1% Lowfat Milk',
      quantityGrams: 50,
      kcal: 22.9,
      proteinG: 1.9,
      carbsG: 2.7,
      fatG: 0.5,
      source: 'barcode',
      saveAsUpc: {
        upc: BAD_MILK.upc,
        token: contributionToken,
        brand: 'Amazon',
        servingGrams: 240,
        servingUnit: 'ml' as const,
        isLiquid: true,
        correction: true,
      },
    })
    expect(logged.status).toBe(201)
    const loggedDto = (await logged.json()) as FoodLogEntryDto
    expect(loggedDto.contributionStatus).toBe('corrected')
    // The diary row points at the SAME (now corrected) global row.
    expect(loggedDto.foodItemId).toBe(badItem.id)

    // The global row was replaced in place: stable id, source 'user',
    // per-100g derived from the reviewed values (22.9 kcal / 50 g → 45.8).
    const corrected = await repos.foodItems.getByUpc(BAD_MILK.upc)
    expect(corrected!.id).toBe(badItem.id)
    expect(corrected!.source).toBe('user')
    expect(corrected!.per100g.kcal).toBeCloseTo(45.8, 5)
    expect(corrected!.per100g.proteinG).toBeCloseTo(3.8, 5)
    expect(corrected!.isLiquid).toBe(true)

    // A rescan (any user) cache-hits the corrected row — OFF untouched.
    const rescan = await req(bearer, 'POST', '/api/v1/ui/food/barcode', { upc: BAD_MILK.upc })
    const rescanBody = (await rescan.json()) as { item: FoodItemDto; cached: boolean }
    expect(rescanBody.cached).toBe(true)
    expect(rescanBody.item.source).toBe('user')
    expect(offLookup.mock.calls.length).toBe(offCallsBefore)

    // OFF write-throughs (barcode + search upserts) are first-writer-wins,
    // so stale OFF data can never clobber the correction.
    await repos.foodItems.upsertByUpc({
      id: 'ff_off_stale',
      upc: BAD_MILK.upc,
      source: 'off',
      name: 'Stale OFF Milk',
      per100g: BAD_MILK.per100g,
    })
    const afterUpsert = await repos.foodItems.getByUpc(BAD_MILK.upc)
    expect(afterUpsert!.id).toBe(badItem.id)
    expect(afterUpsert!.source).toBe('user')
    expect(afterUpsert!.per100g.kcal).toBeCloseTo(45.8, 5)
  })

  it('correction with an unverified token is rejected (403) and the row is untouched', async () => {
    const bearer = await loginAs('user_correction_forger')
    const UPC = '042272005703'
    offLookup.mockResolvedValueOnce(offHit({ ...OFF_PRODUCT, upc: UPC }))
    await req(bearer, 'POST', '/api/v1/ui/food/barcode', { upc: UPC })

    const res = await req(bearer, 'POST', '/api/v1/ui/food/log', {
      loggedAt: '2026-07-15T08:00:00.000Z',
      name: 'Forged fix',
      quantityGrams: 50,
      kcal: 1,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      source: 'barcode',
      saveAsUpc: {
        upc: UPC,
        token: 'not-a-real-token',
        servingGrams: 50,
        servingUnit: 'g' as const,
        isLiquid: false,
        correction: true,
      },
    })
    expect(res.status).toBe(403)
    const row = await repos.foodItems.getByUpc(UPC)
    expect(row!.source).toBe('off')
    expect(row!.per100g).toEqual(OFF_PRODUCT.per100g)
  })

  it('correction for a UPC with no global row falls through to the contribution path', async () => {
    const bearer = await loginAs('user_correction_missing')
    const UPC = '036000291452'
    analyzeNutritionLabel.mockResolvedValueOnce(LABEL_READ)
    const label = await req(bearer, 'POST', '/api/v1/ui/food/label', {
      upc: UPC,
      imageBase64: TINY_PNG_B64,
      mimeType: 'image/png',
    })
    const { contributionToken } = (await label.json()) as { contributionToken: string }

    const logged = await req(bearer, 'POST', '/api/v1/ui/food/log', {
      loggedAt: '2026-07-15T12:00:00.000Z',
      name: 'Store Granola',
      quantityGrams: 50,
      kcal: 200,
      proteinG: 20,
      carbsG: 20,
      fatG: 10,
      source: 'barcode',
      saveAsUpc: {
        upc: UPC,
        token: contributionToken,
        servingGrams: 50,
        servingUnit: 'g' as const,
        isLiquid: false,
        correction: true,
      },
    })
    expect(logged.status).toBe(201)
    // No row to correct → same behavior as a fresh contribution.
    expect(((await logged.json()) as FoodLogEntryDto).contributionStatus).toBe('submitted')
    expect(await repos.foodItems.getByUpc(UPC)).toBeNull()
  })

  // --- diary CRUD -----------------------------------------------------

  it('logs an entry, lists it in a day window, patches, and deletes it', async () => {
    const bearer = await loginAs('user_food_crud')
    const created = await req(bearer, 'POST', '/api/v1/ui/food/log', {
      loggedAt: '2026-07-13T12:30:00.000Z',
      name: 'Chicken breast',
      quantityGrams: 300,
      kcal: 495,
      proteinG: 93,
      carbsG: 0,
      fatG: 10.8,
      source: 'manual',
      note: 'lunch',
    })
    expect(created.status).toBe(201)
    const dto = (await created.json()) as FoodLogEntryDto
    expect(dto.id).toMatch(/^fl_/)
    expect(dto.kcal).toBe(495)
    expect(dto.foodItemId).toBeNull()

    // Day-window list (client-supplied bounds per the timezone rule).
    const inWindow = await req(
      bearer,
      'GET',
      '/api/v1/ui/food/log?from=2026-07-13T00:00:00.000Z&to=2026-07-13T23:59:59.999Z',
    )
    const inBody = (await inWindow.json()) as { entries: FoodLogEntryDto[] }
    expect(inBody.entries).toHaveLength(1)

    const outWindow = await req(
      bearer,
      'GET',
      '/api/v1/ui/food/log?from=2026-07-14T00:00:00.000Z&to=2026-07-14T23:59:59.999Z',
    )
    expect(((await outWindow.json()) as { entries: unknown[] }).entries).toHaveLength(0)

    // Patch macros + clear note.
    const patched = await req(bearer, 'PATCH', `/api/v1/ui/food/log/${dto.id}`, {
      quantityGrams: 150,
      kcal: 248,
      proteinG: 46.5,
      fatG: 5.4,
      note: null,
    })
    expect(patched.status).toBe(200)
    const patchedDto = (await patched.json()) as FoodLogEntryDto
    expect(patchedDto.kcal).toBe(248)
    expect(patchedDto.quantityGrams).toBe(150)
    expect(patchedDto.note).toBeNull()
    // Untouched fields survive.
    expect(patchedDto.carbsG).toBe(0)

    const del = await req(bearer, 'DELETE', `/api/v1/ui/food/log/${dto.id}`)
    expect(del.status).toBe(200)
    const relist = await req(bearer, 'GET', '/api/v1/ui/food/log')
    expect(((await relist.json()) as { entries: unknown[] }).entries).toHaveLength(0)
  })

  it('logs with a quantity unit pair, patches it, clears it, and drops stale pairs', async () => {
    const bearer = await loginAs('user_food_units')
    const created = await req(bearer, 'POST', '/api/v1/ui/food/log', {
      loggedAt: '2026-07-13T09:00:00.000Z',
      name: 'Milk',
      quantityGrams: 236.6,
      quantityUnit: 'cup',
      quantityAmount: 1,
      kcal: 78,
      proteinG: 12.8,
      carbsG: 5.9,
      fatG: 0,
      source: 'barcode',
    })
    expect(created.status).toBe(201)
    const dto = (await created.json()) as FoodLogEntryDto
    expect(dto.quantityUnit).toBe('cup')
    expect(dto.quantityAmount).toBe(1)
    expect(dto.quantityGrams).toBe(236.6)

    // Round-trips through the list read.
    const list = await req(
      bearer,
      'GET',
      '/api/v1/ui/food/log?from=2026-07-13T00:00:00.000Z&to=2026-07-13T23:59:59.999Z',
    )
    const listed = ((await list.json()) as { entries: FoodLogEntryDto[] }).entries[0]!
    expect(listed.quantityUnit).toBe('cup')
    expect(listed.quantityAmount).toBe(1)

    // Patch to a new unit pair.
    const patched = await req(bearer, 'PATCH', `/api/v1/ui/food/log/${dto.id}`, {
      quantityGrams: 473.2,
      quantityUnit: 'cup',
      quantityAmount: 2,
      kcal: 156,
    })
    expect(patched.status).toBe(200)
    const patchedDto = (await patched.json()) as FoodLogEntryDto
    expect(patchedDto.quantityAmount).toBe(2)
    expect(patchedDto.quantityGrams).toBe(473.2)

    // A grams-only patch (e.g. another client) clears the stale pair.
    const gramsOnly = await req(bearer, 'PATCH', `/api/v1/ui/food/log/${dto.id}`, {
      quantityGrams: 100,
    })
    const gramsOnlyDto = (await gramsOnly.json()) as FoodLogEntryDto
    expect(gramsOnlyDto.quantityGrams).toBe(100)
    expect(gramsOnlyDto.quantityUnit).toBeNull()
    expect(gramsOnlyDto.quantityAmount).toBeNull()

    // Clearing the whole trio.
    const cleared = await req(bearer, 'PATCH', `/api/v1/ui/food/log/${dto.id}`, {
      quantityGrams: null,
      quantityUnit: null,
      quantityAmount: null,
    })
    const clearedDto = (await cleared.json()) as FoodLogEntryDto
    expect(clearedDto.quantityGrams).toBeNull()
    expect(clearedDto.quantityUnit).toBeNull()
    expect(clearedDto.quantityAmount).toBeNull()

    // Validation: unit without amount, and unit without grams.
    expect(
      (
        await req(bearer, 'PATCH', `/api/v1/ui/food/log/${dto.id}`, {
          quantityUnit: 'oz',
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await req(bearer, 'POST', '/api/v1/ui/food/log', {
          loggedAt: '2026-07-13T09:00:00.000Z',
          name: 'Bad',
          quantityUnit: 'oz',
          quantityAmount: 2,
          kcal: 1,
          proteinG: 0,
          carbsG: 0,
          fatG: 0,
          source: 'manual',
        })
      ).status,
    ).toBe(400)
  })

  it('log entry can reference a cached food item; phantom ids are 404', async () => {
    const bearer = await loginAs('user_food_ref')
    offLookup.mockResolvedValueOnce(offHit({ ...OFF_PRODUCT, upc: '888888888888' }))
    const lookup = await req(bearer, 'POST', '/api/v1/ui/food/barcode', {
      upc: '888888888888',
    })
    const { item } = (await lookup.json()) as { item: FoodItemDto }

    const created = await req(bearer, 'POST', '/api/v1/ui/food/log', {
      loggedAt: '2026-07-13T08:00:00.000Z',
      foodItemId: item.id,
      name: item.name,
      quantityGrams: 90,
      kcal: 324,
      proteinG: 6.4,
      carbsG: 72,
      fatG: 1.1,
      source: 'barcode',
    })
    expect(created.status).toBe(201)
    expect(((await created.json()) as FoodLogEntryDto).foodItemId).toBe(item.id)

    const phantom = await req(bearer, 'POST', '/api/v1/ui/food/log', {
      loggedAt: '2026-07-13T08:00:00.000Z',
      foodItemId: 'ff_does_not_exist',
      name: 'Ghost',
      kcal: 1,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      source: 'barcode',
    })
    expect(phantom.status).toBe(404)
  })

  it('atomically saves a private reusable manual food and updates it by case-insensitive name', async () => {
    const owner = await loginAs('user_custom_food_owner')
    const other = await loginAs('user_custom_food_other')
    const first = await req(owner, 'POST', '/api/v1/ui/food/log', {
      loggedAt: '2026-07-13T10:00:00.000Z',
      name: 'Private Oats',
      quantityGrams: 80,
      quantityUnit: 'g',
      quantityAmount: 80,
      kcal: 300,
      proteinG: 10,
      carbsG: 50,
      fatG: 7,
      source: 'manual',
      saveAsCustom: true,
    })
    expect(first.status).toBe(201)
    const firstLog = (await first.json()) as FoodLogEntryDto
    expect(firstLog.foodItemId).toMatch(/^ff_/)

    await repos.foodItems.upsertByUpc({
      id: 'ff_private_oats_shared',
      upc: '909090909090',
      source: 'off',
      name: 'Private Oats Cereal',
      per100g: { kcal: 400, proteinG: 8, carbsG: 70, fatG: 9 },
    })

    offSearch.mockReset()
    offSearch.mockResolvedValue([])
    const ownerSearch = await req(owner, 'GET', '/api/v1/ui/food/search?q=private%20oats')
    const ownerItems = ((await ownerSearch.json()) as { items: FoodItemDto[] }).items
    expect(ownerItems[0]).toMatchObject({
      id: firstLog.foodItemId,
      name: 'Private Oats',
      source: 'manual',
      servingGrams: 80,
    })
    expect(ownerItems[0]!.per100g.kcal).toBe(375)

    const hiddenRead = await req(other, 'GET', `/api/v1/ui/food/items/${firstLog.foodItemId}`)
    expect(hiddenRead.status).toBe(404)
    const hiddenReference = await req(other, 'POST', '/api/v1/ui/food/log', {
      loggedAt: '2026-07-13T10:00:00.000Z',
      foodItemId: firstLog.foodItemId,
      name: 'Stolen oats',
      quantityGrams: 80,
      kcal: 300,
      proteinG: 10,
      carbsG: 50,
      fatG: 7,
      source: 'manual',
    })
    expect(hiddenReference.status).toBe(404)

    const otherSearch = await req(other, 'GET', '/api/v1/ui/food/search?q=private%20oats')
    const otherItems = ((await otherSearch.json()) as { items: FoodItemDto[] }).items
    expect(otherItems.map((item) => item.name)).toEqual(['Private Oats Cereal'])

    const second = await req(owner, 'POST', '/api/v1/ui/food/log', {
      loggedAt: '2026-07-14T10:00:00.000Z',
      name: 'private oats',
      quantityGrams: 100,
      kcal: 500,
      proteinG: 20,
      carbsG: 60,
      fatG: 12,
      source: 'manual',
      saveAsCustom: true,
    })
    expect(second.status).toBe(201)
    const secondLog = (await second.json()) as FoodLogEntryDto
    expect(secondLog.foodItemId).toBe(firstLog.foodItemId)

    const history = await req(owner, 'GET', '/api/v1/ui/food/log')
    const logs = ((await history.json()) as { entries: FoodLogEntryDto[] }).entries
    expect(logs.find((entry) => entry.id === firstLog.id)?.kcal).toBe(300)
    expect(logs.find((entry) => entry.id === secondLog.id)?.kcal).toBe(500)

    const updatedItem = await req(owner, 'GET', `/api/v1/ui/food/items/${firstLog.foodItemId}`)
    const updated = ((await updatedItem.json()) as { item: FoodItemDto }).item
    expect(updated.name).toBe('private oats')
    expect(updated.servingGrams).toBe(100)
    expect(updated.per100g.kcal).toBe(500)
  })

  it('rejects saveAsCustom outside a positive-gram, unreferenced manual entry', async () => {
    const bearer = await loginAs('user_custom_food_bad')
    const base = {
      loggedAt: '2026-07-13T08:00:00.000Z',
      name: 'Bad reusable',
      kcal: 10,
      proteinG: 1,
      carbsG: 1,
      fatG: 1,
      saveAsCustom: true,
    }
    expect(
      (await req(bearer, 'POST', '/api/v1/ui/food/log', { ...base, source: 'photo' })).status,
    ).toBe(400)
    expect(
      (await req(bearer, 'POST', '/api/v1/ui/food/log', { ...base, source: 'manual' })).status,
    ).toBe(400)
  })

  it('cross-user isolation on the diary', async () => {
    const ua = await loginAs('user_food_iso_a')
    const ub = await loginAs('user_food_iso_b')
    const created = await req(ua, 'POST', '/api/v1/ui/food/log', {
      loggedAt: '2026-07-13T18:00:00.000Z',
      name: 'Secret snack',
      kcal: 200,
      proteinG: 2,
      carbsG: 30,
      fatG: 8,
      source: 'manual',
    })
    const dto = (await created.json()) as FoodLogEntryDto

    const listByB = await req(ub, 'GET', '/api/v1/ui/food/log')
    expect(((await listByB.json()) as { entries: unknown[] }).entries).toHaveLength(0)
    expect((await req(ub, 'PATCH', `/api/v1/ui/food/log/${dto.id}`, { kcal: 1 })).status).toBe(404)
    expect((await req(ub, 'DELETE', `/api/v1/ui/food/log/${dto.id}`)).status).toBe(404)
    const listByA = await req(ua, 'GET', '/api/v1/ui/food/log')
    expect(((await listByA.json()) as { entries: FoodLogEntryDto[] }).entries).toHaveLength(1)
  })

  it('rejects invalid diary payloads (400)', async () => {
    const bearer = await loginAs('user_food_bad')
    const bad = await req(bearer, 'POST', '/api/v1/ui/food/log', {
      loggedAt: 'not-a-date',
      name: 'x',
      kcal: 1,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      source: 'manual',
    })
    expect(bad.status).toBe(400)
    const negative = await req(bearer, 'POST', '/api/v1/ui/food/log', {
      loggedAt: '2026-07-13T08:00:00.000Z',
      name: 'x',
      kcal: -10,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      source: 'manual',
    })
    expect(negative.status).toBe(400)
  })

  // --- estimation tracking (estimated-vs-actual + calibration) --------

  it('persists estimatedGrams + scanResponseId on a photo log and echoes them in the DTO', async () => {
    recordFeedback.mockClear()
    const bearer = await loginAs('user_food_est_persist')
    const res = await req(bearer, 'POST', '/api/v1/ui/food/log', {
      loggedAt: new Date().toISOString(),
      name: 'Chicken plate',
      quantityGrams: 320,
      kcal: 600,
      proteinG: 45,
      carbsG: 40,
      fatG: 20,
      source: 'photo',
      estimatedGrams: 320,
      scanResponseId: 'resp_persist_1',
    })
    expect(res.status).toBe(201)
    const entry = (await res.json()) as FoodLogEntryDto
    expect(entry.estimatedGrams).toBe(320)

    const listed = await req(bearer, 'GET', '/api/v1/ui/food/log')
    const { entries } = (await listed.json()) as { entries: FoodLogEntryDto[] }
    expect(entries[0]!.estimatedGrams).toBe(320)

    // The raw column round-trips, including the trace link.
    const row = await db.get<{ estimated_grams: number | null; scan_response_id: string | null }>(
      sql`select estimated_grams, scan_response_id from food_log_entries where id = ${entry.id}`,
    )
    expect(row).toEqual({ estimated_grams: 320, scan_response_id: 'resp_persist_1' })
    // Amount matched the prefill — no correction feedback.
    expect(recordFeedback).not.toHaveBeenCalled()
  })

  it('records edited feedback when the logged grams diverge from the calibrated prefill', async () => {
    recordFeedback.mockClear()
    const bearer = await loginAs('user_food_est_edit')
    const res = await req(bearer, 'POST', '/api/v1/ui/food/log', {
      loggedAt: new Date().toISOString(),
      name: 'Big plate',
      quantityGrams: 400,
      kcal: 800,
      proteinG: 50,
      carbsG: 70,
      fatG: 30,
      source: 'photo',
      estimatedGrams: 300,
      scanResponseId: 'resp_edit_1',
    })
    expect(res.status).toBe(201)
    expect(recordFeedback).toHaveBeenCalledWith({
      responseId: 'resp_edit_1',
      userId: 'user_food_est_edit',
      action: 'edited',
      finalValue: { kind: 'food-grams-correction', estimatedGrams: 300, quantityGrams: 400 },
    })
  })

  it('does NOT record feedback when the grams match estimate × portionBias (anti-self-poisoning)', async () => {
    recordFeedback.mockClear()
    const bearer = await loginAs('user_food_est_bias')
    // Raw 300 g, bias 1.5 → prefill 450 g; the user accepted 450.
    const res = await req(bearer, 'POST', '/api/v1/ui/food/log', {
      loggedAt: new Date().toISOString(),
      name: 'Calibrated plate',
      quantityGrams: 450,
      kcal: 900,
      proteinG: 60,
      carbsG: 80,
      fatG: 35,
      source: 'photo',
      estimatedGrams: 300,
      scanResponseId: 'resp_bias_1',
      portionBias: 1.5,
    })
    expect(res.status).toBe(201)
    expect(recordFeedback).not.toHaveBeenCalled()
  })

  it('patching grams on a scan-linked entry records edited feedback; a non-scan entry does not', async () => {
    recordFeedback.mockClear()
    const bearer = await loginAs('user_food_est_patch')
    const mk = async (extra: Record<string, unknown>) => {
      const res = await req(bearer, 'POST', '/api/v1/ui/food/log', {
        loggedAt: new Date().toISOString(),
        name: 'Weighable',
        quantityGrams: 300,
        kcal: 500,
        proteinG: 30,
        carbsG: 50,
        fatG: 15,
        ...extra,
      })
      expect(res.status).toBe(201)
      return (await res.json()) as FoodLogEntryDto
    }
    const scanEntry = await mk({
      source: 'photo',
      estimatedGrams: 300,
      scanResponseId: 'resp_patch_1',
    })
    const manualEntry = await mk({ source: 'manual' })
    expect(recordFeedback).not.toHaveBeenCalled()

    // The kitchen-scale correction days later.
    const patched = await req(bearer, 'PATCH', `/api/v1/ui/food/log/${scanEntry.id}`, {
      quantityGrams: 360,
    })
    expect(patched.status).toBe(200)
    expect(recordFeedback).toHaveBeenCalledWith({
      responseId: 'resp_patch_1',
      userId: 'user_food_est_patch',
      action: 'edited',
      finalValue: { kind: 'food-grams-correction', estimatedGrams: 300, quantityGrams: 360 },
    })

    // Re-saving the same amount stays silent.
    recordFeedback.mockClear()
    const same = await req(bearer, 'PATCH', `/api/v1/ui/food/log/${scanEntry.id}`, {
      quantityGrams: 360,
    })
    expect(same.status).toBe(200)
    expect(recordFeedback).not.toHaveBeenCalled()

    // A non-scan entry never emits feedback.
    const manualPatch = await req(bearer, 'PATCH', `/api/v1/ui/food/log/${manualEntry.id}`, {
      quantityGrams: 999,
    })
    expect(manualPatch.status).toBe(200)
    expect(recordFeedback).not.toHaveBeenCalled()
  })

  it('scan returns a portionBias derived from the user estimate-vs-actual history', async () => {
    const bearer = await loginAs('user_food_est_history')
    // Three corrected photo entries, all ~1.2× the estimate.
    for (const [est, actual] of [
      [100, 120],
      [200, 240],
      [300, 360],
    ] as const) {
      const res = await req(bearer, 'POST', '/api/v1/ui/food/log', {
        loggedAt: new Date().toISOString(),
        name: 'History',
        quantityGrams: actual,
        kcal: 100,
        proteinG: 5,
        carbsG: 10,
        fatG: 2,
        source: 'photo',
        estimatedGrams: est,
        scanResponseId: `resp_hist_${est}`,
      })
      expect(res.status).toBe(201)
    }

    const scan = {
      mealName: 'Calibrated meal',
      estimatedServings: 1,
      items: [{ name: 'Rice', estimatedGrams: 250, kcal: 325, proteinG: 6, carbsG: 70, fatG: 1 }],
      questions: [],
    }
    analyzeFoodImage.mockResolvedValueOnce(scan)
    const res = await req(bearer, 'POST', '/api/v1/ui/food/scan', {
      imageBase64: TINY_PNG_B64,
      mimeType: 'image/png',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { portionBias: number }
    expect(body.portionBias).toBeCloseTo(1.2)
  })

  it('rejects estimation fields on non-photo entries (400)', async () => {
    const bearer = await loginAs('user_food_est_reject')
    const res = await req(bearer, 'POST', '/api/v1/ui/food/log', {
      loggedAt: new Date().toISOString(),
      name: 'Sneaky',
      kcal: 100,
      proteinG: 5,
      carbsG: 10,
      fatG: 2,
      source: 'manual',
      estimatedGrams: 100,
    })
    expect(res.status).toBe(400)
  })

  it('food_items upsert is idempotent under a concurrent-scan race', async () => {
    // Drive the repo directly: two inserts for the same upc must yield
    // one row, both calls returning it.
    const a = await repos.foodItems.upsertByUpc({
      id: 'ff_race_a',
      upc: '999999999999',
      source: 'off',
      name: 'Race Bar',
      per100g: { kcal: 400, proteinG: 20, carbsG: 40, fatG: 15 },
    })
    const b = await repos.foodItems.upsertByUpc({
      id: 'ff_race_b',
      upc: '999999999999',
      source: 'off',
      name: 'Race Bar (dup)',
      per100g: { kcal: 401, proteinG: 21, carbsG: 41, fatG: 16 },
    })
    expect(b.id).toBe(a.id)
    expect(b.name).toBe('Race Bar')
  })

  // --- per-day calorie summary ---------------------------------------

  async function logMeal(
    bearer: string,
    loggedAt: string,
    kcal: number,
    macros: { proteinG: number; carbsG: number; fatG: number },
  ): Promise<void> {
    const res = await req(bearer, 'POST', '/api/v1/ui/food/log', {
      loggedAt,
      name: 'Meal',
      quantityGrams: 100,
      kcal,
      ...macros,
      source: 'manual',
    })
    expect(res.status).toBe(201)
  }

  interface SummaryDay {
    date: string
    kcal: number
    proteinG: number
    carbsG: number
    fatG: number
    entries: number
  }

  it('summary groups by the client-offset local day and sums macros', async () => {
    const bearer = await loginAs('user_food_summary')
    const m = { proteinG: 10.25, carbsG: 20.5, fatG: 5.1 }
    // Two instants straddling the UTC midnight between Jul 13 and 14.
    await logMeal(bearer, '2026-07-13T23:30:00.000Z', 300.4, m)
    await logMeal(bearer, '2026-07-14T01:00:00.000Z', 200.4, m)

    // UTC buckets: two separate days.
    const utc = await req(
      bearer,
      'GET',
      '/api/v1/ui/food/summary?from=2026-07-13T00:00:00.000Z&to=2026-07-15T00:00:00.000Z&tz=0',
    )
    expect(utc.status).toBe(200)
    const utcDays = ((await utc.json()) as { days: SummaryDay[] }).days
    expect(utcDays.map((d) => [d.date, d.entries])).toEqual([
      ['2026-07-13', 1],
      ['2026-07-14', 1],
    ])
    expect(utcDays[0]!.kcal).toBe(300)

    // UTC+2 (tz=120): both land on local Jul 14, macro sums 1-dp rounded
    // like the diary header.
    const east = await req(
      bearer,
      'GET',
      '/api/v1/ui/food/summary?from=2026-07-13T00:00:00.000Z&to=2026-07-15T00:00:00.000Z&tz=120',
    )
    const eastDays = ((await east.json()) as { days: SummaryDay[] }).days
    expect(eastDays).toHaveLength(1)
    expect(eastDays[0]).toEqual({
      date: '2026-07-14',
      kcal: 501, // 300.4 + 200.4 → 500.8 → rounds to 501
      proteinG: 20.5,
      carbsG: 41,
      fatG: 10.2,
      entries: 2,
    })

    // UTC-5 (tz=-300): both land on local Jul 13.
    const west = await req(
      bearer,
      'GET',
      '/api/v1/ui/food/summary?from=2026-07-13T00:00:00.000Z&to=2026-07-15T00:00:00.000Z&tz=-300',
    )
    const westDays = ((await west.json()) as { days: SummaryDay[] }).days
    expect(westDays).toHaveLength(1)
    expect(westDays[0]!.date).toBe('2026-07-13')
  })

  it('summary respects the from/to window and never crosses users', async () => {
    const bearer = await loginAs('user_food_summary_window')
    const other = await loginAs('user_food_summary_other')
    const m = { proteinG: 1, carbsG: 1, fatG: 1 }
    await logMeal(bearer, '2026-06-01T12:00:00.000Z', 100, m)
    await logMeal(bearer, '2026-06-05T12:00:00.000Z', 200, m)
    await logMeal(other, '2026-06-05T13:00:00.000Z', 999, m)

    const res = await req(
      bearer,
      'GET',
      '/api/v1/ui/food/summary?from=2026-06-04T00:00:00.000Z&to=2026-06-06T00:00:00.000Z&tz=0',
    )
    const days = ((await res.json()) as { days: SummaryDay[] }).days
    expect(days).toHaveLength(1)
    expect(days[0]!.date).toBe('2026-06-05')
    expect(days[0]!.kcal).toBe(200)
  })

  it('summary rejects a malformed or out-of-range tz (400)', async () => {
    const bearer = await loginAs('user_food_summary_tz')
    for (const tz of ['abc', '9000', '-9000']) {
      const res = await req(bearer, 'GET', `/api/v1/ui/food/summary?tz=${tz}`)
      expect(res.status, `tz=${tz}`).toBe(400)
    }
    // Bare summary (no params) is valid — empty diary → empty days.
    const empty = await req(bearer, 'GET', '/api/v1/ui/food/summary')
    expect(empty.status).toBe(200)
    expect(((await empty.json()) as { days: unknown[] }).days).toEqual([])
  })

  // --- AI vision rate limiting ----------------------------------------
  // The three food vision endpoints (scan/text/label) share ONE per-user
  // token bucket (`user:<id>:ai-scan`) so a user can't get 3× the inference
  // budget by rotating endpoints — and the WOD scan (scan.d1.test.ts) draws
  // on the same key. Stub repos.rateLimit to deny, then assert the bucket
  // key each handler uses and that the model is gated before it's called.
  describe('AI vision endpoints share one per-user rate-limit bucket', () => {
    it('gates food/scan, food/text and food/label on user:<id>:ai-scan before the model', async () => {
      const bearer = await loginAs('user_food_rl')
      const seen: string[] = []
      const stubbedRateLimit = {
        async takeToken(input: { bucketKey: string }) {
          seen.push(input.bucketKey)
          return { allowed: false, retryAfterSeconds: 30, blendedCount: 11 }
        },
        async reset() {},
        async pruneOldBuckets() {
          return 0
        },
      }
      const hybridApp = buildApp({
        env: envVars,
        logger: undefined,
        repos: { ...repos, rateLimit: stubbedRateLimit } as unknown as Repos,
        services,
      })
      analyzeFoodImage.mockClear()
      analyzeFoodText.mockClear()
      analyzeNutritionLabel.mockClear()

      const post = (path: string, body: unknown) =>
        hybridApp.request(`http://localhost${path}`, {
          method: 'POST',
          headers: headers(bearer),
          body: JSON.stringify(body),
        })

      // Bodies are intentionally minimal — the bucket denies before body
      // parsing, so validity is irrelevant to the 429.
      const scan = await post('/api/v1/ui/food/scan', {
        imageBase64: TINY_PNG_B64,
        mimeType: 'image/png',
      })
      const text = await post('/api/v1/ui/food/text', { text: 'a bowl of rice' })
      const label = await post('/api/v1/ui/food/label', {
        upc: '0001112223334',
        imageBase64: TINY_PNG_B64,
        mimeType: 'image/png',
      })

      for (const res of [scan, text, label]) {
        expect(res.status).toBe(429)
        expect(res.headers.get('Retry-After')).toBe('30')
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('rate_limited')
      }
      // One shared bucket key across all three endpoints.
      expect(seen).toEqual([
        'user:user_food_rl:ai-scan',
        'user:user_food_rl:ai-scan',
        'user:user_food_rl:ai-scan',
      ])
      // The model is never reached once the bucket is exhausted.
      expect(analyzeFoodImage).not.toHaveBeenCalled()
      expect(analyzeFoodText).not.toHaveBeenCalled()
      expect(analyzeNutritionLabel).not.toHaveBeenCalled()
    })
  })
})
