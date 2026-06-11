import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { HonoApp } from '../context.js'
import { parseEnv } from '../env.js'
import { buildLogger } from '../logger.js'
import { rateLimit } from './rate-limit.js'
import { errorHandler } from './error-handler.js'
import { buildInMemoryRepos } from '../repos/memory.js'
import { createPasswordHasher } from '../crypto/password.js'
import { createAlwaysAllowVerifier } from '../services/captcha.js'
import { createStubBreachedCheck } from '../services/breached-password.js'
import { createLogMailer } from '../services/mailer/log.js'

const ENV = parseEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
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
