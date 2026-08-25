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
      origin: envVars.LISTS_UI_ORIGIN,
    }
  }

  async function ui(bearer: string, method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: uiHeaders(bearer),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
})
