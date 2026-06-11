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

// D1 integration tests for the ledger-groups surface (Money-local groups).
// Replaces ledger-groups.it.test.ts.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — ledger groups', () => {
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

  it('creates a group, auto-enrols the creator as owner, lists it back', async () => {
    const creator = `user_${Date.now()}_grp_creator`
    const bearer = await loginAs(creator)

    const createRes = await req(bearer, 'POST', '/api/v1/ui/ledger-groups', {
      name: '  Roomies  ',
      description: 'Shared apartment expenses',
    })
    expect(createRes.status).toBe(201)
    const group = (await createRes.json()) as { id: string; name: string; description: string }
    expect(group.id).toMatch(/^lgr_/)
    expect(group.name).toBe('Roomies')
    expect(group.description).toBe('Shared apartment expenses')

    // The creator can list their groups.
    const list = (await (await req(bearer, 'GET', '/api/v1/ui/ledger-groups')).json()) as { items: Array<{ id: string }> }
    expect(list.items.find((g) => g.id === group.id)).toBeDefined()

    // And shows up as owner in the members list.
    const members = (await (await req(bearer, 'GET', `/api/v1/ui/ledger-groups/${group.id}/members`)).json()) as { items: Array<{ user_id: string; role: string }> }
    expect(members.items).toHaveLength(1)
    expect(members.items[0]!.user_id).toBe(creator)
    expect(members.items[0]!.role).toBe('owner')
  })

  it('hides a group from non-members (404 on detail + members)', async () => {
    const creator = `user_${Date.now()}_grp_hidden`
    const creatorBearer = await loginAs(creator)
    const stranger = `user_${Date.now()}_grp_stranger`
    const strangerBearer = await loginAs(stranger)

    const group = (await (await req(creatorBearer, 'POST', '/api/v1/ui/ledger-groups', {
      name: 'Private',
    })).json()) as { id: string }

    const detail = await req(strangerBearer, 'GET', `/api/v1/ui/ledger-groups/${group.id}`)
    expect(detail.status).toBe(404)
    expect(((await detail.json()) as { error: { code: string } }).error.code).toBe('ledger_group_not_found')

    const members = await req(strangerBearer, 'GET', `/api/v1/ui/ledger-groups/${group.id}/members`)
    expect(members.status).toBe(404)
  })

  it('patches name (owner only) and 403s a non-owner patch', async () => {
    const creator = `user_${Date.now()}_grp_patcher`
    const creatorBearer = await loginAs(creator)
    const group = (await (await req(creatorBearer, 'POST', '/api/v1/ui/ledger-groups', {
      name: 'Old',
    })).json()) as { id: string }

    const patch = await req(creatorBearer, 'PATCH', `/api/v1/ui/ledger-groups/${group.id}`, {
      name: 'New',
    })
    expect(patch.status).toBe(200)
    expect(((await patch.json()) as { name: string }).name).toBe('New')

    // Add a non-owner member directly, then they get 403 on patch.
    const peer = `user_${Date.now()}_grp_peer`
    const peerBearer = await loginAs(peer)
    await repos.ledgerGroups.addMember({
      id: `lgm_${Date.now()}`,
      groupId: group.id,
      userId: peer,
      role: 'member',
    })

    const peerPatch = await req(peerBearer, 'PATCH', `/api/v1/ui/ledger-groups/${group.id}`, {
      name: 'Hijacked',
    })
    expect(peerPatch.status).toBe(403)
  })

  it('soft-deletes a group (owner only)', async () => {
    const creator = `user_${Date.now()}_grp_del`
    const bearer = await loginAs(creator)
    const group = (await (await req(bearer, 'POST', '/api/v1/ui/ledger-groups', {
      name: 'To delete',
    })).json()) as { id: string }

    const del = await req(bearer, 'DELETE', `/api/v1/ui/ledger-groups/${group.id}`)
    expect(del.status).toBe(204)

    const detail = await req(bearer, 'GET', `/api/v1/ui/ledger-groups/${group.id}`)
    expect(detail.status).toBe(404)
  })
})
