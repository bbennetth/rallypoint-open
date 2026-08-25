import { describe, it, expect, vi, afterEach } from 'vitest'
import { hashToken } from '@rallypoint/crypto'
import {
  createSessionMiddleware,
  isDueForTouch,
  SESSION_TOUCH_INTERVAL_MS,
  type SessionMiddlewareConfig,
  type ApiKitSessionRow,
  type ApiKitSessionStore,
  type ApiKitIdVerifier,
} from './session.js'

// The middleware reads through a small structural view of the per-app Hono
// context; a hand-rolled fake is enough (no Hono server needed) and mirrors
// the plain-stub style of packages/web-kit/src/session.test.tsx.

const COOKIE_NAME = 'rpl_session'
const BEARER_PREFIX = 'rpl_sess_'
const RAW_TOKEN = `${BEARER_PREFIX}abcdef0123456789abcdef0123456789`
const ID_HASH = hashToken(RAW_TOKEN)
// Fixed clock so row expiry math is deterministic under fake timers.
const NOW = new Date('2026-01-01T00:00:00Z')

const UNAUTHORIZED = new Error('unauthorized-sentinel')
const UPSTREAM_UNAVAILABLE = new Error('upstream-unavailable-sentinel')

function validRow(over: Partial<ApiKitSessionRow> = {}): ApiKitSessionRow {
  return {
    userId: 'user_1',
    rpidBearerCiphertext: Buffer.from('ct'),
    rpidBearerNonce: Buffer.from('nonce'),
    rpidBearerKeyVersion: 1,
    // Relative to the current clock (real in the fast-path test, faked to NOW
    // in the timeout tests) so the row never reads as expired.
    absoluteExpiresAt: new Date(Date.now() + 30 * 24 * 3_600_000),
    // Stale by default so tests that don't care about the touch throttle
    // still exercise the touch path.
    lastSeenAt: new Date(Date.now() - SESSION_TOUCH_INTERVAL_MS - 1),
    ...over,
  }
}

function makeStore(row: ApiKitSessionRow | null): ApiKitSessionStore & {
  deleteByIdHash: ReturnType<typeof vi.fn>
  touchLastSeen: ReturnType<typeof vi.fn>
  markVerified: ReturnType<typeof vi.fn>
} {
  return {
    findByIdHash: vi.fn(async () => row),
    deleteByIdHash: vi.fn(async () => {}),
    touchLastSeen: vi.fn(async () => {}),
    markVerified: vi.fn(async () => {}),
  }
}

interface FakeCtx {
  var: unknown
  set: ReturnType<typeof vi.fn>
  header: ReturnType<typeof vi.fn>
  json: ReturnType<typeof vi.fn>
  req: { header(name: string): string | undefined }
}

function makeCtx(params: {
  store: ApiKitSessionStore
  idClient: ApiKitIdVerifier
  grace?: boolean
  env?: Record<string, unknown>
  cookie?: string
}): FakeCtx {
  const vars = {
    env: {
      [COOKIE_NAME]: COOKIE_NAME,
      NODE_ENV: 'test',
      ...params.env,
    },
    repos: { sessions: params.store },
    services: { idClient: params.idClient },
    logger: { warn: vi.fn() },
  }
  return {
    var: vars,
    set: vi.fn(),
    header: vi.fn(),
    json: vi.fn((body: unknown, status: number) => ({ __json: body, status })),
    req: { header: (name: string) => (name === 'cookie' ? params.cookie : undefined) },
  }
}

function baseConfig(over: Partial<SessionMiddlewareConfig> = {}): SessionMiddlewareConfig {
  return {
    bearerPrefix: BEARER_PREFIX,
    cookieNameEnvKey: COOKIE_NAME,
    decryptBearer: () => 'rpid-bearer-plaintext',
    errors: {
      unauthorized: () => UNAUTHORIZED,
      upstreamUnavailable: () => UPSTREAM_UNAVAILABLE,
    },
    ...over,
  }
}

function neverResolves(): Promise<never> {
  return new Promise<never>(() => {})
}

describe('createSessionMiddleware — RPC timeout behaviour', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('surfaces upstreamUnavailable (row preserved) when verify hangs past the bound', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = makeStore(validRow())
    const idClient: ApiKitIdVerifier = { verifyRpidBearer: () => neverResolves() }
    const mw = createSessionMiddleware(baseConfig({ timeoutMs: 5_000 }))
    const c = makeCtx({ store, idClient, cookie: `${COOKIE_NAME}=${RAW_TOKEN}` })
    const next = vi.fn(async () => {})

    const settled = (mw(c as never, next) as Promise<unknown>).then(
      () => ({ threw: false as const }),
      (err: unknown) => ({ threw: true as const, err }),
    )
    await vi.advanceTimersByTimeAsync(5_000)
    const outcome = await settled

    expect(outcome.threw).toBe(true)
    if (outcome.threw) expect(outcome.err).toBe(UPSTREAM_UNAVAILABLE)
    // A blip is not a revocation — the session row must survive.
    expect(store.deleteByIdHash).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('passes through to next() when verify resolves quickly', async () => {
    const store = makeStore(validRow())
    const idClient: ApiKitIdVerifier = {
      verifyRpidBearer: async () => ({ ok: true, userId: 'user_1' }),
    }
    const mw = createSessionMiddleware(baseConfig({ timeoutMs: 5_000 }))
    const c = makeCtx({ store, idClient, cookie: `${COOKIE_NAME}=${RAW_TOKEN}` })
    const next = vi.fn(async () => {})

    await mw(c as never, next)

    expect(next).toHaveBeenCalledOnce()
    expect(c.set).toHaveBeenCalledWith('session', { idHash: ID_HASH, userId: 'user_1' })
    expect(store.deleteByIdHash).not.toHaveBeenCalled()
  })

  it('grace app: a hung verify within the grace window rides through with offlineGrace', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = makeStore(
      validRow({ lastVerifiedAt: new Date(NOW.getTime() - 60_000) }), // verified 1 min ago
    )
    const idClient: ApiKitIdVerifier = { verifyRpidBearer: () => neverResolves() }
    const mw = createSessionMiddleware(
      baseConfig({ timeoutMs: 5_000, grace: { ttlHoursEnvKey: 'GRACE_TTL_HOURS' } }),
    )
    const c = makeCtx({
      store,
      idClient,
      env: { GRACE_TTL_HOURS: '24' },
      cookie: `${COOKIE_NAME}=${RAW_TOKEN}`,
    })
    const next = vi.fn(async () => {})

    const done = mw(c as never, next)
    await vi.advanceTimersByTimeAsync(5_000)
    await done

    expect(next).toHaveBeenCalledOnce()
    expect(c.set).toHaveBeenCalledWith('offlineGrace', true)
    expect(store.deleteByIdHash).not.toHaveBeenCalled()
  })
})

describe('isDueForTouch', () => {
  const now = new Date('2026-01-01T00:00:00Z')

  it('is due when the timestamp is null/undefined', () => {
    expect(isDueForTouch(null, now)).toBe(true)
    expect(isDueForTouch(undefined, now)).toBe(true)
  })

  it('is due at/after the interval, not before', () => {
    expect(isDueForTouch(new Date(now.getTime() - SESSION_TOUCH_INTERVAL_MS), now)).toBe(true)
    expect(isDueForTouch(new Date(now.getTime() - SESSION_TOUCH_INTERVAL_MS + 1), now)).toBe(false)
    expect(isDueForTouch(now, now)).toBe(false)
  })

  it('a future timestamp (clock skew) is not due', () => {
    expect(isDueForTouch(new Date(now.getTime() + 60_000), now)).toBe(false)
  })
})

describe('createSessionMiddleware — last_seen_at write throttle', () => {
  const okClient: ApiKitIdVerifier = {
    verifyRpidBearer: async () => ({ ok: true, userId: 'user_1' }),
  }

  it('skips touchLastSeen when the row was seen within the interval', async () => {
    const store = makeStore(validRow({ lastSeenAt: new Date() }))
    const mw = createSessionMiddleware(baseConfig())
    const c = makeCtx({ store, idClient: okClient, cookie: `${COOKIE_NAME}=${RAW_TOKEN}` })
    const next = vi.fn(async () => {})

    await mw(c as never, next)

    expect(next).toHaveBeenCalledOnce()
    expect(store.touchLastSeen).not.toHaveBeenCalled()
  })

  it('touches when the row is stale past the interval', async () => {
    const store = makeStore(validRow())
    const mw = createSessionMiddleware(baseConfig())
    const c = makeCtx({ store, idClient: okClient, cookie: `${COOKIE_NAME}=${RAW_TOKEN}` })
    const next = vi.fn(async () => {})

    await mw(c as never, next)

    expect(next).toHaveBeenCalledOnce()
    expect(store.touchLastSeen).toHaveBeenCalledOnce()
  })

  it('a failing touch never fails the request (best-effort)', async () => {
    const store = makeStore(validRow())
    store.touchLastSeen.mockRejectedValue(new Error('D1 storage reset'))
    const mw = createSessionMiddleware(baseConfig())
    const c = makeCtx({ store, idClient: okClient, cookie: `${COOKIE_NAME}=${RAW_TOKEN}` })
    const next = vi.fn(async () => {})

    await mw(c as never, next)
    // Let the detached best-effort promise settle.
    await new Promise((r) => setTimeout(r, 0))

    expect(next).toHaveBeenCalledOnce()
  })

  it('grace app: markVerified is throttled by lastVerifiedAt', async () => {
    const store = makeStore(
      validRow({ lastSeenAt: new Date(), lastVerifiedAt: new Date() }), // both fresh
    )
    const mw = createSessionMiddleware(baseConfig({ grace: { ttlHoursEnvKey: 'GRACE_TTL_HOURS' } }))
    const c = makeCtx({
      store,
      idClient: okClient,
      env: { GRACE_TTL_HOURS: '24' },
      cookie: `${COOKIE_NAME}=${RAW_TOKEN}`,
    })
    const next = vi.fn(async () => {})

    await mw(c as never, next)

    expect(next).toHaveBeenCalledOnce()
    expect(store.touchLastSeen).not.toHaveBeenCalled()
    expect(store.markVerified).not.toHaveBeenCalled()
  })

  it('a throwing executionCtx getter (real Hono without a Workers ctx) is tolerated', async () => {
    const store = makeStore(validRow())
    const mw = createSessionMiddleware(baseConfig())
    const c = makeCtx({ store, idClient: okClient, cookie: `${COOKIE_NAME}=${RAW_TOKEN}` })
    // Real Hono's executionCtx is a throwing getter when no Workers context
    // exists — not merely undefined. The middleware must ride through it.
    Object.defineProperty(c, 'executionCtx', {
      get() {
        throw new Error('This context has no ExecutionContext')
      },
    })
    const next = vi.fn(async () => {})

    await mw(c as never, next)

    expect(next).toHaveBeenCalledOnce()
    expect(store.touchLastSeen).toHaveBeenCalledOnce()
  })

  it('grace app: markVerified stamps when lastVerifiedAt is stale or missing', async () => {
    const store = makeStore(validRow({ lastVerifiedAt: null }))
    const mw = createSessionMiddleware(baseConfig({ grace: { ttlHoursEnvKey: 'GRACE_TTL_HOURS' } }))
    const c = makeCtx({
      store,
      idClient: okClient,
      env: { GRACE_TTL_HOURS: '24' },
      cookie: `${COOKIE_NAME}=${RAW_TOKEN}`,
    })
    const next = vi.fn(async () => {})

    await mw(c as never, next)

    expect(store.markVerified).toHaveBeenCalledOnce()
  })
})
