import { describe, it, expect } from 'vitest'
import { buildApp } from '../build-app.js'
import { parseEnv } from '../env.js'
import { buildInMemoryRepos } from '../repos/memory.js'
import { createPasswordHasher } from '../crypto/password.js'
import { createAlwaysAllowVerifier } from '../services/captcha.js'
import { createStubBreachedCheck } from '../services/breached-password.js'
import { createLogMailer } from '../services/mailer/log.js'
import type { UserId } from '@rallypoint/shared'

// Phase 0 of platform/v-1.1 — covers the new
// POST /api/v1/sdk/users/batch-lookup endpoint. The per-app key gate
// is shared with /sdk/sso/exchange; this file checks the route-level
// behaviour (validation, dedup, missing-id drop) plus the gate is
// active. Cross-app-key compartmentalisation lives in sso.test.ts.

const EVENTS_KEY = 'test-events-api-key-32chars-minimum!!'
const LISTS_KEY = 'test-lists-api-key-32chars-minimum!!!!'
const MONEY_KEY = 'test-money-api-key-32chars-minimum!!!!'
const PLANNER_KEY = 'test-planner-api-key-32chars-minimum!'

const ENV = parseEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  EVENTS_API_KEY: EVENTS_KEY,
  LISTS_API_KEY: LISTS_KEY,
  MONEY_API_KEY: MONEY_KEY,
  PLANNER_API_KEY: PLANNER_KEY,
  SSO_EVENTS_HOST: 'localhost:5174',
  SSO_LISTS_HOST: 'localhost:5175',
})

const ENV_NO_KEYS = parseEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
})

function buildTestApp(env = ENV) {
  const repos = buildInMemoryRepos()
  const services = {
    mailer: createLogMailer({ sink: () => undefined }),
    captcha: createAlwaysAllowVerifier(),
    breachedPassword: createStubBreachedCheck(),
  }
  const passwordHasher = createPasswordHasher({ pepper: env.ARGON2_PEPPER })
  const app = buildApp({ env, repos, services, passwordHasher })
  return { app, repos }
}

function userIdOf(n: number): UserId {
  // 26-char ULID body padded with the test id index.
  const body = n.toString().padStart(26, '0')
  return `user_${body}` as UserId
}

async function seedUser(
  repos: ReturnType<typeof buildInMemoryRepos>,
  n: number,
  email: string,
): Promise<UserId> {
  const id = userIdOf(n)
  await repos.users.create({
    id,
    tenantId: 'rallypoint',
    email,
    username: `user${n}`,
    firstName: `First${n}`,
    lastName: `Last${n}`,
  })
  await repos.users.setEmailVerified(id, true)
  return id
}

describe('POST /api/v1/sdk/users/batch-lookup', () => {
  it('404s when no app keys are configured (anti-fingerprint)', async () => {
    const { app } = buildTestApp(ENV_NO_KEYS)
    const res = await app.request('http://x/api/v1/sdk/users/batch-lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${EVENTS_KEY}` },
      body: JSON.stringify({ user_ids: [userIdOf(1)] }),
    })
    expect(res.status).toBe(404)
  })

  it('403s when the bearer does not match any configured key', async () => {
    const { app } = buildTestApp()
    const res = await app.request('http://x/api/v1/sdk/users/batch-lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify({ user_ids: [userIdOf(1)] }),
    })
    expect(res.status).toBe(403)
  })

  it('returns matched users + silently drops missing IDs + de-duplicates input', async () => {
    const { app, repos } = buildTestApp()
    const u1 = await seedUser(repos, 1, 'one@x.test')
    const u2 = await seedUser(repos, 2, 'two@x.test')
    const missing = userIdOf(99)

    const res = await app.request('http://x/api/v1/sdk/users/batch-lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${EVENTS_KEY}` },
      body: JSON.stringify({ user_ids: [u1, u2, missing, u1] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      users: Array<{
        user_id: string
        email: string
        display_name: string | null
        first_name: string | null
        last_name: string | null
      }>
    }
    const byId = new Map(body.users.map((u) => [u.user_id, u]))
    expect(byId.get(u1)?.email).toBe('one@x.test')
    expect(byId.get(u2)?.email).toBe('two@x.test')
    expect(byId.has(missing)).toBe(false)
    // Dedup: u1 appears once even though we sent it twice.
    expect(body.users.filter((u) => u.user_id === u1).length).toBe(1)

    // New shape: display_name sourced from the (non-unique) username;
    // first/last present; the separate `username` key is gone.
    const e1 = byId.get(u1)!
    expect(e1.display_name).toBe('user1')
    expect(e1.first_name).toBe('First1')
    expect(e1.last_name).toBe('Last1')
    expect('username' in e1).toBe(false)
  })

  it('rejects empty user_ids array', async () => {
    const { app } = buildTestApp()
    const res = await app.request('http://x/api/v1/sdk/users/batch-lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${EVENTS_KEY}` },
      body: JSON.stringify({ user_ids: [] }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects more than 200 ids per request', async () => {
    const { app } = buildTestApp()
    const ids = Array.from({ length: 201 }, (_, i) => userIdOf(i + 1))
    const res = await app.request('http://x/api/v1/sdk/users/batch-lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${EVENTS_KEY}` },
      body: JSON.stringify({ user_ids: ids }),
    })
    expect(res.status).toBe(400)
  })

  it('accepts a PLANNER_API_KEY bearer (planner folds the profile into its user bar)', async () => {
    // planner-api calls batch-lookup to resolve the signed-in user's
    // avatar + name for its user bar, so the endpoint allowlist covers
    // planner alongside events.
    const { app, repos } = buildTestApp()
    const u1 = await seedUser(repos, 8, 'eight@x.test')
    const res = await app.request('http://x/api/v1/sdk/users/batch-lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PLANNER_KEY}` },
      body: JSON.stringify({ user_ids: [u1] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { users: Array<{ user_id: string; email: string }> }
    expect(body.users[0]?.email).toBe('eight@x.test')
  })

  it('403s a LISTS_API_KEY bearer (allowlist is events + planner — closes #159)', async () => {
    // The middleware accepts any configured first-party key, but
    // batch-lookup is pinned to an events+planner allowlist. A LISTS
    // key with access to user emails would let a future lists-api
    // compromise walk every user record by id; per-app
    // compartmentalisation means each /sdk endpoint pins itself to an
    // explicit client allowlist.
    const { app, repos } = buildTestApp()
    const u1 = await seedUser(repos, 7, 'seven@x.test')
    const res = await app.request('http://x/api/v1/sdk/users/batch-lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${LISTS_KEY}` },
      body: JSON.stringify({ user_ids: [u1] }),
    })
    expect(res.status).toBe(403)
  })

  it('403s a MONEY_API_KEY bearer (allowlist is events + planner — closes #159)', async () => {
    const { app, repos } = buildTestApp()
    const u1 = await seedUser(repos, 9, 'nine@x.test')
    const res = await app.request('http://x/api/v1/sdk/users/batch-lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${MONEY_KEY}` },
      body: JSON.stringify({ user_ids: [u1] }),
    })
    expect(res.status).toBe(403)
  })
})
