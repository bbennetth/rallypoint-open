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

// D1 integration tests for the ledgers UI surface.
// Replaces ledgers.it.test.ts. Runs inside a workerd isolate (Miniflare D1),
// migrations applied by apps/money-api/test/apply-d1-migrations.ts.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — ledgers UI surface', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  // Stubbed services: the verifier trusts any bearer and returns it
  // verbatim as the user id (we seal plaintext=userId into the row).
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

  it('returns ok from the public health route', async () => {
    const res = await app.request('http://localhost/api/v1/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; service: string }
    expect(body.ok).toBe(true)
    expect(body.service).toBe('rallypoint-money')
  })

  it('rejects an unauthenticated request to the ledgers surface', async () => {
    const res = await app.request('http://localhost/api/v1/ui/ledgers', {
      headers: { 'x-rp-csrf': CSRF, cookie: `${envVars.MONEY_CSRF_COOKIE_NAME}=${CSRF}` },
    })
    expect(res.status).toBe(401)
  })

  it('creates a ledger, persists the row, and lists it back', async () => {
    const owner = `user_${Date.now()}_owner`
    const bearer = await loginAs(owner)
    const scopeId = `group_${Date.now()}`

    const createRes = await req(bearer, 'POST', '/api/v1/ui/ledgers', {
      name: '  Camp expenses  ',
      currency: 'USD',
      scopeType: 'group',
      scopeId,
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as Record<string, unknown>
    expect(created.id).toMatch(/^led_/)
    expect(created.name).toBe('Camp expenses') // trimmed by the validator
    expect(created.currency).toBe('USD')
    expect(created.scope_type).toBe('group')
    expect(created.scope_id).toBe(scopeId)
    expect(created.owner_user_id).toBe(owner)
    expect(created.description).toBeNull()

    // Round-trip: the DB row exists.
    const row = await repos.ledgers.findById(created.id as string)
    expect(row).not.toBeNull()
    expect(row!.scopeId).toBe(scopeId)
    expect(row!.ownerUserId).toBe(owner)

    // And it comes back from the owner listing.
    const listRes = await req(bearer, 'GET', '/api/v1/ui/ledgers')
    expect(listRes.status).toBe(200)
    const page = (await listRes.json()) as { items: Array<Record<string, unknown>> }
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.id).toBe(created.id)
  })

  it('creates a personal ledger with a description', async () => {
    const owner = `user_${Date.now()}_personal`
    const bearer = await loginAs(owner)

    const createRes = await req(bearer, 'POST', '/api/v1/ui/ledgers', {
      name: 'My Finances',
      currency: 'EUR',
      scopeType: 'personal',
      scopeId: owner,
      description: 'Personal expense tracking',
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as Record<string, unknown>
    expect(created.id).toMatch(/^led_/)
    expect(created.currency).toBe('EUR')
    expect(created.description).toBe('Personal expense tracking')

    // The DB row holds the description.
    const row = await repos.ledgers.findById(created.id as string)
    expect(row!.description).toBe('Personal expense tracking')
  })

  it('rejects an invalid create body with validation_failed', async () => {
    const bearer = await loginAs(`user_${Date.now()}_bad`)
    const res = await req(bearer, 'POST', '/api/v1/ui/ledgers', {
      name: '   ',
      currency: 'BOGUS',
      scopeType: 'group',
      scopeId: 'group_x',
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('validation_failed')
  })

  it('isolates ledgers between users (each user sees only their own)', async () => {
    const alice = `user_${Date.now()}_alice`
    const bob = `user_${Date.now()}_bob`
    const aliceBearer = await loginAs(alice)
    const bobBearer = await loginAs(bob)

    await req(aliceBearer, 'POST', '/api/v1/ui/ledgers', {
      name: 'Alice ledger',
      currency: 'CAD',
      scopeType: 'personal',
      scopeId: alice,
    })
    await req(bobBearer, 'POST', '/api/v1/ui/ledgers', {
      name: 'Bob ledger',
      currency: 'GBP',
      scopeType: 'personal',
      scopeId: bob,
    })

    const aliceList = (await (await req(aliceBearer, 'GET', '/api/v1/ui/ledgers')).json()) as { items: Array<Record<string, unknown>> }
    const bobList = (await (await req(bobBearer, 'GET', '/api/v1/ui/ledgers')).json()) as { items: Array<Record<string, unknown>> }

    // Alice and Bob each only see their own ledger(s).
    expect(aliceList.items.every((l) => l.owner_user_id === alice)).toBe(true)
    expect(bobList.items.every((l) => l.owner_user_id === bob)).toBe(true)
  })

  it('patches name + description, records activity, and 404s a non-owner patch', async () => {
    const owner = `user_${Date.now()}_patcher`
    const ownerBearer = await loginAs(owner)
    const stranger = `user_${Date.now()}_stranger`
    const strangerBearer = await loginAs(stranger)

    const created = await (await req(ownerBearer, 'POST', '/api/v1/ui/ledgers', {
      name: 'Camp',
      currency: 'USD',
      scopeType: 'personal',
      scopeId: owner,
    })).json() as { id: string }

    const patchRes = await req(ownerBearer, 'PATCH', `/api/v1/ui/ledgers/${created.id}`, {
      name: 'Camp 2026',
      description: 'shared expenses',
    })
    expect(patchRes.status).toBe(200)
    const patched = (await patchRes.json()) as Record<string, unknown>
    expect(patched.name).toBe('Camp 2026')
    expect(patched.description).toBe('shared expenses')

    // Activity log records the patch.
    const activityRes = await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${created.id}/activity`)
    expect(activityRes.status).toBe(200)
    const activity = (await activityRes.json()) as { items: Array<{ event_type: string }> }
    expect(activity.items.some((a) => a.event_type === 'ledger.patched')).toBe(true)

    // Stranger gets a 404 — both for the patch and for the activity feed.
    const strangerPatch = await req(strangerBearer, 'PATCH', `/api/v1/ui/ledgers/${created.id}`, {
      name: 'Hijacked',
    })
    expect(strangerPatch.status).toBe(404)
  })

  it('soft-deletes a ledger (owner only) and tombstones the row', async () => {
    const owner = `user_${Date.now()}_delete`
    const bearer = await loginAs(owner)

    const created = await (await req(bearer, 'POST', '/api/v1/ui/ledgers', {
      name: 'To delete',
      currency: 'USD',
      scopeType: 'personal',
      scopeId: owner,
    })).json() as { id: string }

    const delRes = await req(bearer, 'DELETE', `/api/v1/ui/ledgers/${created.id}`)
    expect(delRes.status).toBe(204)

    // GET on the soft-deleted ledger now 404s.
    const detail = await req(bearer, 'GET', `/api/v1/ui/ledgers/${created.id}`)
    expect(detail.status).toBe(404)

    // The DB row still exists but has deletedAt set.
    const row = await repos.ledgers.findById(created.id)
    expect(row).not.toBeNull()
    expect(row!.deletedAt).not.toBeNull()

    // List view no longer surfaces it.
    const list = (await (await req(bearer, 'GET', '/api/v1/ui/ledgers')).json()) as { items: Array<{ id: string }> }
    expect(list.items.find((l) => l.id === created.id)).toBeUndefined()
  })

  it('lists members for a ledger after a direct member-add (no invite flow yet)', async () => {
    const owner = `user_${Date.now()}_membase`
    const ownerBearer = await loginAs(owner)
    const peer = `user_${Date.now()}_peer`

    const led = await (await req(ownerBearer, 'POST', '/api/v1/ui/ledgers', {
      name: 'With member',
      currency: 'USD',
      scopeType: 'personal',
      scopeId: owner,
    })).json() as { id: string }

    // Inject a member directly through the repo — the public path
    // (invite + accept) is covered by ledger-invites.d1.test.ts.
    const memberId = `lmm_${Date.now()}`
    await repos.ledgerMembers.add({
      id: memberId,
      ledgerId: led.id,
      userId: peer,
      role: 'member',
    })

    const membersRes = await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${led.id}/members`)
    expect(membersRes.status).toBe(200)
    const members = (await membersRes.json()) as { items: Array<{ user_id: string; role: string }> }
    expect(members.items).toHaveLength(1)
    expect(members.items[0]!.user_id).toBe(peer)
    expect(members.items[0]!.role).toBe('member')
  })
})
