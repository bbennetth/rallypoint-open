import { describe, it, expect } from 'vitest'
import type { Hono } from 'hono'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { buildApp } from '../build-app.js'
import { buildMemoryRepos } from '../repos/memory.js'
import { parseEnv, type Env } from '../env.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { PLANNER_SESSION_BEARER_PREFIX } from './session.js'

// Unit tests for the planner session middleware revocation cascade
// branches. Uses in-memory repos (no DB) and a fake id-client to
// exercise every path: unknown row, expired row, undecryptable bearer,
// RPID revoked, RPID userId mismatch, RPID transport error.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaa'

function buildTestApp(
  repos: Repos,
  services: Services,
): { app: Hono<HonoApp>; env: Env } {
  const env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
  const app = buildApp({ env, logger: undefined, repos, services })
  return { app, env }
}

// Helper: seal a bearer into a session row and return the raw bearer.
async function createSession(
  repos: Repos,
  env: Env,
  opts: {
    userId: string
    absExpiresAt?: Date
    rpidBearer?: string
  },
): Promise<string> {
  const rawBearer = generateRawToken(PLANNER_SESSION_BEARER_PREFIX)
  const idHash = hashToken(rawBearer)
  const rpidBearer = opts.rpidBearer ?? opts.userId
  const sealed = encryptBearer({
    plaintext: rpidBearer,
    aad: idHash,
    env: { PLANNER_SESSION_KEY_V1: env.PLANNER_SESSION_KEY_V1 },
    keyVersion: env.PLANNER_SESSION_KEY_VERSION,
  })
  await repos.sessions.create({
    idHash,
    userId: opts.userId,
    rpidBearerCiphertext: sealed.ciphertext,
    rpidBearerNonce: sealed.nonce,
    rpidBearerKeyVersion: sealed.keyVersion,
    absoluteExpiresAt: opts.absExpiresAt ?? new Date(Date.now() + 3_600_000),
    ipHash: '',
    uaHash: '',
  })
  return rawBearer
}

function authHeaders(bearer: string, env: Env): Record<string, string> {
  return {
    cookie: `${env.PLANNER_SESSION_COOKIE_NAME}=${bearer}; ${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`,
    'x-rp-csrf': CSRF,
  }
}

// --- unknown row → 401 + clears cookie ---

describe('requireSession — unknown row', () => {
  it('returns 401 and clears the cookie for a bearer not in the store', async () => {
    const repos = buildMemoryRepos()
    const services: Services = {
      idClient: {
        verifyRpidBearer: async () => ({ ok: true as const, userId: 'user_x' }),
        signoutRpidBearer: async () => {},
      },
      rpidSso: {
        exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
      },
      settings: {
        get: async () => ({}),
        patch: async () => ({}),
      },
    }
    const { app, env } = buildTestApp(repos, services)
    // No session created — send a well-formed bearer that doesn't exist in store
    const fakeBearer = generateRawToken(PLANNER_SESSION_BEARER_PREFIX)

    const res = await app.request('http://localhost/api/v1/ui/session', {
      method: 'GET',
      headers: authHeaders(fakeBearer, env),
    })
    expect(res.status).toBe(401)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(env.PLANNER_SESSION_COOKIE_NAME)
  })
})

// --- expired row → delete row + 401 + clears cookie ---

describe('requireSession — expired row', () => {
  it('deletes the row and returns 401 when the session is past its absolute expiry', async () => {
    const repos = buildMemoryRepos()
    const services: Services = {
      idClient: {
        verifyRpidBearer: async () => ({ ok: true as const, userId: 'user_x' }),
        signoutRpidBearer: async () => {},
      },
      rpidSso: {
        exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
      },
      settings: {
        get: async () => ({}),
        patch: async () => ({}),
      },
    }
    const { app, env } = buildTestApp(repos, services)
    const bearer = await createSession(repos, env, {
      userId: 'user_expired',
      absExpiresAt: new Date(Date.now() - 1_000),
    })
    const idHash = hashToken(bearer)

    const res = await app.request('http://localhost/api/v1/ui/session', {
      method: 'GET',
      headers: authHeaders(bearer, env),
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie') ?? '').toContain(env.PLANNER_SESSION_COOKIE_NAME)
    const row = await repos.sessions.findByIdHash(idHash)
    expect(row).toBeNull()
  })
})

// --- sealed bearer no longer decrypts → delete row + 401 ---

describe('requireSession — undecryptable bearer', () => {
  it('deletes the row and returns 401 when the stored ciphertext cannot be decrypted', async () => {
    const repos = buildMemoryRepos()
    const services: Services = {
      idClient: {
        verifyRpidBearer: async () => ({ ok: true as const, userId: 'user_x' }),
        signoutRpidBearer: async () => {},
      },
      rpidSso: {
        exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
      },
      settings: {
        get: async () => ({}),
        patch: async () => ({}),
      },
    }
    const { app, env } = buildTestApp(repos, services)
    // Hand-roll a row whose ciphertext is garbage so decryptBearer throws.
    const rawBearer = generateRawToken(PLANNER_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    await repos.sessions.create({
      idHash,
      userId: 'user_tamper',
      rpidBearerCiphertext: Buffer.from('not-a-valid-ciphertext'),
      rpidBearerNonce: Buffer.from('000000000000'),
      rpidBearerKeyVersion: env.PLANNER_SESSION_KEY_VERSION,
      absoluteExpiresAt: new Date(Date.now() + 3_600_000),
      ipHash: '',
      uaHash: '',
    })

    const res = await app.request('http://localhost/api/v1/ui/session', {
      method: 'GET',
      headers: authHeaders(rawBearer, env),
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie') ?? '').toContain(env.PLANNER_SESSION_COOKIE_NAME)
    const row = await repos.sessions.findByIdHash(idHash)
    expect(row).toBeNull()
  })
})

// --- RPID says bearer is revoked → delete row + 401 ---

describe('requireSession — RPID revoked', () => {
  it('deletes the session row and returns 401 when RPID signals revocation', async () => {
    const repos = buildMemoryRepos()
    const services: Services = {
      idClient: {
        verifyRpidBearer: async () => ({ ok: false as const, revoked: true as const }),
        signoutRpidBearer: async () => {},
      },
      rpidSso: {
        exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
      },
      settings: {
        get: async () => ({}),
        patch: async () => ({}),
      },
    }
    const { app, env } = buildTestApp(repos, services)
    const bearer = await createSession(repos, env, { userId: 'user_revoked' })
    const idHash = hashToken(bearer)

    const res = await app.request('http://localhost/api/v1/ui/session', {
      method: 'GET',
      headers: authHeaders(bearer, env),
    })
    expect(res.status).toBe(401)
    // Row must be deleted
    const row = await repos.sessions.findByIdHash(idHash)
    expect(row).toBeNull()
  })
})

// --- RPID verifies a different user than the row → delete row + 401 ---

describe('requireSession — RPID userId mismatch', () => {
  it('deletes the row and returns 401 when RPID resolves a different userId than the row', async () => {
    const repos = buildMemoryRepos()
    const services: Services = {
      idClient: {
        verifyRpidBearer: async () => ({ ok: true as const, userId: 'user_someone_else' }),
        signoutRpidBearer: async () => {},
      },
      rpidSso: {
        exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
      },
      settings: {
        get: async () => ({}),
        patch: async () => ({}),
      },
    }
    const { app, env } = buildTestApp(repos, services)
    const bearer = await createSession(repos, env, { userId: 'user_owner' })
    const idHash = hashToken(bearer)

    const res = await app.request('http://localhost/api/v1/ui/session', {
      method: 'GET',
      headers: authHeaders(bearer, env),
    })
    expect(res.status).toBe(401)
    const row = await repos.sessions.findByIdHash(idHash)
    expect(row).toBeNull()
  })
})

// --- RPID transport error → 503 and row kept ---

describe('requireSession — RPID transport error', () => {
  it('returns 503 and preserves the session row when RPID is unreachable', async () => {
    const repos = buildMemoryRepos()
    const services: Services = {
      idClient: {
        verifyRpidBearer: async () => { throw new Error('rpid_transport_error') },
        signoutRpidBearer: async () => {},
      },
      rpidSso: {
        exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
      },
      settings: {
        get: async () => ({}),
        patch: async () => ({}),
      },
    }
    const { app, env } = buildTestApp(repos, services)
    const bearer = await createSession(repos, env, { userId: 'user_transport' })
    const idHash = hashToken(bearer)

    const res = await app.request('http://localhost/api/v1/ui/session', {
      method: 'GET',
      headers: authHeaders(bearer, env),
    })
    expect(res.status).toBe(503)
    // Row must be preserved — RPID hiccup ≠ revocation
    const row = await repos.sessions.findByIdHash(idHash)
    expect(row).toBeTruthy()
  })
})
