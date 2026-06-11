import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'

// D1 integration tests for the /api/v1/sdk/money/** surface.
// Replaces sdk-money.it.test.ts.

const noopObjectStore: Services['objectStore'] = {
  async put() {
    throw new Error('sdk tests do not call objectStore')
  },
  async get() {
    throw new Error('sdk tests do not call objectStore')
  },
  async headObject() {
    return null
  },
  async deleteObject() {},
}

describe('D1 integration — SDK money surface', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>
  let apiKey: string

  const services: Services = {
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: async () => {},
    },
    rpidSso: {
      exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
    },
    settings: {
      get: async () => ({}),
      patch: async (_u, _n, p) => p,
    },
    objectStore: noopObjectStore,
  }

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    apiKey = envVars.EVENTS_API_KEY
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })

  async function sdk(method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  it('returns 403 when the SDK key is wrong', async () => {
    const res = await app.request('http://localhost/api/v1/sdk/money/ledgers?scope_type=group&scope_id=c1', {
      headers: { authorization: 'Bearer wrong-key' },
    })
    expect(res.status).toBe(403)
  })

  it('ensure-for-group creates a ledger on first call (201, created:true)', async () => {
    const groupId = `group_${Date.now()}_first`
    const owner = `user_${Date.now()}_first`
    const res = await sdk('POST', '/api/v1/sdk/money/ledgers/ensure-for-group', {
      scopeId: groupId,
      ownerUserId: owner,
      name: 'Group expenses',
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; scopeType: string; scopeId: string; created: boolean; currency: string }
    expect(body.id).toMatch(/^led_/)
    expect(body.scopeType).toBe('group')
    expect(body.scopeId).toBe(groupId)
    expect(body.created).toBe(true)
    expect(body.currency).toBe('USD')
  })

  it('ensure-for-group is idempotent on replay (200, created:false, same id)', async () => {
    const groupId = `group_${Date.now()}_replay`
    const owner = `user_${Date.now()}_replay`
    const first = (await (await sdk('POST', '/api/v1/sdk/money/ledgers/ensure-for-group', {
      scopeId: groupId,
      ownerUserId: owner,
    })).json()) as { id: string }

    // Second call (even with different ownerUserId) returns the original.
    const replayRes = await sdk('POST', '/api/v1/sdk/money/ledgers/ensure-for-group', {
      scopeId: groupId,
      ownerUserId: `user_${Date.now()}_other`,
    })
    expect(replayRes.status).toBe(200)
    const replay = (await replayRes.json()) as { id: string; created: boolean; ownerUserId: string }
    expect(replay.id).toBe(first.id)
    expect(replay.created).toBe(false)
    expect(replay.ownerUserId).toBe(owner) // original owner preserved
  })

  it('honours optional currency on first-create only', async () => {
    const groupId = `group_${Date.now()}_ccy`
    const owner = `user_${Date.now()}_ccy`
    const first = (await (await sdk('POST', '/api/v1/sdk/money/ledgers/ensure-for-group', {
      scopeId: groupId,
      ownerUserId: owner,
      currency: 'EUR',
    })).json()) as { id: string; currency: string }
    expect(first.currency).toBe('EUR')

    // Replay with a different currency must not change it.
    const replay = (await (await sdk('POST', '/api/v1/sdk/money/ledgers/ensure-for-group', {
      scopeId: groupId,
      ownerUserId: owner,
      currency: 'JPY',
    })).json()) as { id: string; currency: string }
    expect(replay.id).toBe(first.id)
    expect(replay.currency).toBe('EUR')
  })

  it('GET /sdk/money/ledgers lists matches for a scope (flat camelCase DTO)', async () => {
    const groupId = `group_${Date.now()}_list`
    const owner = `user_${Date.now()}_list`
    await sdk('POST', '/api/v1/sdk/money/ledgers/ensure-for-group', {
      scopeId: groupId,
      ownerUserId: owner,
    })
    const res = await sdk('GET', `/api/v1/sdk/money/ledgers?scope_type=group&scope_id=${groupId}`)
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Array<{
      id: string
      scopeType: string
      scopeId: string
      currency: string
      ownerUserId: string
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.scopeType).toBe('group')
    expect(rows[0]!.scopeId).toBe(groupId)
    expect(rows[0]!.ownerUserId).toBe(owner)
  })

  it('GET /sdk/money/ledgers/:id/expenses 404s a missing ledger', async () => {
    const res = await sdk('GET', '/api/v1/sdk/money/ledgers/led_missing/expenses')
    expect(res.status).toBe(404)
  })

  it('GET /sdk/money/ledgers/:id/balances requires viewer_user_id (400)', async () => {
    const groupId = `group_${Date.now()}_balgate`
    const owner = `user_${Date.now()}_balgate`
    const led = (await (await sdk('POST', '/api/v1/sdk/money/ledgers/ensure-for-group', {
      scopeId: groupId,
      ownerUserId: owner,
    })).json()) as { id: string }
    const res = await sdk('GET', `/api/v1/sdk/money/ledgers/${led.id}/balances`)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation_failed')
  })

  it('GET /sdk/money/ledgers/:id/balances returns an empty items array for a fresh ledger', async () => {
    const groupId = `group_${Date.now()}_empty_bal`
    const owner = `user_${Date.now()}_empty_bal`
    const led = (await (await sdk('POST', '/api/v1/sdk/money/ledgers/ensure-for-group', {
      scopeId: groupId,
      ownerUserId: owner,
    })).json()) as { id: string; currency: string }

    const res = await sdk('GET', `/api/v1/sdk/money/ledgers/${led.id}/balances?viewer_user_id=${owner}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ledgerId: string; currency: string; viewerUserId: string; items: unknown[] }
    expect(body.ledgerId).toBe(led.id)
    expect(body.currency).toBe(led.currency)
    expect(body.viewerUserId).toBe(owner)
    expect(body.items).toEqual([])
  })

  it('rejects a malformed scope_type on the list endpoint (400)', async () => {
    const res = await sdk('GET', '/api/v1/sdk/money/ledgers?scope_type=bogus&scope_id=x')
    expect(res.status).toBe(400)
  })
})
