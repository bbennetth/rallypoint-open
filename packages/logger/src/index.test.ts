import { describe, expect, it } from 'vitest'
import { createLogger, type LogLevel } from './index.js'

interface Captured {
  level: LogLevel
  record: Record<string, unknown>
  raw: string
}

function makeLogger(opts: { level?: string; dev?: boolean } = {}) {
  const lines: Captured[] = []
  const logger = createLogger({
    service: 'rallypoint-test',
    level: opts.level,
    dev: opts.dev,
    now: () => '2026-06-05T00:00:00.000Z',
    sink: (level, raw) => {
      lines.push({ level, raw, record: opts.dev ? {} : (JSON.parse(raw) as Record<string, unknown>) })
    },
  })
  return { logger, lines }
}

describe('createLogger', () => {
  it('emits a JSON record with level/time/service/msg and merged fields', () => {
    const { logger, lines } = makeLogger()
    logger.info({ requestId: 'r1', status: 200 }, 'request')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.record).toEqual({
      level: 'info',
      time: '2026-06-05T00:00:00.000Z',
      service: 'rallypoint-test',
      requestId: 'r1',
      status: 200,
      msg: 'request',
    })
  })

  it('supports the message-only signature', () => {
    const { logger, lines } = makeLogger()
    logger.warn('heads up')
    expect(lines[0]!.record.msg).toBe('heads up')
    expect(lines[0]!.record.level).toBe('warn')
  })

  it('filters records below the configured level', () => {
    const { logger, lines } = makeLogger({ level: 'warn' })
    logger.info('dropped')
    logger.debug('dropped')
    logger.warn('kept')
    logger.error('kept')
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error'])
  })

  it('silent mutes everything', () => {
    const { logger, lines } = makeLogger({ level: 'silent' })
    logger.error('nope')
    expect(lines).toHaveLength(0)
  })

  it('routes error/fatal to the error sink, others to the log sink', () => {
    const { logger, lines } = makeLogger({ level: 'trace' })
    logger.info('a')
    logger.error('b')
    logger.fatal('c')
    expect(lines.map((l) => l.level)).toEqual(['info', 'error', 'fatal'])
  })

  describe('redaction (secret-bearing leaf keys at any depth)', () => {
    it('censors the fixed deep header paths', () => {
      const { logger, lines } = makeLogger()
      logger.info({
        req: { headers: { authorization: 'Bearer x', cookie: 'a=b', 'user-agent': 'curl' } },
        res: { headers: { 'set-cookie': '__Host-rp=1', 'content-type': 'json' } },
      })
      const r = lines[0]!.record as {
        req: { headers: Record<string, string> }
        res: { headers: Record<string, string> }
      }
      expect(r.req.headers.authorization).toBe('[REDACTED]')
      expect(r.req.headers.cookie).toBe('[REDACTED]')
      expect(r.res.headers['set-cookie']).toBe('[REDACTED]')
      // Non-sensitive sibling fields pass through untouched.
      expect(r.req.headers['user-agent']).toBe('curl')
      expect(r.res.headers['content-type']).toBe('json')
    })

    it('censors *.password/token/code/secret one level deep', () => {
      const { logger, lines } = makeLogger()
      logger.info({ user: { password: 'p', token: 't', code: 'c', secret: 's', name: 'ok' } })
      const r = lines[0]!.record as { user: Record<string, string> }
      expect(r.user).toEqual({
        password: '[REDACTED]',
        token: '[REDACTED]',
        code: '[REDACTED]',
        secret: '[REDACTED]',
        name: 'ok',
      })
    })

    it('censors the token-bearing field names token itself does not cover', () => {
      const { logger, lines } = makeLogger()
      logger.info({
        ctx: {
          apiKey: 'ak',
          accessToken: 'at',
          refreshToken: 'rt',
          csrfToken: 'ct',
          privateKey: 'pk',
          // Deliberately NOT redacted — bare `key` is too broad.
          key: 'cache-key-42',
          name: 'ok',
        },
      })
      const r = lines[0]!.record as { ctx: Record<string, string> }
      expect(r.ctx).toEqual({
        apiKey: '[REDACTED]',
        accessToken: '[REDACTED]',
        refreshToken: '[REDACTED]',
        csrfToken: '[REDACTED]',
        privateKey: '[REDACTED]',
        key: 'cache-key-42',
        name: 'ok',
      })
    })

    it('censors top-level secret-bearing keys', () => {
      const { logger, lines } = makeLogger()
      logger.info({ password: 'top', accessToken: 'at', code: 'c' })
      const r = lines[0]!.record as Record<string, string>
      expect(r.password).toBe('[REDACTED]')
      expect(r.accessToken).toBe('[REDACTED]')
      expect(r.code).toBe('[REDACTED]')
    })

    it('censors secret-bearing keys nested three or more levels deep', () => {
      const { logger, lines } = makeLogger()
      logger.info({ ctx: { user: { token: 't', password: 'p', name: 'ok' } } })
      const r = lines[0]!.record as { ctx: { user: Record<string, string> } }
      expect(r.ctx.user).toEqual({
        token: '[REDACTED]',
        password: '[REDACTED]',
        name: 'ok',
      })
    })

    it('does not redact benign keys that merely contain a secret-word', () => {
      const { logger, lines } = makeLogger()
      logger.info({ tokenCount: 5, passwordHint: 'x', statusCode: 200 })
      const r = lines[0]!.record as Record<string, unknown>
      expect(r.tokenCount).toBe(5)
      expect(r.passwordHint).toBe('x')
      expect(r.statusCode).toBe(200)
    })

    it('never mutates the caller object', () => {
      const { logger } = makeLogger()
      const payload = { user: { password: 'p' } }
      logger.info(payload)
      expect(payload.user.password).toBe('p')
    })
  })

  it('serializes Error values to a readable shape', () => {
    const { logger, lines } = makeLogger()
    logger.error({ err: new Error('boom') }, 'failed')
    const r = lines[0]!.record as { err: { type: string; message: string; stack?: string } }
    expect(r.err.type).toBe('Error')
    expect(r.err.message).toBe('boom')
    expect(typeof r.err.stack).toBe('string')
  })

  it('renders a circular reference as [Circular] instead of crashing', () => {
    const { logger, lines } = makeLogger()
    const obj: Record<string, unknown> = { a: 1 }
    obj.self = obj
    expect(() => logger.info(obj, 'cycle')).not.toThrow()
    expect(lines).toHaveLength(1)
    const r = lines[0]!.record as { a: number; self: string }
    expect(r.a).toBe(1)
    expect(r.self).toBe('[Circular]')
  })

  it('does not flag a shared but acyclic reference as circular', () => {
    const { logger, lines } = makeLogger()
    const shared = { v: 7 }
    logger.info({ a: shared, b: shared })
    const r = lines[0]!.record as { a: { v: number }; b: { v: number } }
    expect(r.a).toEqual({ v: 7 })
    expect(r.b).toEqual({ v: 7 })
  })

  it('serializes BigInt values as decimal strings instead of throwing', () => {
    const { logger, lines } = makeLogger()
    expect(() => logger.info({ amount: 9007199254740993n }, 'bigint')).not.toThrow()
    expect(lines).toHaveLength(1)
    expect((lines[0]!.record as { amount: unknown }).amount).toBe('9007199254740993')
  })

  it('child() merges bindings into every record', () => {
    const { logger, lines } = makeLogger()
    const child = logger.child({ requestId: 'rq-1' })
    child.info('hi')
    expect(lines[0]!.record.requestId).toBe('rq-1')
    expect(lines[0]!.record.service).toBe('rallypoint-test')
  })

  describe('child() bindings are redaction-respected (#16)', () => {
    // Before the fix, child(bindings) stored the raw object and spread
    // it directly into every record — bypassing REDACT_PATHS entirely.
    // The per-call merge arg WAS redacted, so the inconsistency was
    // invisible until someone audited it.
    it('redacts a nested req.headers.authorization passed via child()', () => {
      const { logger, lines } = makeLogger()
      const child = logger.child({
        req: { headers: { authorization: 'Bearer abc', cookie: 'session=xyz' } },
      })
      child.info('hello')
      const r = lines[0]!.record as {
        req: { headers: Record<string, string> }
      }
      expect(r.req.headers.authorization).toBe('[REDACTED]')
      expect(r.req.headers.cookie).toBe('[REDACTED]')
    })

    it('redacts nested *.password/token/code/secret in child bindings', () => {
      const { logger, lines } = makeLogger()
      const child = logger.child({ user: { token: 't', password: 'p', name: 'ok' } })
      child.info('hi')
      const r = lines[0]!.record as { user: Record<string, string> }
      expect(r.user).toEqual({ token: '[REDACTED]', password: '[REDACTED]', name: 'ok' })
    })

    it('redacts a top-level secret-bearing key in child bindings', () => {
      // Leaf-key redaction applies at any depth, so a secret passed as a
      // top-level child binding is censored just like a per-call field.
      const { logger, lines } = makeLogger()
      const child = logger.child({ password: 'top-level-secret' })
      child.info('hi')
      expect((lines[0]!.record as { password: string }).password).toBe('[REDACTED]')
    })

    it('accumulates redaction across stacked child() calls', () => {
      const { logger, lines } = makeLogger()
      const c1 = logger.child({ req: { headers: { authorization: 'A' } } })
      const c2 = c1.child({ user: { token: 'B' } })
      c2.info('hi')
      const r = lines[0]!.record as {
        req: { headers: Record<string, string> }
        user: Record<string, string>
      }
      expect(r.req.headers.authorization).toBe('[REDACTED]')
      expect(r.user.token).toBe('[REDACTED]')
    })

    it('does NOT mutate the caller-supplied bindings object', () => {
      const { logger } = makeLogger()
      const bindings = { req: { headers: { authorization: 'plaintext' } } }
      const child = logger.child(bindings)
      child.info('hi')
      // The caller's object is still plaintext; only the cloned copy was redacted.
      expect(bindings.req.headers.authorization).toBe('plaintext')
    })
  })

  it('dev mode emits a single human line, not JSON', () => {
    const { logger, lines } = makeLogger({ dev: true })
    logger.info({ status: 200 }, 'request')
    expect(lines[0]!.raw).toBe(
      '2026-06-05T00:00:00.000Z INFO [rallypoint-test] request {"status":200}',
    )
  })
})
