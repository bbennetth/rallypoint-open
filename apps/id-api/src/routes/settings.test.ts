import { describe, it, expect } from 'vitest'
import { buildApp } from '../build-app.js'
import { parseEnv } from '../env.js'
import { buildInMemoryRepos } from '../repos/memory.js'
import { createPasswordHasher } from '../crypto/password.js'
import { createAlwaysAllowVerifier } from '../services/captcha.js'
import { createStubBreachedCheck } from '../services/breached-password.js'
import { createLogMailer } from '../services/mailer/log.js'
import { issueSession } from '../session/issue.js'
import type { UserId } from '@rallypoint/shared'
import { SETTINGS_MAX_BYTES } from '@rallypoint/shared'

// Generic settings store route behaviour, exercised against the
// in-memory repos. Covers both surfaces (app-API-key SDK + cookie UI),
// the namespace access rule (own-client-or-shared), shallow-merge with
// null-delete, the size cap, and per-user (x-actor subject) isolation.

const PLANNER_KEY = 'test-planner-api-key-32chars-minimum!'
const EVENTS_KEY = 'test-events-api-key-32chars-minimum!!'

const ENV = parseEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  PLANNER_API_KEY: PLANNER_KEY,
  EVENTS_API_KEY: EVENTS_KEY,
})

const SESSION_COOKIE_NAME = ENV.SESSION_COOKIE_NAME
const CSRF_COOKIE_NAME = ENV.CSRF_COOKIE_NAME
const TEST_CSRF = 'test-csrf-' + 'x'.repeat(40)

function withCsrf(...cookies: string[]): Record<string, string> {
  return {
    cookie: [...cookies, `${CSRF_COOKIE_NAME}=${TEST_CSRF}`].filter(Boolean).join('; '),
    'x-rp-csrf': TEST_CSRF,
    'content-type': 'application/json',
  }
}

function buildTestApp() {
  const repos = buildInMemoryRepos()
  const services = {
    mailer: createLogMailer({ sink: () => undefined }),
    captcha: createAlwaysAllowVerifier(),
    breachedPassword: createStubBreachedCheck(),
  }
  const passwordHasher = createPasswordHasher({ pepper: ENV.ARGON2_PEPPER })
  const app = buildApp({ env: ENV, repos, services, passwordHasher })
  return { app, repos }
}

const ACTOR = 'user_01HXTEST0000000000000ACTOR' as UserId
const OTHER = 'user_01HXTEST0000000000000OTHER' as UserId

function sdkHeaders(actor: string = ACTOR, key: string = PLANNER_KEY): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    'x-actor': actor,
    'content-type': 'application/json',
  }
}

describe('SDK /api/v1/sdk/settings/:namespace', () => {
  it('returns an empty doc when none exists', async () => {
    const { app } = buildTestApp()
    const res = await app.request('/api/v1/sdk/settings/shared', { headers: sdkHeaders() })
    expect(res.status).toBe(200)
    expect((await res.json()) as Record<string, unknown>).toEqual({ settings: {} })
  })

  it('shallow-merges patch keys and returns the merged doc', async () => {
    const { app } = buildTestApp()
    await app.request('/api/v1/sdk/settings/shared', {
      method: 'PATCH',
      headers: sdkHeaders(),
      body: JSON.stringify({ themeMode: 'dark', themeColor: 'blue' }),
    })
    const res = await app.request('/api/v1/sdk/settings/shared', {
      method: 'PATCH',
      headers: sdkHeaders(),
      body: JSON.stringify({ themeColor: 'pink' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings: Record<string, unknown> }
    expect(body.settings).toEqual({ themeMode: 'dark', themeColor: 'pink' })
  })

  it('deletes a key sent as null', async () => {
    const { app } = buildTestApp()
    await app.request('/api/v1/sdk/settings/shared', {
      method: 'PATCH',
      headers: sdkHeaders(),
      body: JSON.stringify({ themeMode: 'dark', themeColor: 'blue' }),
    })
    const res = await app.request('/api/v1/sdk/settings/shared', {
      method: 'PATCH',
      headers: sdkHeaders(),
      body: JSON.stringify({ themeColor: null }),
    })
    const body = (await res.json()) as { settings: Record<string, unknown> }
    expect(body.settings).toEqual({ themeMode: 'dark' })
  })

  it('rejects an oversize body with 400', async () => {
    const { app } = buildTestApp()
    const big = 'x'.repeat(SETTINGS_MAX_BYTES + 1)
    const res = await app.request('/api/v1/sdk/settings/shared', {
      method: 'PATCH',
      headers: sdkHeaders(),
      body: JSON.stringify({ blob: big }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a non-object body with 400', async () => {
    const { app } = buildTestApp()
    const res = await app.request('/api/v1/sdk/settings/shared', {
      method: 'PATCH',
      headers: sdkHeaders(),
      body: JSON.stringify([1, 2, 3]),
    })
    expect(res.status).toBe(400)
  })

  it('400s when the x-actor subject header is missing', async () => {
    const { app } = buildTestApp()
    const headers = sdkHeaders()
    delete (headers as Record<string, string>)['x-actor']
    const res = await app.request('/api/v1/sdk/settings/shared', { headers })
    expect(res.status).toBe(400)
  })

  it('allows the app to access its own namespace', async () => {
    const { app } = buildTestApp()
    const res = await app.request('/api/v1/sdk/settings/planner', { headers: sdkHeaders() })
    expect(res.status).toBe(200)
  })

  it('forbids access to another app namespace (403)', async () => {
    const { app } = buildTestApp()
    // Planner key targeting the events namespace.
    const res = await app.request('/api/v1/sdk/settings/events', { headers: sdkHeaders() })
    expect(res.status).toBe(403)
  })

  it('isolates docs per subject (x-actor)', async () => {
    const { app } = buildTestApp()
    await app.request('/api/v1/sdk/settings/shared', {
      method: 'PATCH',
      headers: sdkHeaders(ACTOR),
      body: JSON.stringify({ themeMode: 'light' }),
    })
    const res = await app.request('/api/v1/sdk/settings/shared', { headers: sdkHeaders(OTHER) })
    const body = (await res.json()) as { settings: Record<string, unknown> }
    expect(body.settings).toEqual({})
  })

  it('404s when no app keys are configured', async () => {
    const repos = buildInMemoryRepos()
    const services = {
      mailer: createLogMailer({ sink: () => undefined }),
      captcha: createAlwaysAllowVerifier(),
      breachedPassword: createStubBreachedCheck(),
    }
    const env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    const app = buildApp({ env, repos, services })
    const res = await app.request('/api/v1/sdk/settings/shared', { headers: sdkHeaders() })
    expect(res.status).toBe(404)
  })
})

describe('UI /api/v1/ui/settings/:namespace', () => {
  async function authed() {
    const { app, repos } = buildTestApp()
    const userId = 'user_01HXTEST00000000000000000A' as UserId
    await repos.users.create({
      id: userId,
      tenantId: 'rallypoint',
      email: 'alice@example.com',
      username: 'alice',
    })
    await repos.users.setEmailVerified(userId, true)
    const { rawToken } = await issueSession(repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'a'.repeat(64),
      uaHash: 'b'.repeat(64),
    })
    return { app, repos, userId, cookie: `${SESSION_COOKIE_NAME}=${rawToken}` }
  }

  it('requires a session (401 without cookie)', async () => {
    const { app } = buildTestApp()
    const res = await app.request('/api/v1/ui/settings/shared')
    expect(res.status).toBe(401)
  })

  it('round-trips a patch then a get for the session user', async () => {
    const { app, cookie } = await authed()
    const patch = await app.request('/api/v1/ui/settings/shared', {
      method: 'PATCH',
      headers: withCsrf(cookie),
      body: JSON.stringify({ themeMode: 'light' }),
    })
    expect(patch.status).toBe(200)
    const get = await app.request('/api/v1/ui/settings/shared', { headers: { cookie } })
    const body = (await get.json()) as { settings: Record<string, unknown> }
    expect(body.settings).toEqual({ themeMode: 'light' })
  })

  it('forbids namespaces other than shared/id (403)', async () => {
    const { app, cookie } = await authed()
    const res = await app.request('/api/v1/ui/settings/planner', { headers: { cookie } })
    expect(res.status).toBe(403)
  })

  it('allows the id namespace', async () => {
    const { app, cookie } = await authed()
    const res = await app.request('/api/v1/ui/settings/id', { headers: { cookie } })
    expect(res.status).toBe(200)
  })
})
