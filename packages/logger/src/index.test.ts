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

  describe('redaction (matches the prior pino redact list)', () => {
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

    it('does NOT censor top-level password (depth-1 wildcard, like pino)', () => {
      const { logger, lines } = makeLogger()
      logger.info({ password: 'top' })
      expect((lines[0]!.record as { password: string }).password).toBe('top')
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

  it('child() merges bindings into every record', () => {
    const { logger, lines } = makeLogger()
    const child = logger.child({ requestId: 'rq-1' })
    child.info('hi')
    expect(lines[0]!.record.requestId).toBe('rq-1')
    expect(lines[0]!.record.service).toBe('rallypoint-test')
  })

  it('dev mode emits a single human line, not JSON', () => {
    const { logger, lines } = makeLogger({ dev: true })
    logger.info({ status: 200 }, 'request')
    expect(lines[0]!.raw).toBe(
      '2026-06-05T00:00:00.000Z INFO [rallypoint-test] request {"status":200}',
    )
  })
})
