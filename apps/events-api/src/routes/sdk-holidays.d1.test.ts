import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { makeNoopMoneyClient, makeNoopListsClient, makeStubObjectStore } from './_test-services.js'

// Integration tests for GET /api/v1/sdk/holidays — no DB dependency, pure computation.
// Verifies:
//   - Auth: missing/wrong key → 403
//   - Validation: missing from/to → 422; invalid date → 422; inverted → 422; too-wide span → 422
//   - Happy path: known year returns 11 holidays sorted by observedDate

const PLANNER_KEY = 'dev-planner-api-key-do-not-use-in-production-32+chars'

const services: Services = {
  idClient: {
    verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
    signoutRpidBearer: async () => {},
    batchLookupUsers: async () => [],
  },
  rpidSso: {
    exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
  },
  rpidReauth: {
    verify: async () => ({ ok: true as const }),
  },
  objectStore: makeStubObjectStore(),
  listsClient: makeNoopListsClient(),
  moneyClient: makeNoopMoneyClient(),
  weather: {
    getEventWeather: async () => ({ forecast: null, airQuality: null, issuedAt: new Date().toISOString() }),
  },
  settings: {
    get: async () => ({}),
    patch: async (_u: string, _n: string, patch: Record<string, unknown>) => patch,
  },
}

describe('D1 integration — SDK holidays route', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })

  function get(from?: string, to?: string, key = PLANNER_KEY): Promise<Response> {
    const qs = new URLSearchParams()
    if (from !== undefined) qs.set('from', from)
    if (to !== undefined) qs.set('to', to)
    const url = `http://localhost/api/v1/sdk/holidays${qs.toString() ? `?${qs.toString()}` : ''}`
    return app.request(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}` },
    })
  }

  it('403s when the Bearer is absent', async () => {
    const res = await app.request('http://localhost/api/v1/sdk/holidays?from=2026-01-01&to=2026-12-31', { method: 'GET' })
    expect(res.status).toBe(403)
  })

  it('403s when the Bearer is wrong', async () => {
    const res = await get('2026-01-01', '2026-12-31', 'wrong-key')
    expect(res.status).toBe(403)
  })

  it('422s when from is missing', async () => {
    const res = await get(undefined, '2026-12-31')
    expect(res.status).toBe(422)
  })

  it('422s when to is missing', async () => {
    const res = await get('2026-01-01', undefined)
    expect(res.status).toBe(422)
  })

  it('422s when from is not a valid date', async () => {
    const res = await get('not-a-date', '2026-12-31')
    expect(res.status).toBe(422)
  })

  it('422s when to is not a valid date', async () => {
    const res = await get('2026-01-01', '2026-13-01')
    expect(res.status).toBe(422)
  })

  it('422s when from > to', async () => {
    const res = await get('2026-12-31', '2026-01-01')
    expect(res.status).toBe(422)
  })

  it('422s when the window exceeds 3 years', async () => {
    const res = await get('2020-01-01', '2025-12-31')
    expect(res.status).toBe(422)
  })

  it('returns 11 holidays for a full year sorted by observedDate', async () => {
    const res = await get('2026-01-01', '2026-12-31')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { holidays: Array<{ id: string; observedDate: string }> }
    expect(body.holidays).toHaveLength(11)
    // Sorted by observedDate
    for (let i = 1; i < body.holidays.length; i++) {
      expect(body.holidays[i]!.observedDate >= body.holidays[i - 1]!.observedDate).toBe(true)
    }
    // Independence Day 2026 = Saturday → observed Friday July 3
    const independence = body.holidays.find((h) => h.id === 'us-federal:independence')
    expect(independence).toBeDefined()
    expect(independence!.observedDate).toBe('2026-07-03')
  })
})
