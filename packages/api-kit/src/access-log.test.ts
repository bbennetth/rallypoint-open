import { describe, it, expect, vi } from 'vitest'
import { createAccessLog } from './access-log.js'

// The middleware reads a small structural view of the per-app Hono context;
// a hand-rolled fake is enough (no Hono server needed), mirroring session.test.ts.

function makeCtx(over: { status?: number; method?: string; path?: string } = {}) {
  const info = vi.fn()
  return {
    ctx: {
      var: { logger: { info }, requestId: 'req_123' },
      req: { method: over.method ?? 'GET', path: over.path ?? '/api/v1/thing' },
      res: { status: over.status ?? 200 },
    },
    info,
  }
}

describe('createAccessLog', () => {
  it('logs one info line after next() with the request fields', async () => {
    const { ctx, info } = makeCtx({ status: 201, method: 'POST', path: '/api/v1/ui/x' })
    const next = vi.fn(async () => {})

    await createAccessLog()(ctx as never, next)

    expect(next).toHaveBeenCalledOnce()
    expect(info).toHaveBeenCalledOnce()
    const [obj, msg] = info.mock.calls[0] as [Record<string, unknown>, string]
    expect(msg).toBe('request')
    expect(obj).toMatchObject({
      requestId: 'req_123',
      method: 'POST',
      path: '/api/v1/ui/x',
      status: 201,
    })
    expect(typeof obj.durationMs).toBe('number')
    expect(obj.durationMs as number).toBeGreaterThanOrEqual(0)
  })

  it('logs only after next() resolves (ordering)', async () => {
    const { ctx, info } = makeCtx()
    const order: string[] = []
    const next = vi.fn(async () => {
      order.push('next')
      expect(info).not.toHaveBeenCalled()
    })

    await createAccessLog()(ctx as never, next)
    order.push('logged')

    expect(order).toEqual(['next', 'logged'])
    expect(info).toHaveBeenCalledOnce()
  })
})
