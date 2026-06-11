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

// D1 integration tests for the settlement surface + balance reduction.
// Replaces settlements.it.test.ts.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — settlements', () => {
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

  async function setupLedger(
    ownerBearer: string,
    owner: string,
    member?: string,
  ): Promise<string> {
    const created = (await (await req(ownerBearer, 'POST', '/api/v1/ui/ledgers', {
      name: 'Settlement test',
      currency: 'USD',
      scopeType: 'personal',
      scopeId: owner,
    })).json()) as { id: string }
    if (member) {
      await repos.ledgerMembers.add({
        id: `lmm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ledgerId: created.id,
        userId: member,
        role: 'member',
      })
    }
    return created.id
  }

  it('records a settlement, persists the row, and lists it back', async () => {
    const owner = `user_${Date.now()}_stl_owner`
    const ownerBearer = await loginAs(owner)
    const peer = `user_${Date.now()}_stl_peer`
    const ledgerId = await setupLedger(ownerBearer, owner, peer)

    const createRes = await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/settlements`, {
      fromUserId: peer,
      toUserId: owner,
      amountCents: 2500,
      note: 'Venmo',
      settledAt: '2026-05-31',
    })
    expect(createRes.status).toBe(201)
    const settlement = (await createRes.json()) as Record<string, unknown> & { id: string }
    expect(settlement.id).toMatch(/^stl_/)
    expect(settlement.from_user_id).toBe(peer)
    expect(settlement.to_user_id).toBe(owner)
    expect(settlement.amount_cents).toBe(2500)
    expect(settlement.note).toBe('Venmo')
    expect(settlement.settled_at).toBe('2026-05-31')
    expect(settlement.created_by).toBe(owner)

    const list = (await (await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/settlements`)).json()) as { items: Array<{ id: string }> }
    expect(list.items).toHaveLength(1)
    expect(list.items[0]!.id).toBe(settlement.id)
  })

  it('reduces an outstanding balance: peer→owner settlement after an owner-paid expense', async () => {
    const owner = `user_${Date.now()}_balstl_owner`
    const ownerBearer = await loginAs(owner)
    const peer = `user_${Date.now()}_balstl_peer`
    const peerBearer = await loginAs(peer)
    const ledgerId = await setupLedger(ownerBearer, owner, peer)

    // Owner paid $100 evenly with peer → peer owes owner $50.
    await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/expenses`, {
      paidByUserId: owner,
      totalCents: 100,
      description: 'Dinner',
      splitMode: 'equal',
      spentAt: '2026-05-30',
      splits: [{ userId: owner }, { userId: peer }],
    })

    // Balance before settlement: owner sees peer owes 50.
    let bal = (await (await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/balances`)).json()) as { items: Array<{ net_cents: number }> }
    expect(bal.items[0]!.net_cents).toBe(50)

    // Peer pays $30 of it.
    await req(peerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/settlements`, {
      fromUserId: peer,
      toUserId: owner,
      amountCents: 30,
      settledAt: '2026-05-31',
    })

    // After: owner sees peer owes 20.
    bal = (await (await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/balances`)).json()) as { items: Array<{ net_cents: number }> }
    expect(bal.items[0]!.net_cents).toBe(20)

    // And from peer's POV: peer owes owner 20 (sign flipped).
    bal = (await (await req(peerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/balances`)).json()) as { items: Array<{ net_cents: number }> }
    expect(bal.items[0]!.net_cents).toBe(-20)
  })

  it('a settlement that exactly cancels the debt zeroes the balance row (still present, just 0)', async () => {
    const owner = `user_${Date.now()}_zero_owner`
    const ownerBearer = await loginAs(owner)
    const peer = `user_${Date.now()}_zero_peer`
    const peerBearer = await loginAs(peer)
    const ledgerId = await setupLedger(ownerBearer, owner, peer)

    await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/expenses`, {
      paidByUserId: owner,
      totalCents: 40,
      description: 'Coffee',
      splitMode: 'equal',
      spentAt: '2026-05-30',
      splits: [{ userId: owner }, { userId: peer }],
    })
    await req(peerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/settlements`, {
      fromUserId: peer,
      toUserId: owner,
      amountCents: 20,
      settledAt: '2026-05-31',
    })
    const bal = (await (await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/balances`)).json()) as { items: Array<{ user_id: string; net_cents: number }> }
    expect(bal.items).toEqual([{ user_id: peer, net_cents: 0 }])
  })

  it('rejects a settlement whose from_user_id isn\'t a ledger member', async () => {
    const owner = `user_${Date.now()}_inv_owner`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await setupLedger(ownerBearer, owner)

    const res = await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/settlements`, {
      fromUserId: 'user_outsider',
      toUserId: owner,
      amountCents: 100,
      settledAt: '2026-05-31',
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; details?: Record<string, unknown> } }
    expect(body.error.code).toBe('settlement_invalid')
    expect(body.error.details?.violation).toBe('from_not_member')
  })

  it('rejects same-user settlement at the validator boundary', async () => {
    const owner = `user_${Date.now()}_same_owner`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await setupLedger(ownerBearer, owner)

    const res = await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/settlements`, {
      fromUserId: owner,
      toUserId: owner,
      amountCents: 100,
      settledAt: '2026-05-31',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation_failed')
  })

  it('rejects a non-member trying to record or list settlements (404)', async () => {
    const owner = `user_${Date.now()}_acl_owner`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await setupLedger(ownerBearer, owner)

    const stranger = `user_${Date.now()}_acl_stranger`
    const strangerBearer = await loginAs(stranger)
    const list = await req(strangerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/settlements`)
    expect(list.status).toBe(404)
    const post = await req(strangerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/settlements`, {
      fromUserId: owner,
      toUserId: stranger,
      amountCents: 50,
      settledAt: '2026-05-31',
    })
    expect(post.status).toBe(404)
  })

  it('deletes a settlement (hard delete) and the balance reverts', async () => {
    const owner = `user_${Date.now()}_del_owner`
    const ownerBearer = await loginAs(owner)
    const peer = `user_${Date.now()}_del_peer`
    const peerBearer = await loginAs(peer)
    const ledgerId = await setupLedger(ownerBearer, owner, peer)

    await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/expenses`, {
      paidByUserId: owner,
      totalCents: 100,
      description: 'Brunch',
      splitMode: 'equal',
      spentAt: '2026-05-30',
      splits: [{ userId: owner }, { userId: peer }],
    })
    const settlement = (await (await req(peerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/settlements`, {
      fromUserId: peer,
      toUserId: owner,
      amountCents: 50,
      settledAt: '2026-05-31',
    })).json()) as { id: string }

    // After settlement: balance is zero.
    let bal = (await (await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/balances`)).json()) as { items: Array<{ net_cents: number }> }
    expect(bal.items[0]!.net_cents).toBe(0)

    // Delete the settlement → balance reverts to 50.
    const del = await req(ownerBearer, 'DELETE', `/api/v1/ui/ledgers/${ledgerId}/settlements/${settlement.id}`)
    expect(del.status).toBe(204)
    bal = (await (await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/balances`)).json()) as { items: Array<{ net_cents: number }> }
    expect(bal.items[0]!.net_cents).toBe(50)

    // Activity log captures both events.
    const activity = (await (await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/activity`)).json()) as { items: Array<{ event_type: string }> }
    expect(activity.items.some((a) => a.event_type === 'settlement.recorded')).toBe(true)
    expect(activity.items.some((a) => a.event_type === 'settlement.deleted')).toBe(true)
  })
})
