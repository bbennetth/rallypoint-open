import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { findFavoriteForEntry } from '@rallypoint/fitness-shared'
import type { FoodFavoriteDto } from '@rallypoint/fitness-shared'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb, type Db } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { encryptBearer } from '../crypto/encryption.js'
import { FITNESS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Pinned quick-log templates. Covers the snapshot create/list/delete
// cycle, the dedupe contract the client's foodFavoriteKey() relies on,
// the soft-provenance handling of foodItemId (dropped, never 404), and
// per-user isolation.

const CSRF = 'csrf_token_value_food_favs_aaaaaaaaaaaaaaaaa'

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

const SNAPSHOT = {
  name: 'Greek yogurt',
  quantityGrams: 170,
  kcal: 100,
  proteinG: 17,
  carbsG: 6,
  fatG: 0.7,
  source: 'manual' as const,
}

describe('D1 integration — food favorites', () => {
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
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  async function list(bearer: string): Promise<FoodFavoriteDto[]> {
    const res = await req(bearer, 'GET', '/api/v1/ui/food/favorites')
    expect(res.status).toBe(200)
    return ((await res.json()) as { favorites: FoodFavoriteDto[] }).favorites
  }

  it('rejects unauthenticated reads with 401', async () => {
    const res = await app.request('http://localhost/api/v1/ui/food/favorites', {
      headers: { 'x-rp-csrf': CSRF, cookie: `${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}` },
    })
    expect(res.status).toBe(401)
  })

  it('returns an empty list when nothing is pinned yet', async () => {
    const bearer = await loginAs('user_ffav_empty')
    expect(await list(bearer)).toEqual([])
  })

  it('creates a pin from a snapshot and lists it back', async () => {
    const bearer = await loginAs('user_ffav_create')
    const res = await req(bearer, 'POST', '/api/v1/ui/food/favorites', SNAPSHOT)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { favorite: FoodFavoriteDto; created: boolean }
    expect(body.created).toBe(true)
    expect(body.favorite).toMatchObject({
      name: 'Greek yogurt',
      quantityGrams: 170,
      kcal: 100,
      source: 'manual',
      foodItemId: null,
    })
    expect(body.favorite.id).toMatch(/^ffav_/)
    expect(new Date(body.favorite.createdAt).getTime()).toBeGreaterThan(0)

    const rows = await list(bearer)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(body.favorite.id)
  })

  it('dedupes an equivalent pin instead of creating a second row', async () => {
    const bearer = await loginAs('user_ffav_dupe')
    const first = await req(bearer, 'POST', '/api/v1/ui/food/favorites', SNAPSHOT)
    const firstId = ((await first.json()) as { favorite: FoodFavoriteDto }).favorite.id

    // Same food, different letter case and a kcal that rounds to the
    // same whole number — the client would treat this as already pinned.
    const dupe = await req(bearer, 'POST', '/api/v1/ui/food/favorites', {
      ...SNAPSHOT,
      name: 'greek YOGURT',
      kcal: 100.4,
    })
    expect(dupe.status).toBe(200)
    const dupeBody = (await dupe.json()) as { favorite: FoodFavoriteDto; created: boolean }
    expect(dupeBody.created).toBe(false)
    expect(dupeBody.favorite.id).toBe(firstId)

    expect(await list(bearer)).toHaveLength(1)
  })

  it('dedupes a non-ASCII name that differs only in case', async () => {
    // SQLite's lower() folds ASCII only, so a SQL-side dedupe would miss
    // this and create a duplicate the client already shows as pinned.
    const bearer = await loginAs('user_ffav_unicode')
    const first = await req(bearer, 'POST', '/api/v1/ui/food/favorites', {
      ...SNAPSHOT,
      name: 'Café Latte',
    })
    const firstId = ((await first.json()) as { favorite: FoodFavoriteDto }).favorite.id

    const dupe = await req(bearer, 'POST', '/api/v1/ui/food/favorites', {
      ...SNAPSHOT,
      name: 'CAFÉ LATTE',
    })
    expect(dupe.status).toBe(200)
    const body = (await dupe.json()) as { favorite: FoodFavoriteDto; created: boolean }
    expect(body.created).toBe(false)
    expect(body.favorite.id).toBe(firstId)
    expect(await list(bearer)).toHaveLength(1)
  })

  it('dedupes grams that round the same under JS but not under SQLite', async () => {
    // round(133.35, 1) is 133.3 in SQLite (true double) and 133.4 under
    // Math.round(x * 10) / 10 — a SQL-side dedupe would split these.
    const bearer = await loginAs('user_ffav_rounding')
    const first = await req(bearer, 'POST', '/api/v1/ui/food/favorites', {
      ...SNAPSHOT,
      quantityGrams: 133.35,
    })
    const firstId = ((await first.json()) as { favorite: FoodFavoriteDto }).favorite.id

    const dupe = await req(bearer, 'POST', '/api/v1/ui/food/favorites', {
      ...SNAPSHOT,
      quantityGrams: 133.35,
    })
    expect(((await dupe.json()) as { created: boolean }).created).toBe(false)
    expect(await list(bearer)).toHaveLength(1)

    // ...and the client agrees this row is already pinned.
    const rows = await list(bearer)
    expect(findFavoriteForEntry(rows, { name: SNAPSHOT.name, quantityGrams: 133.35, kcal: 100 })?.id)
      .toBe(firstId)
  })

  it('dedupes a pin whose twin fell outside the display limit', async () => {
    // The dedupe scan must see every pin the actor holds, not just the
    // newest page listForActor returns.
    const bearer = await loginAs('user_ffav_deep')
    const first = await req(bearer, 'POST', '/api/v1/ui/food/favorites', {
      ...SNAPSHOT,
      name: 'Deep cut',
    })
    const firstId = ((await first.json()) as { favorite: FoodFavoriteDto }).favorite.id
    for (let i = 0; i < 55; i++) {
      await req(bearer, 'POST', '/api/v1/ui/food/favorites', {
        ...SNAPSHOT,
        name: `Filler ${i}`,
      })
    }
    const dupe = await req(bearer, 'POST', '/api/v1/ui/food/favorites', {
      ...SNAPSHOT,
      name: 'Deep cut',
    })
    expect(dupe.status).toBe(200)
    const body = (await dupe.json()) as { favorite: FoodFavoriteDto; created: boolean }
    expect(body.created).toBe(false)
    expect(body.favorite.id).toBe(firstId)
  })

  it('treats a different quantity of the same food as a separate pin', async () => {
    const bearer = await loginAs('user_ffav_qty')
    await req(bearer, 'POST', '/api/v1/ui/food/favorites', SNAPSHOT)
    const bigger = await req(bearer, 'POST', '/api/v1/ui/food/favorites', {
      ...SNAPSHOT,
      quantityGrams: 340,
      kcal: 200,
    })
    expect(bigger.status).toBe(201)
    expect(await list(bearer)).toHaveLength(2)
  })

  it('pins a freeform entry with no quantity or catalog row', async () => {
    const bearer = await loginAs('user_ffav_freeform')
    const res = await req(bearer, 'POST', '/api/v1/ui/food/favorites', {
      name: 'Handful of almonds',
      kcal: 170,
      proteinG: 6,
      carbsG: 6,
      fatG: 15,
      source: 'text',
    })
    expect(res.status).toBe(201)
    const { favorite } = (await res.json()) as { favorite: FoodFavoriteDto }
    expect(favorite.quantityGrams).toBeNull()
    expect(favorite.quantityUnit).toBeNull()
    expect(favorite.foodItemId).toBeNull()

    // A gram-less pin must not collide with a gram-bearing one.
    const withGrams = await req(bearer, 'POST', '/api/v1/ui/food/favorites', {
      name: 'Handful of almonds',
      quantityGrams: 28,
      kcal: 170,
      proteinG: 6,
      carbsG: 6,
      fatG: 15,
      source: 'manual',
    })
    expect(withGrams.status).toBe(201)
    expect(await list(bearer)).toHaveLength(2)
  })

  it('keeps the as-typed unit pair on the snapshot', async () => {
    const bearer = await loginAs('user_ffav_units')
    const res = await req(bearer, 'POST', '/api/v1/ui/food/favorites', {
      ...SNAPSHOT,
      quantityGrams: 240,
      quantityUnit: 'cup',
      quantityAmount: 1,
    })
    expect(res.status).toBe(201)
    const { favorite } = (await res.json()) as { favorite: FoodFavoriteDto }
    expect(favorite.quantityUnit).toBe('cup')
    expect(favorite.quantityAmount).toBe(1)
  })

  it('rejects a half-specified unit pair with a 400', async () => {
    const bearer = await loginAs('user_ffav_badunits')
    const res = await req(bearer, 'POST', '/api/v1/ui/food/favorites', {
      ...SNAPSHOT,
      quantityUnit: 'cup',
    })
    expect(res.status).toBe(400)
  })

  it('keeps a resolvable foodItemId as provenance', async () => {
    const bearer = await loginAs('user_ffav_item')
    await repos.foodItems.upsertByUpc({
      id: 'ff_ffav_item',
      upc: '904444444444',
      source: 'off',
      name: 'Cache Row',
      brand: null,
      servingGrams: null,
      servingQuantity: null,
      servingUnit: null,
      isLiquid: false,
      per100g: { kcal: 100, proteinG: 1, carbsG: 2, fatG: 3 },
      createdBy: 'user_ffav_item',
    })
    const res = await req(bearer, 'POST', '/api/v1/ui/food/favorites', {
      ...SNAPSHOT,
      foodItemId: 'ff_ffav_item',
    })
    expect(res.status).toBe(201)
    const { favorite } = (await res.json()) as { favorite: FoodFavoriteDto }
    expect(favorite.foodItemId).toBe('ff_ffav_item')
  })

  it('drops an unresolvable foodItemId rather than 404ing', async () => {
    // Unlike /food/log, the snapshot is self-sufficient — a pin drained
    // from the offline queue must not fail because the cache row went
    // away in the meantime.
    const bearer = await loginAs('user_ffav_ghost')
    const res = await req(bearer, 'POST', '/api/v1/ui/food/favorites', {
      ...SNAPSHOT,
      foodItemId: 'ff_does_not_exist',
    })
    expect(res.status).toBe(201)
    const { favorite } = (await res.json()) as { favorite: FoodFavoriteDto }
    expect(favorite.foodItemId).toBeNull()
  })

  it('lists newest pin first', async () => {
    const bearer = await loginAs('user_ffav_order')
    await req(bearer, 'POST', '/api/v1/ui/food/favorites', { ...SNAPSHOT, name: 'First' })
    await req(bearer, 'POST', '/api/v1/ui/food/favorites', { ...SNAPSHOT, name: 'Second' })
    await req(bearer, 'POST', '/api/v1/ui/food/favorites', { ...SNAPSHOT, name: 'Third' })
    const rows = await list(bearer)
    expect(rows.map((r) => r.name)).toEqual(['Third', 'Second', 'First'])
  })

  it('DELETE unpins; second DELETE is idempotent', async () => {
    const bearer = await loginAs('user_ffav_delete')
    const created = await req(bearer, 'POST', '/api/v1/ui/food/favorites', SNAPSHOT)
    const { favorite } = (await created.json()) as { favorite: FoodFavoriteDto }

    const first = await req(bearer, 'DELETE', `/api/v1/ui/food/favorites/${favorite.id}`)
    expect(first.status).toBe(200)
    expect(((await first.json()) as { changed: boolean }).changed).toBe(true)

    const dupe = await req(bearer, 'DELETE', `/api/v1/ui/food/favorites/${favorite.id}`)
    expect(dupe.status).toBe(200)
    expect(((await dupe.json()) as { changed: boolean }).changed).toBe(false)

    expect(await list(bearer)).toEqual([])
  })

  it('isolates pins across users', async () => {
    const alice = await loginAs('user_ffav_alice')
    const bob = await loginAs('user_ffav_bob')
    const created = await req(alice, 'POST', '/api/v1/ui/food/favorites', SNAPSHOT)
    const { favorite } = (await created.json()) as { favorite: FoodFavoriteDto }

    expect(await list(bob)).toEqual([])

    // Bob cannot delete Alice's pin, and Alice still has it.
    const cross = await req(bob, 'DELETE', `/api/v1/ui/food/favorites/${favorite.id}`)
    expect(cross.status).toBe(200)
    expect(((await cross.json()) as { changed: boolean }).changed).toBe(false)
    expect(await list(alice)).toHaveLength(1)
  })

  it('does not dedupe across users', async () => {
    const carol = await loginAs('user_ffav_carol')
    const dave = await loginAs('user_ffav_dave')
    const a = await req(carol, 'POST', '/api/v1/ui/food/favorites', SNAPSHOT)
    const b = await req(dave, 'POST', '/api/v1/ui/food/favorites', SNAPSHOT)
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    expect(await list(carol)).toHaveLength(1)
    expect(await list(dave)).toHaveLength(1)
  })
})
