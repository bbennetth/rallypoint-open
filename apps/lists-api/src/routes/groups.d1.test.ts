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
import { LISTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 integration tests for the list-group + membership surface.
// Replaces groups.it.test.ts.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — list groups', () => {
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
      patch: async (_u: string, _n: string, p: Record<string, unknown>) => p,
    },
  }

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })

  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(LISTS_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { LISTS_SESSION_KEY_V1: envVars.LISTS_SESSION_KEY_V1 },
      keyVersion: envVars.LISTS_SESSION_KEY_VERSION,
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
      cookie: `${envVars.LISTS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.LISTS_CSRF_COOKIE_NAME}=${CSRF}`,
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

  it('creates a group and auto-enrolls the creator as owner', async () => {
    const owner = `user_${Date.now()}_owner`
    const bearer = await loginAs(owner)

    const createRes = await req(bearer, 'POST', '/api/v1/ui/groups', { name: '  Road group  ' })
    expect(createRes.status).toBe(201)
    const group = (await createRes.json()) as Record<string, unknown>
    expect(group.id).toMatch(/^lgr_/)
    expect(group.name).toBe('Road group')
    expect(group.created_by).toBe(owner)

    const membersRes = await req(bearer, 'GET', `/api/v1/ui/groups/${group.id}/members`)
    const members = (await membersRes.json()) as { items: Array<Record<string, unknown>> }
    expect(members.items).toHaveLength(1)
    expect(members.items[0]!.user_id).toBe(owner)
    expect(members.items[0]!.role).toBe('owner')

    const mine = (await (await req(bearer, 'GET', '/api/v1/ui/groups')).json()) as {
      items: Array<Record<string, unknown>>
    }
    expect(mine.items.some((g) => g.id === group.id)).toBe(true)
  })

  it('hides a group from non-members (404, not 403)', async () => {
    const ownerBearer = await loginAs(`user_${Date.now()}_o`)
    const group = (await (await req(ownerBearer, 'POST', '/api/v1/ui/groups', {
      name: 'Private group',
    })).json()) as { id: string }

    const strangerBearer = await loginAs(`user_${Date.now()}_stranger`)
    const res = await req(strangerBearer, 'GET', `/api/v1/ui/groups/${group.id}`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('group_not_found')

    // And a non-member's "my groups" excludes it.
    const mine = (await (await req(strangerBearer, 'GET', '/api/v1/ui/groups')).json()) as {
      items: Array<Record<string, unknown>>
    }
    expect(mine.items.some((g) => g.id === group.id)).toBe(false)
  })

  it('lets the owner rename and soft-delete the group', async () => {
    const bearer = await loginAs(`user_${Date.now()}_rename`)
    const group = (await (await req(bearer, 'POST', '/api/v1/ui/groups', {
      name: 'Original',
    })).json()) as { id: string }

    const patched = (await (await req(bearer, 'PATCH', `/api/v1/ui/groups/${group.id}`, {
      name: 'Renamed',
    })).json()) as Record<string, unknown>
    expect(patched.name).toBe('Renamed')

    const delRes = await req(bearer, 'DELETE', `/api/v1/ui/groups/${group.id}`)
    expect(delRes.status).toBe(204)

    // Soft-deleted: gone from the owner's list and unfetchable.
    const getRes = await req(bearer, 'GET', `/api/v1/ui/groups/${group.id}`)
    expect(getRes.status).toBe(404)
  })

  it('forbids a non-owner member from patching the group', async () => {
    const ownerBearer = await loginAs(`user_${Date.now()}_go`)
    const group = (await (await req(ownerBearer, 'POST', '/api/v1/ui/groups', {
      name: 'Shared',
    })).json()) as { id: string }

    // Add a plain member directly via the repo (member-add UI is a
    // later slice; the membership primitive is what we exercise here).
    const member = `user_${Date.now()}_member`
    await repos.groups.addMember({
      id: `lgm_test_${Date.now()}`,
      groupId: group.id,
      userId: member,
      role: 'member',
    })
    const memberBearer = await loginAs(member)

    // The member can read the group...
    const getRes = await req(memberBearer, 'GET', `/api/v1/ui/groups/${group.id}`)
    expect(getRes.status).toBe(200)

    // ...but cannot rename it.
    const patchRes = await req(memberBearer, 'PATCH', `/api/v1/ui/groups/${group.id}`, {
      name: 'Hijacked',
    })
    expect(patchRes.status).toBe(403)
    expect(((await patchRes.json()) as { error: { code: string } }).error.code).toBe('forbidden')
  })

  // #277: duplicate personal-group prevention.
  // Two concurrent first-writes for the same (createdBy, name) must converge
  // to ONE group — the loser adopts the winner's id.
  it('concurrent duplicate creates for the same (createdBy, name) converge to one group', async () => {
    const actor = `user_${Date.now()}_concurrent`

    // Simulate the race: both calls use DIFFERENT ids (as resolvePersonalScope
    // would generate), yet the same actor + name. The second will hit the
    // partial unique index and must return the first group's record.
    const idA = `lgr_concA_${Date.now()}`
    const memA = `lgm_concA_${Date.now()}`
    const idB = `lgr_concB_${Date.now()}`
    const memB = `lgm_concB_${Date.now()}`

    const [groupA, groupB] = await Promise.all([
      repos.groups.create({ id: idA, tenantId: 'rallypoint', name: 'My Tasks', createdBy: actor, ownerMemberId: memA }),
      repos.groups.create({ id: idB, tenantId: 'rallypoint', name: 'My Tasks', createdBy: actor, ownerMemberId: memB }),
    ])

    // Both calls must return the SAME group id (the winner).
    expect(groupA.id).toBe(groupB.id)
    expect(groupA.name).toBe('My Tasks')

    // Exactly ONE live "My Tasks" group must exist for this actor.
    const row = await env.DB.prepare(
      `SELECT count(*) AS cnt FROM list_groups
       WHERE created_by = ? AND name = ? AND deleted_at IS NULL`,
    )
      .bind(actor, 'My Tasks')
      .first<{ cnt: number }>()
    expect(row?.cnt).toBe(1)
  })
})
