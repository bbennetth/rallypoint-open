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

// D1 integration tests for the comments surface (RPL v1.0.0 slice 7):
// create+list (oldest-first), item-not-in-list 404, author-only edit
// (other user gets 403), soft-delete hides the comment, and missing/
// deleted item surfaces as 404.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

type Comment = {
  id: string
  item_id: string
  author_id: string
  body: string
  created_at: string
  updated_at: string
}

describe('D1 integration — item comments', () => {
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

  // Create a standard list owned by `bearer` and return its id.
  async function makeList(bearer: string): Promise<string> {
    const groupRes = await req(bearer, 'POST', '/api/v1/ui/groups', {
      name: `Group ${Date.now()}_${Math.random().toString(36).slice(2)}`,
    })
    const groupId = ((await groupRes.json()) as { id: string }).id
    const listRes = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'My list',
      listType: 'standard',
      scopeType: 'list_group',
      scopeId: groupId,
    })
    expect(listRes.status).toBe(201)
    return ((await listRes.json()) as { id: string }).id
  }

  // Create an item in a list and return its id.
  async function makeItem(bearer: string, listId: string, title = 'Item'): Promise<string> {
    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items`, { title })
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }

  it('creates a comment and lists it (oldest-first)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_create`)
    const listId = await makeList(bearer)
    const itemId = await makeItem(bearer, listId)

    const c1 = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/${itemId}/comments`, {
      body: 'First comment',
    })
    expect(c1.status).toBe(201)
    const created = (await c1.json()) as Comment
    expect(created.id).toMatch(/^lic_/)
    expect(created.item_id).toBe(itemId)
    expect(created.body).toBe('First comment')

    // Second comment added after first.
    await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/${itemId}/comments`, {
      body: 'Second comment',
    })

    const listRes = await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/items/${itemId}/comments`)
    expect(listRes.status).toBe(200)
    const { items } = (await listRes.json()) as { items: Comment[] }
    expect(items).toHaveLength(2)
    // Oldest-first ordering: 'First comment' must precede 'Second comment'.
    expect(items[0]!.body).toBe('First comment')
    expect(items[1]!.body).toBe('Second comment')
  })

  it('returns 404 when the item does not belong to the list', async () => {
    const bearer = await loginAs(`user_${Date.now()}_wronglist`)
    const listId = await makeList(bearer)
    const listId2 = await makeList(bearer)
    const itemId = await makeItem(bearer, listId2)

    // Try to comment on an item from list2 via list1's URL.
    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/${itemId}/comments`, {
      body: 'Should not land',
    })
    expect(res.status).toBe(404)

    // GET also 404s.
    const getRes = await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/items/${itemId}/comments`)
    expect(getRes.status).toBe(404)
  })

  it('only the comment author may edit (other user gets 403)', async () => {
    const author = await loginAs(`user_${Date.now()}_author`)

    // Create a shared group so a second user can reach the same list.
    const secondGroupRes = await req(author, 'POST', '/api/v1/ui/groups', {
      name: `SharedGroup ${Date.now()}`,
    })
    const sharedGroupId = ((await secondGroupRes.json()) as { id: string }).id

    const sharedListRes = await req(author, 'POST', '/api/v1/ui/lists', {
      name: 'Shared list',
      listType: 'standard',
      scopeType: 'list_group',
      scopeId: sharedGroupId,
    })
    const sharedListId = ((await sharedListRes.json()) as { id: string }).id
    const sharedItemId = await makeItem(author, sharedListId)

    // Author creates a comment.
    const sharedComment = (await (
      await req(
        author,
        'POST',
        `/api/v1/ui/lists/${sharedListId}/items/${sharedItemId}/comments`,
        { body: 'Author wrote this' },
      )
    ).json()) as Comment

    // Enrol a second user as a real member of the group so they can read the list.
    const memberUserId = `user_${Date.now()}_member`
    const memberBearer = await loginAs(memberUserId)
    await repos.groups.addMember({
      id: `lgm_m_${Date.now()}`,
      groupId: sharedGroupId,
      userId: memberUserId,
      role: 'member',
    })

    // The member can read comments on the shared list.
    const readRes = await req(
      memberBearer,
      'GET',
      `/api/v1/ui/lists/${sharedListId}/items/${sharedItemId}/comments`,
    )
    expect(readRes.status).toBe(200)

    // The member cannot edit the author's comment (403).
    const patchRes = await req(
      memberBearer,
      'PATCH',
      `/api/v1/ui/lists/${sharedListId}/items/${sharedItemId}/comments/${sharedComment.id}`,
      { body: 'Hijacked' },
    )
    expect(patchRes.status).toBe(403)

    // The member cannot delete the author's comment either (403).
    const memberDelete = await req(
      memberBearer,
      'DELETE',
      `/api/v1/ui/lists/${sharedListId}/items/${sharedItemId}/comments/${sharedComment.id}`,
    )
    expect(memberDelete.status).toBe(403)

    // The author can edit their own comment.
    const patchOk = await req(
      author,
      'PATCH',
      `/api/v1/ui/lists/${sharedListId}/items/${sharedItemId}/comments/${sharedComment.id}`,
      { body: 'Updated by author' },
    )
    expect(patchOk.status).toBe(200)
    expect(((await patchOk.json()) as Comment).body).toBe('Updated by author')
  })

  it('soft-delete hides the comment from the list', async () => {
    const bearer = await loginAs(`user_${Date.now()}_del`)
    const listId = await makeList(bearer)
    const itemId = await makeItem(bearer, listId)

    const created = (await (
      await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/${itemId}/comments`, {
        body: 'To be deleted',
      })
    ).json()) as Comment

    const delRes = await req(
      bearer,
      'DELETE',
      `/api/v1/ui/lists/${listId}/items/${itemId}/comments/${created.id}`,
    )
    expect(delRes.status).toBe(204)

    // The comment no longer appears in the list.
    const after = (await (
      await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/items/${itemId}/comments`)
    ).json()) as { items: Comment[] }
    expect(after.items).toHaveLength(0)

    // PATCH and DELETE on the soft-deleted comment return 404.
    const patchGone = await req(
      bearer,
      'PATCH',
      `/api/v1/ui/lists/${listId}/items/${itemId}/comments/${created.id}`,
      { body: 'Should 404' },
    )
    expect(patchGone.status).toBe(404)
  })

  it('returns 404 when commenting on a soft-deleted item', async () => {
    const bearer = await loginAs(`user_${Date.now()}_delitem`)
    const listId = await makeList(bearer)
    const itemId = await makeItem(bearer, listId)

    // Soft-delete the item.
    await req(bearer, 'DELETE', `/api/v1/ui/lists/${listId}/items/${itemId}`)

    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/items/${itemId}/comments`, {
      body: 'Orphan comment',
    })
    expect(res.status).toBe(404)
  })
})
