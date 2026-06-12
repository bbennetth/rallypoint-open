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

// D1 integration tests for the MCP token surface (RPL v1.0.0 slice 11):
// issue/list/revoke (session UI) + the SDK resolve-token endpoint the MCP
// Worker calls (key-gated). Never stores the raw token — only its hash.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

type Token = {
  id: string
  label: string
  last_used_at: string | null
  revoked_at: string | null
  token?: string
}

describe('D1 integration — MCP tokens', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  const services: Services = {
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: async () => {},
    },
    rpidSso: { exchange: async () => ({ ok: false as const, reason: 'invalid' as const }) },
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

  function uiHeaders(bearer: string): Record<string, string> {
    return {
      cookie: `${envVars.LISTS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.LISTS_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      'content-type': 'application/json',
    }
  }

  async function ui(bearer: string, method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: uiHeaders(bearer),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  // Resolve via the SDK surface (key-gated, no cookies).
  async function resolve(token: string, apiKey = envVars.MCP_API_KEY!): Promise<Response> {
    return app.request('http://localhost/api/v1/sdk/mcp/resolve-token', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
  }

  it('issues a token (raw shown once), lists it without the secret', async () => {
    const bearer = await loginAs(`user_${Date.now()}_issue`)
    const res = await ui(bearer, 'POST', '/api/v1/ui/mcp-tokens', { label: 'laptop' })
    expect(res.status).toBe(201)
    const created = (await res.json()) as Token
    expect(created.id).toMatch(/^mtk_/)
    expect(created.token).toMatch(/^rplmcp_/)
    expect(created.label).toBe('laptop')

    const listed = (await (await ui(bearer, 'GET', '/api/v1/ui/mcp-tokens')).json()) as {
      items: Token[]
    }
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]!.id).toBe(created.id)
    // The secret is never returned on list.
    expect(listed.items[0]!.token).toBeUndefined()
  })

  it('resolves a valid token to its owner and stamps last_used', async () => {
    const userId = `user_${Date.now()}_resolve`
    const bearer = await loginAs(userId)
    const created = (await (
      await ui(bearer, 'POST', '/api/v1/ui/mcp-tokens', { label: 'cli' })
    ).json()) as Token

    const res = await resolve(created.token!)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { userId: string; tokenId: string }
    expect(body.userId).toBe(userId)
    expect(body.tokenId).toBe(created.id)

    // last_used_at is now set.
    const listed = (await (await ui(bearer, 'GET', '/api/v1/ui/mcp-tokens')).json()) as {
      items: Token[]
    }
    expect(listed.items[0]!.last_used_at).not.toBeNull()
  })

  it('rejects an unknown token (401) and resolve without an SDK key (403)', async () => {
    const unknown = await resolve('rplmcp_not_a_real_token')
    expect(unknown.status).toBe(401)

    const noKey = await app.request('http://localhost/api/v1/sdk/mcp/resolve-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'rplmcp_x' }),
    })
    expect(noKey.status).toBe(403)
  })

  it('a revoked token no longer resolves (401)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_revoke`)
    const created = (await (
      await ui(bearer, 'POST', '/api/v1/ui/mcp-tokens', { label: 'temp' })
    ).json()) as Token

    expect((await resolve(created.token!)).status).toBe(200)

    const del = await ui(bearer, 'DELETE', `/api/v1/ui/mcp-tokens/${created.id}`)
    expect(del.status).toBe(204)

    expect((await resolve(created.token!)).status).toBe(401)
    // Revoking again is a 404 (already revoked).
    expect((await ui(bearer, 'DELETE', `/api/v1/ui/mcp-tokens/${created.id}`)).status).toBe(404)
  })

  it('one user cannot revoke another user’s token (404)', async () => {
    const owner = await loginAs(`user_${Date.now()}_owner`)
    const created = (await (
      await ui(owner, 'POST', '/api/v1/ui/mcp-tokens', { label: 'mine' })
    ).json()) as Token

    const attacker = await loginAs(`user_${Date.now()}_attacker`)
    const del = await ui(attacker, 'DELETE', `/api/v1/ui/mcp-tokens/${created.id}`)
    expect(del.status).toBe(404)
    // Still resolves for the owner — not revoked.
    expect((await resolve(created.token!)).status).toBe(200)
  })

  it('an expired token does not resolve (401)', async () => {
    // Insert a token directly with a past expiry.
    const userId = `user_${Date.now()}_expired`
    const raw = generateRawToken('rplmcp_')
    await repos.mcpTokens.create({
      id: `mtk_exp_${Date.now()}`,
      tenantId: 'rallypoint',
      idHash: hashToken(raw),
      userId,
      label: 'old',
      expiresAt: new Date(Date.now() - 1000),
    })
    expect((await resolve(raw)).status).toBe(401)
  })
})
