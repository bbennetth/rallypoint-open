import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { HonoApp } from '../context.js'
import { parseEnv } from '../env.js'
import { buildLogger } from '../logger.js'
import { rateLimit, applyPerEmailRateLimit, applyPerUserRateLimit } from './rate-limit.js'
import { errorHandler } from './error-handler.js'
import { buildInMemoryRepos } from '../repos/memory.js'
import { createPasswordHasher } from '../crypto/password.js'
import { createAlwaysAllowVerifier } from '../services/captcha.js'
import { createStubBreachedCheck } from '../services/breached-password.js'
import { createLogMailer } from '../services/mailer/log.js'

// This suite drives requests via the `x-forwarded-for` header (no CF edge
// in front of the test Hono app), so it opts into the 'xff' trust policy
// explicitly — the id-api default is 'cf-connecting-ip' (#675: every
// deploy target is a Cloudflare Worker now), which would ignore XFF and
// collapse every request onto the 0.0.0.0 fallback bucket.
const ENV = parseEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  TRUSTED_PROXY_HEADER: 'xff',
})

function buildApp() {
  const repos = buildInMemoryRepos()
  const services = {
    mailer: createLogMailer({ sink: () => undefined }),
    captcha: createAlwaysAllowVerifier(),
    breachedPassword: createStubBreachedCheck(),
  }
  const passwordHasher = createPasswordHasher({ pepper: ENV.ARGON2_PEPPER })
  const logger = buildLogger(ENV)

  const app = new Hono<HonoApp>()
  app.use('*', async (c, next) => {
    c.set('env', ENV)
    c.set('logger', logger)
    c.set('repos', repos)
    c.set('services', services)
    c.set('passwordHasher', passwordHasher)
    c.set('requestId', 'test-req')
    await next()
  })
  app.onError(errorHandler)

  app.use('/limited', rateLimit({ route: 'limited', perIp: { limit: 3, windowSeconds: 60 } }))
  app.get('/limited', (c) => c.json({ ok: true }))
  return { app, repos }
}

describe('rateLimit middleware', () => {
  let setup: ReturnType<typeof buildApp>
  beforeEach(() => {
    setup = buildApp()
  })

  it('allows requests up to the limit', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await setup.app.request('/limited', {
        headers: { 'x-forwarded-for': '203.0.113.5' },
      })
      expect(res.status).toBe(200)
    }
  })

  it('429s the next request after the limit and sets Retry-After', async () => {
    for (let i = 0; i < 3; i++) {
      await setup.app.request('/limited', { headers: { 'x-forwarded-for': '203.0.113.5' } })
    }
    const res = await setup.app.request('/limited', {
      headers: { 'x-forwarded-for': '203.0.113.5' },
    })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeTruthy()
    const body = (await res.json()) as { error?: { code?: string; details?: { retry_after_seconds?: number } } }
    expect(body.error?.code).toBe('rate_limited')
    expect(body.error?.details?.retry_after_seconds).toBeGreaterThan(0)
  })

  it('counts per-IP independently', async () => {
    for (let i = 0; i < 3; i++) {
      await setup.app.request('/limited', { headers: { 'x-forwarded-for': '203.0.113.5' } })
    }
    // A different IP starts fresh.
    const res = await setup.app.request('/limited', {
      headers: { 'x-forwarded-for': '198.51.100.7' },
    })
    expect(res.status).toBe(200)
  })

  it('falls back to 0.0.0.0 when no IP header is present', async () => {
    const res = await setup.app.request('/limited')
    expect(res.status).toBe(200)
  })
})

// applyPerEmailRateLimit / applyPerUserRateLimit are called inline from
// handlers (the email lives in the parsed body, the userId comes from the
// session), so they take a Context rather than being middleware. We mount
// tiny routes that call them and record every bucketKey the repo sees.
function buildHelperApp() {
  const repos = buildInMemoryRepos()
  const recordedKeys: string[] = []
  const realTakeToken = repos.rateLimit.takeToken.bind(repos.rateLimit)
  repos.rateLimit.takeToken = async (input) => {
    recordedKeys.push(input.bucketKey)
    return realTakeToken(input)
  }
  const services = {
    mailer: createLogMailer({ sink: () => undefined }),
    captcha: createAlwaysAllowVerifier(),
    breachedPassword: createStubBreachedCheck(),
  }
  const passwordHasher = createPasswordHasher({ pepper: ENV.ARGON2_PEPPER })
  const logger = buildLogger(ENV)

  const app = new Hono<HonoApp>()
  app.use('*', async (c, next) => {
    c.set('env', ENV)
    c.set('logger', logger)
    c.set('repos', repos)
    c.set('services', services)
    c.set('passwordHasher', passwordHasher)
    c.set('requestId', 'test-req')
    await next()
  })
  app.onError(errorHandler)

  // Per-email: keyed only on ?email=, IP-independent (limit 3 / 60s).
  app.get('/email-limited', async (c) => {
    await applyPerEmailRateLimit(c, {
      email: c.req.query('email') ?? '',
      route: 'test-email',
      limit: 3,
      windowSeconds: 60,
    })
    return c.json({ ok: true })
  })
  // Per-user: keyed only on ?uid= (limit 2 / 60s).
  app.get('/user-limited', async (c) => {
    await applyPerUserRateLimit(c, {
      userId: c.req.query('uid') ?? '',
      route: 'test-user',
      limit: 2,
      windowSeconds: 60,
    })
    return c.json({ ok: true })
  })
  return { app, recordedKeys }
}

describe('applyPerEmailRateLimit', () => {
  const EMAIL = 'alice@example.com'
  const q = (email: string) => `/email-limited?email=${encodeURIComponent(email)}`

  it('allows up to the limit, then 429s with Retry-After and an email: bucket tag', async () => {
    const { app } = buildHelperApp()
    for (let i = 0; i < 3; i++) {
      expect((await app.request(q(EMAIL))).status).toBe(200)
    }
    const res = await app.request(q(EMAIL))
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeTruthy()
    const body = (await res.json()) as { error?: { code?: string; details?: { bucket?: string } } }
    expect(body.error?.code).toBe('rate_limited')
    expect(body.error?.details?.bucket).toBe('email:test-email')
  })

  it('keys per-email — a different address starts fresh', async () => {
    const { app } = buildHelperApp()
    for (let i = 0; i < 3; i++) await app.request(q(EMAIL))
    expect((await app.request(q(EMAIL))).status).toBe(429)
    // Different email, unaffected.
    expect((await app.request(q('bob@example.com'))).status).toBe(200)
  })

  it('collapses case/whitespace variants of one address onto the same bucket', async () => {
    const { app } = buildHelperApp()
    // These three normalize to alice@example.com — together they exhaust
    // the limit of 3, so a 4th (in any casing) is refused.
    expect((await app.request(q('alice@example.com'))).status).toBe(200)
    expect((await app.request(q('Alice@Example.com'))).status).toBe(200)
    expect((await app.request(q('  ALICE@EXAMPLE.COM  '))).status).toBe(200)
    expect((await app.request(q('alice@example.com'))).status).toBe(429)
  })

  it('is IP-independent — the same email from many IPs shares one bucket (botnet defense)', async () => {
    const { app } = buildHelperApp()
    const ips = ['203.0.113.1', '198.51.100.2', '192.0.2.3', '203.0.113.9']
    const statuses: number[] = []
    for (const ip of ips) {
      const res = await app.request(q(EMAIL), { headers: { 'x-forwarded-for': ip } })
      statuses.push(res.status)
    }
    // 3 allowed regardless of source IP, the 4th (new IP) still 429s.
    expect(statuses).toEqual([200, 200, 200, 429])
  })

  it('never stores the raw email in the rate_limits bucket key', async () => {
    const { app, recordedKeys } = buildHelperApp()
    await app.request(q(EMAIL))
    expect(recordedKeys.length).toBeGreaterThan(0)
    for (const key of recordedKeys) {
      expect(key).not.toContain(EMAIL)
      expect(key).not.toContain('alice')
      expect(key).toMatch(/^email:[0-9a-f]{64}:test-email$/) // sha256 hex, no PII
    }
  })
})

describe('applyPerUserRateLimit', () => {
  const q = (uid: string) => `/user-limited?uid=${encodeURIComponent(uid)}`

  it('allows up to the limit, then 429s with a user: bucket tag', async () => {
    const { app } = buildHelperApp()
    expect((await app.request(q('user_1'))).status).toBe(200)
    expect((await app.request(q('user_1'))).status).toBe(200)
    const res = await app.request(q('user_1'))
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error?: { details?: { bucket?: string } } }
    expect(body.error?.details?.bucket).toBe('user:test-user')
  })

  it('keys per-user — a different user starts fresh', async () => {
    const { app } = buildHelperApp()
    await app.request(q('user_1'))
    await app.request(q('user_1'))
    expect((await app.request(q('user_1'))).status).toBe(429)
    expect((await app.request(q('user_2'))).status).toBe(200)
  })
})
