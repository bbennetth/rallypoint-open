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

// D1 integration tests for the expense CRUD + balances surface.
// Replaces expenses.it.test.ts.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — expenses + balances', () => {
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

  // Create a ledger + add a single member directly to it.
  async function setupLedger(ownerBearer: string, owner: string, member?: string): Promise<string> {
    const created = await (await req(ownerBearer, 'POST', '/api/v1/ui/ledgers', {
      name: 'Expense test',
      currency: 'USD',
      scopeType: 'personal',
      scopeId: owner,
    })).json() as { id: string }
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

  it('creates an equal expense, persists splits, lists it back', async () => {
    const owner = `user_${Date.now()}_exp_owner`
    const ownerBearer = await loginAs(owner)
    const peer = `user_${Date.now()}_exp_peer`
    const ledgerId = await setupLedger(ownerBearer, owner, peer)

    const createRes = await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/expenses`, {
      paidByUserId: owner,
      totalCents: 99,
      description: 'Pizza',
      splitMode: 'equal',
      spentAt: '2026-05-30',
      splits: [{ userId: owner }, { userId: peer }],
    })
    expect(createRes.status).toBe(201)
    const expense = (await createRes.json()) as Record<string, unknown> & {
      id: string
      splits: Array<{ user_id: string }>
    }
    expect(expense.id).toMatch(/^exp_/)
    expect(expense.total_cents).toBe(99)
    expect(expense.split_mode).toBe('equal')
    expect(expense.splits.map((s) => s.user_id).sort()).toEqual([owner, peer].sort())

    // List comes back with the same expense.
    const list = (await (await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/expenses`)).json()) as { items: Array<{ id: string }> }
    expect(list.items).toHaveLength(1)
    expect(list.items[0]!.id).toBe(expense.id)
  })

  it('rejects an expense whose paid_by isn\'t a ledger member', async () => {
    const owner = `user_${Date.now()}_paid_owner`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await setupLedger(ownerBearer, owner)

    const res = await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/expenses`, {
      paidByUserId: 'user_outsider',
      totalCents: 100,
      description: 'Sketchy',
      splitMode: 'equal',
      spentAt: '2026-05-30',
      splits: [{ userId: owner }],
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; details?: Record<string, unknown> } }
    expect(body.error.code).toBe('split_invalid')
    expect(body.error.details?.violation).toBe('paid_by_not_member')
  })

  it('rejects a by_amount expense whose sums don\'t match the total', async () => {
    const owner = `user_${Date.now()}_byamt_owner`
    const ownerBearer = await loginAs(owner)
    const peer = `user_${Date.now()}_byamt_peer`
    const ledgerId = await setupLedger(ownerBearer, owner, peer)

    const res = await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/expenses`, {
      paidByUserId: owner,
      totalCents: 100,
      description: 'Off by ten',
      splitMode: 'by_amount',
      spentAt: '2026-05-30',
      splits: [
        { userId: owner, amountCents: 50 },
        { userId: peer, amountCents: 40 },
      ],
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; details?: Record<string, unknown> } }
    expect(body.error.code).toBe('split_invalid')
    expect(body.error.details?.violation).toBe('by_amount_sum_mismatch')
  })

  it('computes balances from the viewer POV across multiple expenses', async () => {
    const owner = `user_${Date.now()}_bal_owner`
    const ownerBearer = await loginAs(owner)
    const peer = `user_${Date.now()}_bal_peer`
    const peerBearer = await loginAs(peer)
    const ledgerId = await setupLedger(ownerBearer, owner, peer)

    // Owner paid $60 evenly with peer → peer owes owner 30.
    await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/expenses`, {
      paidByUserId: owner,
      totalCents: 60,
      description: 'Coffee',
      splitMode: 'equal',
      spentAt: '2026-05-30',
      splits: [{ userId: owner }, { userId: peer }],
    })
    // Peer paid $20 evenly with owner → owner owes peer 10.
    await req(peerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/expenses`, {
      paidByUserId: peer,
      totalCents: 20,
      description: 'Pretzel',
      splitMode: 'equal',
      spentAt: '2026-05-30',
      splits: [{ userId: owner }, { userId: peer }],
    })

    // From owner's POV: peer owes owner 30 - 10 = 20.
    const ownerBal = (await (await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/balances`)).json()) as {
      items: Array<{ user_id: string; net_cents: number }>
    }
    expect(ownerBal.items).toEqual([{ user_id: peer, net_cents: 20 }])

    // From peer's POV: peer owes owner 20 (sign flipped).
    const peerBal = (await (await req(peerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/balances`)).json()) as {
      items: Array<{ user_id: string; net_cents: number }>
    }
    expect(peerBal.items).toEqual([{ user_id: owner, net_cents: -20 }])
  })

  // Indivisible totals: equal-split sorts participants by userId asc, then
  // largestRemainder hands the leftover penny to the lowest index. The userIds
  // below are prefixed user_a / user_b / user_c so the allocation is
  // deterministic regardless of timestamp. Balances are order-independent, so
  // we assert against a {userId: net_cents} map.
  it('splits an indivisible total via largest-remainder; payer absorbs the extra cent', async () => {
    const ts = Date.now()
    const owner = `user_a_${ts}_odd3_owner`
    const p2 = `user_b_${ts}_odd3_p2`
    const p3 = `user_c_${ts}_odd3_p3`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await setupLedger(ownerBearer, owner, p2)
    await repos.ledgerMembers.add({
      id: `lmm_${ts}_odd3_p3`,
      ledgerId,
      userId: p3,
      role: 'member',
    })

    // Owner pays $1.00 split 3 ways → largestRemainder(100,[1,1,1]) = [34,33,33]
    // to the sorted ids [owner(a), p2(b), p3(c)]. Owner (payer) takes 34, so the
    // other two owe exactly 33 each — no pennies lost.
    const res = await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/expenses`, {
      paidByUserId: owner,
      totalCents: 100,
      description: 'Dinner',
      splitMode: 'equal',
      spentAt: '2026-05-30',
      splits: [{ userId: owner }, { userId: p2 }, { userId: p3 }],
    })
    expect(res.status).toBe(201)

    const bal = (await (await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/balances`)).json()) as {
      items: Array<{ user_id: string; net_cents: number }>
    }
    const byUser = Object.fromEntries(bal.items.map((i) => [i.user_id, i.net_cents]))
    expect(byUser).toEqual({ [p2]: 33, [p3]: 33 })
  })

  it('gives the rounding cent to the lowest-sorted id, not the payer', async () => {
    const ts = Date.now()
    // 'a' < 'z' → `other` sorts first and receives the extra cent even though
    // `payer` paid, proving the payer doesn't always get the rounding benefit.
    const payer = `user_z_${ts}_odd2_payer`
    const other = `user_a_${ts}_odd2_other`
    const payerBearer = await loginAs(payer)
    const ledgerId = await setupLedger(payerBearer, payer, other)

    // Payer pays 99¢ split 2 ways → largestRemainder(99,[1,1]) = [50,49] to the
    // sorted ids [other(a), payer(z)]. `other` owes the larger half (50).
    const res = await req(payerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/expenses`, {
      paidByUserId: payer,
      totalCents: 99,
      description: 'Cab',
      splitMode: 'equal',
      spentAt: '2026-05-30',
      splits: [{ userId: payer }, { userId: other }],
    })
    expect(res.status).toBe(201)

    const bal = (await (await req(payerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/balances`)).json()) as {
      items: Array<{ user_id: string; net_cents: number }>
    }
    const byUser = Object.fromEntries(bal.items.map((i) => [i.user_id, i.net_cents]))
    expect(byUser).toEqual({ [other]: 50 })
  })

  it('patches description + spentAt (member+) and records activity', async () => {
    const owner = `user_${Date.now()}_pat_owner`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await setupLedger(ownerBearer, owner)

    const created = (await (await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/expenses`, {
      paidByUserId: owner,
      totalCents: 50,
      description: 'Tea',
      splitMode: 'equal',
      spentAt: '2026-05-30',
      splits: [{ userId: owner }],
    })).json()) as { id: string }

    const patch = await req(ownerBearer, 'PATCH', `/api/v1/ui/ledgers/${ledgerId}/expenses/${created.id}`, {
      description: 'Tea + biscuit',
      spentAt: '2026-05-31',
    })
    expect(patch.status).toBe(200)
    const patched = (await patch.json()) as { description: string; spent_at: string }
    expect(patched.description).toBe('Tea + biscuit')
    expect(patched.spent_at).toBe('2026-05-31')

    const activity = (await (await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/activity`)).json()) as {
      items: Array<{ event_type: string }>
    }
    expect(activity.items.some((a) => a.event_type === 'expense.patched')).toBe(true)
  })

  it('soft-deletes an expense and drops it from the listing + balances', async () => {
    const owner = `user_${Date.now()}_del_owner`
    const ownerBearer = await loginAs(owner)
    const peer = `user_${Date.now()}_del_peer`
    const ledgerId = await setupLedger(ownerBearer, owner, peer)

    const created = (await (await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/expenses`, {
      paidByUserId: owner,
      totalCents: 60,
      description: 'Gas',
      splitMode: 'equal',
      spentAt: '2026-05-30',
      splits: [{ userId: owner }, { userId: peer }],
    })).json()) as { id: string }

    // Before delete: peer owes owner 30.
    let bal = (await (await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/balances`)).json()) as { items: Array<{ net_cents: number }> }
    expect(bal.items[0]!.net_cents).toBe(30)

    const del = await req(ownerBearer, 'DELETE', `/api/v1/ui/ledgers/${ledgerId}/expenses/${created.id}`)
    expect(del.status).toBe(204)

    // After delete: balance is empty.
    bal = (await (await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/balances`)).json()) as { items: unknown[] }
    expect(bal.items).toHaveLength(0)
  })

  it('rejects a non-member trying to read expenses with 404', async () => {
    const owner = `user_${Date.now()}_acl_owner`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await setupLedger(ownerBearer, owner)

    const stranger = `user_${Date.now()}_acl_stranger`
    const strangerBearer = await loginAs(stranger)
    const res = await req(strangerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/expenses`)
    expect(res.status).toBe(404)
  })
})
