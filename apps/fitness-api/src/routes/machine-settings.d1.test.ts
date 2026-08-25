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

// Per-user, per-exercise machine settings — flexible name/value notes
// (e.g. "Cable height" -> "4"). Covers the CRUD round-trip, the
// empty-array-deletes-the-row contract, per-user isolation, validation,
// and the 404 path for exercises outside the actor's visible catalog.

const CSRF = 'csrf_token_value_machine_settings_aaaaaaaaaaaaaaaaa'

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

describe('D1 integration — exercise machine settings', () => {
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
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  // The exercises seed migration (0002_seed_catalog) populates the
  // global catalog with a handful of canonical ids — picking one we
  // know exists keeps these tests independent of the seed details.
  const SEED_EX_ID = 'fx_seed_pull_up'

  it('rejects unauthenticated reads with 401', async () => {
    const res = await app.request(`http://localhost/api/v1/ui/exercises/${SEED_EX_ID}/machine-settings`, {
      headers: { 'x-rp-csrf': CSRF, cookie: `${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}` },
    })
    expect(res.status).toBe(401)
  })

  it('returns an empty entries array when nothing has been saved', async () => {
    const bearer = await loginAs('user_ms_empty')
    const res = await req(bearer, 'GET', `/api/v1/ui/exercises/${SEED_EX_ID}/machine-settings`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: unknown[] }
    expect(body.entries).toEqual([])
  })

  it('PUT then GET round-trips entries', async () => {
    const bearer = await loginAs('user_ms_put')
    const entries = [
      { name: 'Cable height', value: '4' },
      { name: 'Handle', value: 'rope' },
    ]
    const put = await req(
      bearer,
      'PUT',
      `/api/v1/ui/exercises/${SEED_EX_ID}/machine-settings`,
      { entries },
    )
    expect(put.status).toBe(200)
    expect(((await put.json()) as { entries: unknown[] }).entries).toEqual(entries)

    const get = await req(bearer, 'GET', `/api/v1/ui/exercises/${SEED_EX_ID}/machine-settings`)
    expect(((await get.json()) as { entries: unknown[] }).entries).toEqual(entries)
  })

  it('saving an empty array deletes the row', async () => {
    const bearer = await loginAs('user_ms_delete')
    await req(bearer, 'PUT', `/api/v1/ui/exercises/${SEED_EX_ID}/machine-settings`, {
      entries: [{ name: 'Seat', value: '3' }],
    })
    const cleared = await req(
      bearer,
      'PUT',
      `/api/v1/ui/exercises/${SEED_EX_ID}/machine-settings`,
      { entries: [] },
    )
    expect(cleared.status).toBe(200)
    expect(((await cleared.json()) as { entries: unknown[] }).entries).toEqual([])

    const get = await req(bearer, 'GET', `/api/v1/ui/exercises/${SEED_EX_ID}/machine-settings`)
    expect(((await get.json()) as { entries: unknown[] }).entries).toEqual([])
  })

  it('isolates entries across users', async () => {
    const alice = await loginAs('user_ms_alice')
    const bob = await loginAs('user_ms_bob')
    await req(alice, 'PUT', `/api/v1/ui/exercises/${SEED_EX_ID}/machine-settings`, {
      entries: [{ name: 'Seat', value: '5' }],
    })

    const aliceGet = await req(alice, 'GET', `/api/v1/ui/exercises/${SEED_EX_ID}/machine-settings`)
    expect(((await aliceGet.json()) as { entries: unknown[] }).entries).toEqual([
      { name: 'Seat', value: '5' },
    ])

    const bobGet = await req(bob, 'GET', `/api/v1/ui/exercises/${SEED_EX_ID}/machine-settings`)
    expect(((await bobGet.json()) as { entries: unknown[] }).entries).toEqual([])
  })

  it('rejects more than 12 entries', async () => {
    const bearer = await loginAs('user_ms_toomany')
    const entries = Array.from({ length: 13 }, (_, i) => ({ name: `Setting ${i}`, value: '1' }))
    const res = await req(bearer, 'PUT', `/api/v1/ui/exercises/${SEED_EX_ID}/machine-settings`, {
      entries,
    })
    expect(res.status).toBe(400)
  })

  it('rejects an entry with an empty name', async () => {
    const bearer = await loginAs('user_ms_emptyname')
    const res = await req(bearer, 'PUT', `/api/v1/ui/exercises/${SEED_EX_ID}/machine-settings`, {
      entries: [{ name: '', value: '4' }],
    })
    expect(res.status).toBe(400)
  })

  it('404s on GET for an unknown exercise id', async () => {
    const bearer = await loginAs('user_ms_missing_get')
    const res = await req(bearer, 'GET', '/api/v1/ui/exercises/fx_does_not_exist/machine-settings')
    expect(res.status).toBe(404)
  })

  it('404s on PUT for an unknown exercise id', async () => {
    const bearer = await loginAs('user_ms_missing_put')
    const res = await req(bearer, 'PUT', '/api/v1/ui/exercises/fx_does_not_exist/machine-settings', {
      entries: [{ name: 'Seat', value: '3' }],
    })
    expect(res.status).toBe(404)
  })

  it("404s for another user's custom exercise", async () => {
    const owner = await loginAs('user_ms_owner')
    const created = await req(owner, 'POST', '/api/v1/ui/exercises', {
      name: 'Owner Only Machine Move',
      discipline: 'machine',
      movementPattern: 'horizontal_push',
      metricShape: 'load_reps',
    })
    const dto = (await created.json()) as { id: string }

    const intruder = await loginAs('user_ms_intruder')
    const get = await req(intruder, 'GET', `/api/v1/ui/exercises/${dto.id}/machine-settings`)
    expect(get.status).toBe(404)

    const put = await req(intruder, 'PUT', `/api/v1/ui/exercises/${dto.id}/machine-settings`, {
      entries: [{ name: 'Seat', value: '3' }],
    })
    expect(put.status).toBe(404)
  })
})
