import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import type { Hono } from 'hono'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { encryptBearer } from '../crypto/encryption.js'
import { FITNESS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 integration tests for POST /api/v1/ui/ai/feedback — the forward to
// ai-api's AiRPC.recordFeedback via the AI_TRACES binding (stubbed here:
// this suite runs against fitness's D1 only; ai-api's own d1 suite
// covers the real persistence).

const CSRF = 'csrf_token_value_aifb_aaaaaaaaaaaaaaaaaa'

const recordFeedback = vi.fn(async () => ({ ok: true }))

const services: Services = {
  idClient: {
    verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
    signoutRpidBearer: async () => {},
  },
  rpidSso: { exchange: async () => ({ ok: false as const, reason: 'invalid' as const }) },
  profiles: { lookup: async () => null },
  settings: { get: async () => ({}), patch: async (_u, _n, p) => p },
  offClient: { lookup: async () => null, search: async () => [] },
  aiTraces: { recordTrace: async () => {}, recordFeedback },
}

describe('D1 integration — AI feedback route', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  beforeAll(async () => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })

  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(FITNESS_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { FITNESS_SESSION_KEY_V1: envVars.FITNESS_SESSION_KEY_V1 },
      keyVersion: envVars.FITNESS_SESSION_KEY_VERSION,
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

  function req(bearer: string, body: unknown): Promise<Response> {
    return app.request('/api/v1/ui/ai/feedback', {
      method: 'POST',
      headers: {
        cookie: `${envVars.FITNESS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}`,
        'x-rp-csrf': CSRF,
        'content-type': 'application/json',
        origin: envVars.FITNESS_UI_ORIGIN,
      },
      body: JSON.stringify(body),
    })
  }

  it('forwards feedback with the session userId (never the body)', async () => {
    const bearer = await loginAs('user_fb_1')
    const res = await req(bearer, {
      responseId: 'resp-123',
      action: 'edited',
      finalValue: { kcal: 400 },
      userId: 'spoofed-user',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(recordFeedback).toHaveBeenCalledWith({
      responseId: 'resp-123',
      userId: 'user_fb_1',
      action: 'edited',
      finalValue: { kcal: 400 },
    })
  })

  it('rejects an invalid action', async () => {
    const bearer = await loginAs('user_fb_2')
    const res = await req(bearer, { responseId: 'resp-123', action: 'loved' })
    expect(res.status).toBe(400)
  })

  it('rejects an unauthenticated request (CSRF guard fires first: 403)', async () => {
    const res = await app.request('/api/v1/ui/ai/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ responseId: 'x', action: 'accepted' }),
    })
    expect(res.status).toBe(403)
  })
})
