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

// #128 — read-authorization integration tests. Replaces lists-authz.it.test.ts.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — lists read authz (#128)', () => {
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

  // Create a list_group + return its id (the creator owns it).
  async function createGroup(bearer: string, name = `g ${Math.random()}`): Promise<string> {
    const r = await req(bearer, 'POST', '/api/v1/ui/groups', { name })
    expect(r.status).toBe(201)
    return ((await r.json()) as { id: string }).id
  }

  // Add `userId` as a member of an existing group. The UI member-add
  // surface lands in a later slice; for now we seed memberships via
  // the repo directly (same convention as groups.it.test.ts:175).
  async function addMember(groupId: string, userId: string): Promise<void> {
    await repos.groups.addMember({
      id: `lgm_test_${Math.random().toString(36).slice(2)}`,
      groupId,
      userId,
      role: 'member',
    })
  }

  async function createList(
    bearer: string,
    scopeId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const r = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'L',
      listType: 'standard',
      scopeType: 'list_group',
      scopeId,
      ...overrides,
    })
    expect(r.status).toBe(201)
    return ((await r.json()) as { id: string }).id
  }

  // ── scope ownership ────────────────────────────────────────────────

  it("denies UI reads against a `group` scope (cross-app scope owned by Events)", async () => {
    const bearer = await loginAs(`user_${Date.now()}_g_x`)
    const listRes = await req(
      bearer,
      'GET',
      '/api/v1/ui/lists?scope_type=group&scope_id=grp_anything',
    )
    expect(listRes.status).toBe(404)

    const streamRes = await app.request(
      'http://localhost/api/v1/ui/lists/stream?scope_type=group&scope_id=grp_anything',
      { headers: headers(bearer) },
    )
    expect(streamRes.status).toBe(404)
    await streamRes.body?.cancel()
  })

  // ── scope membership ───────────────────────────────────────────────

  it('non-member of a list_group 404s on every read path', async () => {
    const owner = `user_${Date.now()}_m_o`
    const stranger = `user_${Date.now()}_m_s`
    const ownerBearer = await loginAs(owner)
    const strangerBearer = await loginAs(stranger)
    const groupId = await createGroup(ownerBearer)
    const listId = await createList(ownerBearer, groupId)

    // GET /lists/:id
    const one = await req(strangerBearer, 'GET', `/api/v1/ui/lists/${listId}`)
    expect(one.status).toBe(404)

    // GET /lists?scope=
    const scoped = await req(
      strangerBearer,
      'GET',
      `/api/v1/ui/lists?scope_type=list_group&scope_id=${groupId}`,
    )
    expect(scoped.status).toBe(404)

    // GET /lists/:id/items
    const items = await req(strangerBearer, 'GET', `/api/v1/ui/lists/${listId}/items`)
    expect(items.status).toBe(404)

    // SSE: scope stream
    const scopeStream = await app.request(
      `http://localhost/api/v1/ui/lists/stream?scope_type=list_group&scope_id=${groupId}`,
      { headers: headers(strangerBearer) },
    )
    expect(scopeStream.status).toBe(404)
    await scopeStream.body?.cancel()

    // SSE: list stream
    const listStream = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/stream`,
      { headers: headers(strangerBearer) },
    )
    expect(listStream.status).toBe(404)
    await listStream.body?.cancel()
  })

  // ── visibility='all' ───────────────────────────────────────────────

  it('visibility=all: any group member can read', async () => {
    const owner = `user_${Date.now()}_va_o`
    const member = `user_${Date.now()}_va_m`
    const ownerBearer = await loginAs(owner)
    const memberBearer = await loginAs(member)
    const groupId = await createGroup(ownerBearer)
    await addMember(groupId, member)
    const listId = await createList(ownerBearer, groupId, { visibility: 'all' })

    const r = await req(memberBearer, 'GET', `/api/v1/ui/lists/${listId}`)
    expect(r.status).toBe(200)
  })

  // ── visibility='private' ───────────────────────────────────────────

  it("visibility=private: another group member 404s on the list", async () => {
    const owner = `user_${Date.now()}_vp_o`
    const member = `user_${Date.now()}_vp_m`
    const ownerBearer = await loginAs(owner)
    const memberBearer = await loginAs(member)
    const groupId = await createGroup(ownerBearer)
    await addMember(groupId, member)
    const listId = await createList(ownerBearer, groupId, { visibility: 'private' })

    // Owner still sees it.
    const ownerRead = await req(ownerBearer, 'GET', `/api/v1/ui/lists/${listId}`)
    expect(ownerRead.status).toBe(200)

    // Other member doesn't.
    const memberRead = await req(memberBearer, 'GET', `/api/v1/ui/lists/${listId}`)
    expect(memberRead.status).toBe(404)
  })

  // ── share-by-email flow ────────────────────────────────────────────

  it('private list: share-by-email round-trip (create invite → accept → access granted; revoke → 404)', async () => {
    const owner = `user_${Date.now()}_sh_o`
    const guest = `user_${Date.now()}_sh_g`
    const ownerBearer = await loginAs(owner)
    const guestBearer = await loginAs(guest)
    const groupId = await createGroup(ownerBearer)
    await addMember(groupId, guest)
    const listId = await createList(ownerBearer, groupId, { visibility: 'private' })

    // Guest can't see it yet (private + not shared).
    expect((await req(guestBearer, 'GET', `/api/v1/ui/lists/${listId}`)).status).toBe(404)

    // Owner mints a share invite.
    const inviteRes = await req(ownerBearer, 'POST', `/api/v1/ui/lists/${listId}/invites`, {
      invitedEmail: 'guest@example.test',
    })
    expect(inviteRes.status).toBe(201)
    const invite = (await inviteRes.json()) as { id: string; code: string }
    expect(invite.code).toMatch(/^rpl_/)

    // Guest accepts.
    const acceptRes = await req(guestBearer, 'POST', '/api/v1/ui/lists/invites/accept', {
      code: invite.code,
    })
    expect(acceptRes.status).toBe(200)

    // Guest now sees the list.
    expect((await req(guestBearer, 'GET', `/api/v1/ui/lists/${listId}`)).status).toBe(200)

    // Re-accepting the same invite is rejected (already consumed).
    const replay = await req(guestBearer, 'POST', '/api/v1/ui/lists/invites/accept', {
      code: invite.code,
    })
    expect(replay.status).toBe(409)

    // Owner revokes the share.
    const rm = await req(ownerBearer, 'DELETE', `/api/v1/ui/lists/${listId}/shares/${guest}`)
    expect(rm.status).toBe(204)

    // Guest's read now 404s.
    expect((await req(guestBearer, 'GET', `/api/v1/ui/lists/${listId}`)).status).toBe(404)
  })

  it('share invite revoke (DELETE pending invite) and listing of pending invites', async () => {
    const owner = `user_${Date.now()}_ir_o`
    const ownerBearer = await loginAs(owner)
    const groupId = await createGroup(ownerBearer)
    const listId = await createList(ownerBearer, groupId, { visibility: 'private' })

    const created = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/lists/${listId}/invites`, {
        invitedEmail: 'a@x.test',
      })
    ).json()) as { id: string; code: string }

    const pending = await req(ownerBearer, 'GET', `/api/v1/ui/lists/${listId}/invites`)
    expect(pending.status).toBe(200)
    const pendingBody = (await pending.json()) as { items: Array<{ id: string }> }
    expect(pendingBody.items.some((i) => i.id === created.id)).toBe(true)

    const del = await req(ownerBearer, 'DELETE', `/api/v1/ui/lists/${listId}/invites/${created.id}`)
    expect(del.status).toBe(204)

    const after = await req(ownerBearer, 'GET', `/api/v1/ui/lists/${listId}/invites`)
    const afterBody = (await after.json()) as { items: Array<{ id: string }> }
    expect(afterBody.items.some((i) => i.id === created.id)).toBe(false)
  })

  // ── codex round-1 follow-ups ───────────────────────────────────────

  it('list create: scope_type=group is denied at the UI write boundary', async () => {
    const bearer = await loginAs(`user_${Date.now()}_cw_g`)
    const r = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'X',
      listType: 'standard',
      scopeType: 'group',
      scopeId: 'grp_anything',
    })
    expect(r.status).toBe(404)
  })

  it('list create: non-member of a list_group cannot create a list in it', async () => {
    const owner = `user_${Date.now()}_cw_o`
    const stranger = `user_${Date.now()}_cw_s`
    const ownerBearer = await loginAs(owner)
    const strangerBearer = await loginAs(stranger)
    const groupId = await createGroup(ownerBearer)
    const r = await req(strangerBearer, 'POST', '/api/v1/ui/lists', {
      name: 'X',
      listType: 'standard',
      scopeType: 'list_group',
      scopeId: groupId,
    })
    expect(r.status).toBe(404)
  })

  // Note: the publish-skip-on-private-create assertion lives in
  // realtime.d1.test.ts (fake bus) — easier to assert than over the
  // real SSE wire.

  it('share invites: addedByUserId in list_shares is the inviter (audit), not the accepting user', async () => {
    const owner = `user_${Date.now()}_au_o`
    const guest = `user_${Date.now()}_au_g`
    const ownerBearer = await loginAs(owner)
    const guestBearer = await loginAs(guest)
    const groupId = await createGroup(ownerBearer)
    const listId = await createList(ownerBearer, groupId, { visibility: 'private' })

    const invite = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/lists/${listId}/invites`, {
        invitedEmail: 'guest@example.test',
      })
    ).json()) as { code: string }
    await req(guestBearer, 'POST', '/api/v1/ui/lists/invites/accept', { code: invite.code })

    const share = await repos.listShares.findByListAndUser(listId, guest)
    expect(share?.addedByUserId).toBe(owner)
    expect(share?.addedByUserId).not.toBe(guest)
  })

  it('soft-deleted list_group: stale memberships no longer grant access', async () => {
    const owner = `user_${Date.now()}_sd_o`
    const member = `user_${Date.now()}_sd_m`
    const ownerBearer = await loginAs(owner)
    const memberBearer = await loginAs(member)
    const groupId = await createGroup(ownerBearer)
    await addMember(groupId, member)
    const listId = await createList(ownerBearer, groupId, { visibility: 'all' })

    // Member sees the list while the group is live.
    expect((await req(memberBearer, 'GET', `/api/v1/ui/lists/${listId}`)).status).toBe(200)

    // Owner soft-deletes the list_group; stale group_members rows
    // hang around, but the access helpers must treat the group as
    // gone and 404 every read.
    const delRes = await req(ownerBearer, 'DELETE', `/api/v1/ui/groups/${groupId}`)
    expect(delRes.status).toBe(204)

    expect((await req(memberBearer, 'GET', `/api/v1/ui/lists/${listId}`)).status).toBe(404)
    expect(
      (await req(memberBearer, 'GET', `/api/v1/ui/lists?scope_type=list_group&scope_id=${groupId}`)).status,
    ).toBe(404)
  })

  it('share grants access to a non-member of the list_group (cross-team sharing)', async () => {
    const owner = `user_${Date.now()}_xt_o`
    const guest = `user_${Date.now()}_xt_g`
    const ownerBearer = await loginAs(owner)
    const guestBearer = await loginAs(guest)
    const groupId = await createGroup(ownerBearer)
    // Note: guest is NOT added to groupId.
    const listId = await createList(ownerBearer, groupId, { visibility: 'private' })

    // Mint + accept the invite as a non-member of the group.
    const invite = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/lists/${listId}/invites`, {
        invitedEmail: 'guest@example.test',
      })
    ).json()) as { code: string }
    const accept = await req(guestBearer, 'POST', '/api/v1/ui/lists/invites/accept', {
      code: invite.code,
    })
    expect(accept.status).toBe(200)

    // Guest reads the list successfully despite not being a scope member.
    expect((await req(guestBearer, 'GET', `/api/v1/ui/lists/${listId}`)).status).toBe(200)
  })

  it('non-creator cannot mint share invites (404, masked as listNotFound)', async () => {
    const owner = `user_${Date.now()}_nc_o`
    const member = `user_${Date.now()}_nc_m`
    const ownerBearer = await loginAs(owner)
    const memberBearer = await loginAs(member)
    const groupId = await createGroup(ownerBearer)
    await addMember(groupId, member)
    const listId = await createList(ownerBearer, groupId, { visibility: 'all' })

    const r = await req(memberBearer, 'POST', `/api/v1/ui/lists/${listId}/invites`, {
      invitedEmail: 'x@x.test',
    })
    expect(r.status).toBe(404)
  })

  it('shared-with-me: surfaces lists the caller has been added to via share', async () => {
    const owner = `user_${Date.now()}_sw_o`
    const guest = `user_${Date.now()}_sw_g`
    const ownerBearer = await loginAs(owner)
    const guestBearer = await loginAs(guest)
    const groupId = await createGroup(ownerBearer)
    const listId = await createList(ownerBearer, groupId, { visibility: 'private' })

    // Guest's shared-with-me is empty before accept.
    const before = await req(guestBearer, 'GET', '/api/v1/ui/lists/shared-with-me')
    expect(before.status).toBe(200)
    expect(((await before.json()) as { items: unknown[] }).items).toHaveLength(0)

    const invite = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/lists/${listId}/invites`, {
        invitedEmail: 'guest@example.test',
      })
    ).json()) as { code: string }
    await req(guestBearer, 'POST', '/api/v1/ui/lists/invites/accept', { code: invite.code })

    const after = await req(guestBearer, 'GET', '/api/v1/ui/lists/shared-with-me')
    expect(after.status).toBe(200)
    const afterBody = (await after.json()) as { items: Array<{ id: string }> }
    expect(afterBody.items.some((l) => l.id === listId)).toBe(true)

    // Owner's own /shared-with-me does NOT include their own list
    // (they see it in their scope listing instead).
    const ownerSelf = await req(ownerBearer, 'GET', '/api/v1/ui/lists/shared-with-me')
    const ownerSelfBody = (await ownerSelf.json()) as { items: Array<{ id: string }> }
    expect(ownerSelfBody.items.some((l) => l.id === listId)).toBe(false)

    // Revoke the share → drops from shared-with-me too.
    const rm = await req(ownerBearer, 'DELETE', `/api/v1/ui/lists/${listId}/shares/${guest}`)
    expect(rm.status).toBe(204)
    const post = await req(guestBearer, 'GET', '/api/v1/ui/lists/shared-with-me')
    const postBody = (await post.json()) as { items: Array<{ id: string }> }
    expect(postBody.items.some((l) => l.id === listId)).toBe(false)
  })
})
