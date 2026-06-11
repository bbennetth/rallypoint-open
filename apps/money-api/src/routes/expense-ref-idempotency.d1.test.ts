import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { MONEY_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 integration tests for the ref-bearing expense + idempotency surface.
// Replaces expense-ref-idempotency.it.test.ts.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — expense ref + idempotent create', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

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
  }

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })

  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(MONEY_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { MONEY_SESSION_KEY_V1: envVars.MONEY_SESSION_KEY_V1 },
      keyVersion: envVars.MONEY_SESSION_KEY_VERSION,
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
      cookie: `${envVars.MONEY_SESSION_COOKIE_NAME}=${bearer}; ${envVars.MONEY_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      'content-type': 'application/json',
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

  async function createLedger(bearer: string, owner: string): Promise<string> {
    const created = (await (await req(bearer, 'POST', '/api/v1/ui/ledgers', {
      name: 'Ref test',
      currency: 'USD',
      scopeType: 'personal',
      scopeId: owner,
    })).json()) as { id: string }
    return created.id
  }

  const expensePayload = (owner: string, overrides: Record<string, unknown> = {}) => ({
    paidByUserId: owner,
    totalCents: 100,
    description: 'Cascade test',
    splitMode: 'equal',
    spentAt: '2026-05-30',
    splits: [{ userId: owner }],
    ...overrides,
  })

  it('persists ref on create and echoes it back', async () => {
    const owner = `user_${Date.now()}_ref_owner`
    const bearer = await loginAs(owner)
    const ledgerId = await createLedger(bearer, owner)

    const res = await req(
      bearer,
      'POST',
      `/api/v1/ui/ledgers/${ledgerId}/expenses`,
      expensePayload(owner, { ref: 'lists:purchase:abc123' }),
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; ref: string; idempotent?: boolean }
    expect(body.id).toMatch(/^exp_/)
    expect(body.ref).toBe('lists:purchase:abc123')
    expect(body.idempotent).toBeUndefined()
  })

  it('replay with the same (ledger_id, ref) returns the existing row (200, idempotent:true)', async () => {
    const owner = `user_${Date.now()}_idem_owner`
    const bearer = await loginAs(owner)
    const ledgerId = await createLedger(bearer, owner)

    const first = (await (await req(
      bearer,
      'POST',
      `/api/v1/ui/ledgers/${ledgerId}/expenses`,
      expensePayload(owner, { ref: 'cascade:42', description: 'First' }),
    )).json()) as { id: string }

    const replayRes = await req(
      bearer,
      'POST',
      `/api/v1/ui/ledgers/${ledgerId}/expenses`,
      expensePayload(owner, { ref: 'cascade:42', description: 'Second' }),
    )
    expect(replayRes.status).toBe(200)
    const replay = (await replayRes.json()) as { id: string; description: string; idempotent: boolean }
    expect(replay.id).toBe(first.id)
    expect(replay.idempotent).toBe(true)
    // The original description wins — the second body's `description`
    // is ignored. Ref pins the first writer.
    expect(replay.description).toBe('First')

    const list = (await (await req(bearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/expenses`)).json()) as { items: unknown[] }
    expect(list.items).toHaveLength(1)
  })

  it('different refs in the same ledger create distinct rows', async () => {
    const owner = `user_${Date.now()}_distinct_owner`
    const bearer = await loginAs(owner)
    const ledgerId = await createLedger(bearer, owner)

    await req(bearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/expenses`, expensePayload(owner, { ref: 'a' }))
    await req(bearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/expenses`, expensePayload(owner, { ref: 'b' }))

    const list = (await (await req(bearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/expenses`)).json()) as { items: unknown[] }
    expect(list.items).toHaveLength(2)
  })

  it('same ref in two different ledgers does NOT collide (scoped per ledger)', async () => {
    const owner = `user_${Date.now()}_scoped_owner`
    const bearer = await loginAs(owner)
    const ledgerA = await createLedger(bearer, owner)
    const ledgerB = await createLedger(bearer, owner)

    const a = await req(bearer, 'POST', `/api/v1/ui/ledgers/${ledgerA}/expenses`, expensePayload(owner, { ref: 'shared' }))
    const b = await req(bearer, 'POST', `/api/v1/ui/ledgers/${ledgerB}/expenses`, expensePayload(owner, { ref: 'shared' }))
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
  })

  it('expenses without a ref are unconstrained — same body twice creates two rows', async () => {
    const owner = `user_${Date.now()}_noref_owner`
    const bearer = await loginAs(owner)
    const ledgerId = await createLedger(bearer, owner)

    await req(bearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/expenses`, expensePayload(owner))
    await req(bearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/expenses`, expensePayload(owner))

    const list = (await (await req(bearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/expenses`)).json()) as { items: unknown[] }
    expect(list.items).toHaveLength(2)
  })

  it('after soft-delete, the ref is reserved — POST with the same ref returns 409', async () => {
    const owner = `user_${Date.now()}_tomb_owner`
    const bearer = await loginAs(owner)
    const ledgerId = await createLedger(bearer, owner)

    const created = (await (await req(
      bearer,
      'POST',
      `/api/v1/ui/ledgers/${ledgerId}/expenses`,
      expensePayload(owner, { ref: 'doomed' }),
    )).json()) as { id: string }
    expect((await req(bearer, 'DELETE', `/api/v1/ui/ledgers/${ledgerId}/expenses/${created.id}`)).status).toBe(204)

    const replay = await req(
      bearer,
      'POST',
      `/api/v1/ui/ledgers/${ledgerId}/expenses`,
      expensePayload(owner, { ref: 'doomed' }),
    )
    expect(replay.status).toBe(409)
    const body = (await replay.json()) as { error: { code: string; details: Record<string, unknown> } }
    expect(body.error.code).toBe('expense_ref_taken_by_deleted')
    expect(body.error.details.expense_id).toBe(created.id)
    expect(body.error.details.ref).toBe('doomed')
    expect(typeof body.error.details.deleted_at).toBe('string')
  })

  it('rejects an empty-string ref at the validator boundary', async () => {
    const owner = `user_${Date.now()}_empty_owner`
    const bearer = await loginAs(owner)
    const ledgerId = await createLedger(bearer, owner)

    const res = await req(
      bearer,
      'POST',
      `/api/v1/ui/ledgers/${ledgerId}/expenses`,
      expensePayload(owner, { ref: '   ' }),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation_failed')
  })
})
