import { describe, it, expect, vi } from 'vitest'
import {
  RateLimitStoreUnavailableError,
  type RateLimitRepo,
  type TakeTokenInput,
  type RateLimitDecision,
} from '@rallypoint/rate-limit'
import {
  createRateLimit,
  createApplyPerUserRateLimit,
  createRateLimitBucket,
  STORE_ERROR_RETRY_AFTER_SECONDS,
} from './rate-limit.js'

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

// A repo whose takeToken always rejects — models the store being unreachable.
function makeThrowingRepo(err: unknown) {
  const repo: RateLimitRepo = {
    takeToken: async (): Promise<RateLimitDecision> => {
      throw err
    },
    reset: async () => {},
    pruneOldBuckets: async () => 0,
  }
  return repo
}

function makeCtx(params: { repo: RateLimitRepo; ip?: string; env?: Record<string, unknown> }) {
  const headers = new Headers()
  if (params.ip) headers.set('cf-connecting-ip', params.ip)
  let retryAfter: string | undefined
  const logger = { warn: vi.fn() }
  const ctx = {
    var: {
      env: { TRUSTED_PROXY_HEADER: 'cf-connecting-ip', SALT: 'secret-salt', ...params.env },
      repos: { rateLimit: params.repo },
      logger,
    },
    req: { raw: { headers } },
    header: (name: string, value: string) => {
      if (name === 'Retry-After') retryAfter = value
    },
  }
  return { ctx, getRetryAfter: () => retryAfter, logger }
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

// The limiter writes to D1 on every guarded request, so a storage blip must
// degrade to "unlimited for a few seconds", never to a 500 per request.
describe('createRateLimitBucket — store failures', () => {
  const args = { bucketKey: 'user:user_7:upcoming', tag: 'user:upcoming', limit: 3, windowSeconds: 60 }

  it('fails open (and warns) when the store raises a transient D1 error', async () => {
    // The production signature: drizzle's "Failed query" wrapper with the D1
    // storage-reset text on the cause chain.
    const err = new Error('Failed query: insert into "rate_limits" …', {
      cause: new Error('D1 DB storage operation exceeded timeout which caused object to be reset.'),
    })
    const { ctx, logger } = makeCtx({ repo: makeThrowingRepo(err) })

    await expect(createRateLimitBucket(config)(ctx as never, args)).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(logger.warn.mock.calls[0][1]).toMatch(/allowing request unlimited/)
  })

  it('fails open without a logger bound on the context', async () => {
    const err = new Error('Network connection lost.')
    const { ctx } = makeCtx({ repo: makeThrowingRepo(err) })
    delete (ctx.var as { logger?: unknown }).logger

    await expect(createRateLimitBucket(config)(ctx as never, args)).resolves.toBeUndefined()
  })

  it('fails closed with a 429 (not a 500) when the bucket opts into deny', async () => {
    const err = new Error('Failed query: insert into "rate_limits" …', {
      cause: new Error('D1 DB storage operation exceeded timeout which caused object to be reset.'),
    })
    const { ctx, getRetryAfter, logger } = makeCtx({ repo: makeThrowingRepo(err) })

    await expect(
      createRateLimitBucket(config)(ctx as never, { ...args, onStoreError: 'deny' }),
    ).rejects.toThrow(`rl:user:upcoming:${STORE_ERROR_RETRY_AFTER_SECONDS}`)
    expect(getRetryAfter()).toBe(String(STORE_ERROR_RETRY_AFTER_SECONDS))
    expect(logger.warn.mock.calls[0][1]).toMatch(/denying request/)
  })

  it('honours an app-level deny default, and lets a policy override it back to allow', async () => {
    const err = new Error('network connection lost')
    const denyConfig = { ...config, onStoreError: 'deny' as const }

    const denied = makeCtx({ repo: makeThrowingRepo(err) })
    await expect(
      createRateLimitBucket(denyConfig)(denied.ctx as never, args),
    ).rejects.toThrow(/^rl:user:upcoming:/)

    // Per-call override wins over the app-level default.
    const allowed = makeCtx({ repo: makeThrowingRepo(err) })
    await expect(
      createRateLimitBucket(denyConfig)(allowed.ctx as never, { ...args, onStoreError: 'allow' }),
    ).resolves.toBeUndefined()
  })

  it('surfaces the cause chain in the warn log, not just the drizzle wrapper', async () => {
    const cause = new Error('D1 DB storage operation exceeded timeout which caused object to be reset.')
    const err = new Error('Failed query: insert into "rate_limits" …', { cause })
    const { ctx, logger } = makeCtx({ repo: makeThrowingRepo(err) })

    await createRateLimitBucket(config)(ctx as never, args)

    // `.cause` is non-enumerable, so the shared logger's Error clone drops it
    // unless it is lifted to its own field — this is the only production
    // signal for which transient condition fired.
    const logged = logger.warn.mock.calls[0][0] as { causes: string[]; bucket: string }
    expect(logged.bucket).toBe('user:upcoming')
    expect(logged.causes[0]).toMatch(/caused object to be reset/)
  })

  it('applies the same allow/deny policy to a DO-backend RateLimitStoreUnavailableError', async () => {
    // The DO-backed repo (createDoRateLimitRepo) wraps a retry-exhausted
    // stub failure in this class — no D1 signature on it anywhere, so the
    // instanceof arm of the gate is what keeps onStoreError working when the
    // store is a Durable Object instead of D1 (#881).
    const err = new RateLimitStoreUnavailableError('rate-limit DO /take failed', {
      cause: new Error('Durable Object reset because its code was updated'),
    })

    const allowed = makeCtx({ repo: makeThrowingRepo(err) })
    await expect(
      createRateLimitBucket(config)(allowed.ctx as never, args),
    ).resolves.toBeUndefined()
    expect(allowed.logger.warn.mock.calls[0][1]).toMatch(/allowing request unlimited/)

    const denied = makeCtx({ repo: makeThrowingRepo(err) })
    await expect(
      createRateLimitBucket(config)(denied.ctx as never, { ...args, onStoreError: 'deny' }),
    ).rejects.toThrow(`rl:user:upcoming:${STORE_ERROR_RETRY_AFTER_SECONDS}`)
  })

  it('rethrows a deterministic store error rather than silently unlimiting', async () => {
    const err = new Error('Failed query: too many SQL variables')
    const { ctx, logger } = makeCtx({ repo: makeThrowingRepo(err) })

    await expect(createRateLimitBucket(config)(ctx as never, args)).rejects.toThrow(
      'too many SQL variables',
    )
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('still throws 429 on a genuine denial (the catch does not swallow it)', async () => {
    const { repo } = makeRepo({ allowed: false, retryAfterSeconds: 12 })
    const { ctx, getRetryAfter } = makeCtx({ repo })

    await expect(createRateLimitBucket(config)(ctx as never, args)).rejects.toThrow(
      'rl:user:upcoming:12',
    )
    expect(getRetryAfter()).toBe('12')
  })
})
