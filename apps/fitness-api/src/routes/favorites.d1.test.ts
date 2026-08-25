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

// Per-user exercise favorites — the star/save table backing the
// redesigned Library tab. Covers the happy add/remove cycle,
// idempotence, list isolation across users, and the 404 path when an
// actor tries to star a row outside their visible catalog.

const CSRF = 'csrf_token_value_favorites_aaaaaaaaaaaaaaaaa'

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

describe('D1 integration — exercise favorites', () => {
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

  async function req(bearer: string, method: string, path: string): Promise<Response> {
    return app.request(`http://localhost${path}`, { method, headers: headers(bearer) })
  }

  // The exercises seed migration (0002_seed_catalog) populates the
  // global catalog with a handful of canonical ids — picking one we
  // know exists keeps these tests independent of the seed details.
  const SEED_EX_ID = 'fx_seed_pull_up'

  it('rejects unauthenticated reads with 401', async () => {
    const res = await app.request('http://localhost/api/v1/ui/favorites/exercises', {
      headers: { 'x-rp-csrf': CSRF, cookie: `${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}` },
    })
    expect(res.status).toBe(401)
  })

  it('returns an empty list when nothing is starred yet', async () => {
    const bearer = await loginAs('user_fav_empty')
    const res = await req(bearer, 'GET', '/api/v1/ui/favorites/exercises')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { exerciseIds: string[] }
    expect(body.exerciseIds).toEqual([])
  })

  it('PUT then GET returns the starred id; second PUT is idempotent', async () => {
    const bearer = await loginAs('user_fav_add')
    const first = await req(bearer, 'PUT', `/api/v1/ui/favorites/exercises/${SEED_EX_ID}`)
    expect(first.status).toBe(200)
    expect(((await first.json()) as { changed: boolean }).changed).toBe(true)

    const dupe = await req(bearer, 'PUT', `/api/v1/ui/favorites/exercises/${SEED_EX_ID}`)
    expect(dupe.status).toBe(200)
    expect(((await dupe.json()) as { changed: boolean }).changed).toBe(false)

    const list = await req(bearer, 'GET', '/api/v1/ui/favorites/exercises')
    const body = (await list.json()) as { exerciseIds: string[] }
    expect(body.exerciseIds).toContain(SEED_EX_ID)
    expect(body.exerciseIds).toHaveLength(1)
  })

  it('DELETE removes the row; second DELETE is idempotent', async () => {
    const bearer = await loginAs('user_fav_remove')
    await req(bearer, 'PUT', `/api/v1/ui/favorites/exercises/${SEED_EX_ID}`)
    const first = await req(bearer, 'DELETE', `/api/v1/ui/favorites/exercises/${SEED_EX_ID}`)
    expect(first.status).toBe(200)
    expect(((await first.json()) as { changed: boolean }).changed).toBe(true)

    const dupe = await req(bearer, 'DELETE', `/api/v1/ui/favorites/exercises/${SEED_EX_ID}`)
    expect(dupe.status).toBe(200)
    expect(((await dupe.json()) as { changed: boolean }).changed).toBe(false)

    const list = await req(bearer, 'GET', '/api/v1/ui/favorites/exercises')
    expect(((await list.json()) as { exerciseIds: string[] }).exerciseIds).toEqual([])
  })

  it('starring an unknown exercise id returns 404', async () => {
    const bearer = await loginAs('user_fav_missing')
    const res = await req(bearer, 'PUT', '/api/v1/ui/favorites/exercises/fx_does_not_exist')
    expect(res.status).toBe(404)
  })

  it('isolates favorites across users', async () => {
    const alice = await loginAs('user_fav_alice')
    const bob = await loginAs('user_fav_bob')
    await req(alice, 'PUT', `/api/v1/ui/favorites/exercises/${SEED_EX_ID}`)

    const aliceList = await req(alice, 'GET', '/api/v1/ui/favorites/exercises')
    expect(((await aliceList.json()) as { exerciseIds: string[] }).exerciseIds).toContain(
      SEED_EX_ID,
    )

    const bobList = await req(bob, 'GET', '/api/v1/ui/favorites/exercises')
    expect(((await bobList.json()) as { exerciseIds: string[] }).exerciseIds).toEqual([])
  })
})
