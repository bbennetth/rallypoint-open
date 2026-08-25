import { describe, it, expect, vi } from 'vitest'
import type { RateLimitRepo, TakeTokenInput, RateLimitDecision } from '@rallypoint/rate-limit'
import { createRateLimit, createApplyPerUserRateLimit, createRateLimitBucket } from './rate-limit.js'

function makeRepo(decision: { allowed: boolean; retryAfterSeconds?: number }) {
  const calls: TakeTokenInput[] = []
  const repo: RateLimitRepo = {
    takeToken: async (input): Promise<RateLimitDecision> => {
      calls.push(input)
      return {
        allowed: decision.allowed,
        retryAfterSeconds: decision.retryAfterSeconds ?? 0,
        blendedCount: 0,
      }
    },
    reset: async () => {},
    pruneOldBuckets: async () => 0,
  }
  return { repo, calls }
}

function makeCtx(params: { repo: RateLimitRepo; ip?: string; env?: Record<string, unknown> }) {
  const headers = new Headers()
  if (params.ip) headers.set('cf-connecting-ip', params.ip)
  let retryAfter: string | undefined
  const ctx = {
    var: {
      env: { TRUSTED_PROXY_HEADER: 'cf-connecting-ip', SALT: 'secret-salt', ...params.env },
      repos: { rateLimit: params.repo },
    },
    req: { raw: { headers } },
    header: (name: string, value: string) => {
      if (name === 'Retry-After') retryAfter = value
    },
  }
  return { ctx, getRetryAfter: () => retryAfter }
}

// rateLimited factory that encodes its args into the error message so tests
// can assert the tag + retry-after that surfaced.
const config = {
  saltEnvKey: 'SALT',
  errors: {
    rateLimited: (retryAfterSeconds: number, bucket: string) =>
      new Error(`rl:${bucket}:${retryAfterSeconds}`),
  },
}

describe('createRateLimit', () => {
  it('skips the check entirely when perIp is omitted', async () => {
    const { repo, calls } = makeRepo({ allowed: true })
    const { ctx } = makeCtx({ repo, ip: '203.0.113.9' })
    const next = vi.fn(async () => {})

    await createRateLimit(config)({ route: 'open' })(ctx as never, next)

    expect(next).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(0)
  })

  it('allows and calls next() with an ip:<hash>:<route> bucket at the default tenant', async () => {
    const { repo, calls } = makeRepo({ allowed: true })
    const { ctx } = makeCtx({ repo, ip: '203.0.113.9' })
    const next = vi.fn(async () => {})

    await createRateLimit(config)({ route: 'signin', perIp: { limit: 5, windowSeconds: 60 } })(
      ctx as never,
      next,
    )

    expect(next).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(1)
    expect(calls[0].tenantId).toBe('rallypoint')
    expect(calls[0].bucketKey).toMatch(/^ip:[0-9a-f]{64}:signin$/)
    expect(calls[0]).toMatchObject({ limit: 5, windowSeconds: 60 })
  })

  it('429s (Retry-After + rateLimited tag) and does not call next() when denied', async () => {
    const { repo } = makeRepo({ allowed: false, retryAfterSeconds: 42 })
    const { ctx, getRetryAfter } = makeCtx({ repo, ip: '203.0.113.9' })
    const next = vi.fn(async () => {})

    await expect(
      createRateLimit(config)({ route: 'signin', perIp: { limit: 5, windowSeconds: 60 } })(
        ctx as never,
        next,
      ),
    ).rejects.toThrow('rl:ip:signin:42')
    expect(next).not.toHaveBeenCalled()
    expect(getRetryAfter()).toBe('42')
  })

  it('derives distinct bucket keys per route (salted IP hash)', async () => {
    const { repo, calls } = makeRepo({ allowed: true })
    const mk = createRateLimit(config)
    await mk({ route: 'a', perIp: { limit: 1, windowSeconds: 1 } })(
      makeCtx({ repo, ip: '203.0.113.9' }).ctx as never,
      vi.fn(),
    )
    await mk({ route: 'b', perIp: { limit: 1, windowSeconds: 1 } })(
      makeCtx({ repo, ip: '203.0.113.9' }).ctx as never,
      vi.fn(),
    )
    expect(calls[0].bucketKey).not.toBe(calls[1].bucketKey)
    expect(calls[0].bucketKey.endsWith(':a')).toBe(true)
    expect(calls[1].bucketKey.endsWith(':b')).toBe(true)
  })

  it('honours a custom tenant', async () => {
    const { repo, calls } = makeRepo({ allowed: true })
    const { ctx } = makeCtx({ repo, ip: '203.0.113.9' })
    await createRateLimit({ ...config, tenant: 'acme' })({
      route: 'x',
      perIp: { limit: 1, windowSeconds: 1 },
    })(ctx as never, vi.fn())
    expect(calls[0].tenantId).toBe('acme')
  })
})

describe('createApplyPerUserRateLimit', () => {
  it('allows with a user:<id>:<route> bucket', async () => {
    const { repo, calls } = makeRepo({ allowed: true })
    const { ctx } = makeCtx({ repo })
    await createApplyPerUserRateLimit(config)(ctx as never, {
      userId: 'user_7',
      route: 'weather',
      limit: 3,
      windowSeconds: 60,
    })
    expect(calls[0].bucketKey).toBe('user:user_7:weather')
    expect(calls[0]).toMatchObject({ tenantId: 'rallypoint', limit: 3, windowSeconds: 60 })
  })

  it('throws rateLimited with a user:<route> tag when denied', async () => {
    const { repo } = makeRepo({ allowed: false, retryAfterSeconds: 9 })
    const { ctx, getRetryAfter } = makeCtx({ repo })
    await expect(
      createApplyPerUserRateLimit(config)(ctx as never, {
        userId: 'user_7',
        route: 'weather',
        limit: 3,
        windowSeconds: 60,
      }),
    ).rejects.toThrow('rl:user:weather:9')
    expect(getRetryAfter()).toBe('9')
  })
})

describe('createRateLimitBucket', () => {
  it('passes the caller-supplied bucket key + tag straight through', async () => {
    const { repo, calls } = makeRepo({ allowed: false, retryAfterSeconds: 30 })
    const { ctx } = makeCtx({ repo })
    await expect(
      createRateLimitBucket(config)(ctx as never, {
        bucketKey: 'email:deadbeef:signup',
        tag: 'email:signup',
        limit: 5,
        windowSeconds: 3600,
      }),
    ).rejects.toThrow('rl:email:signup:30')
    expect(calls[0].bucketKey).toBe('email:deadbeef:signup')
  })
})
