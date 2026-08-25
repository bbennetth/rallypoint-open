import { describe, it, expect, vi, beforeEach } from 'vitest'

// Record every createExceptionCapture(config)(err, properties) call so tests
// can assert the service tag + properties flow through without a real PostHog.
const { captureCalls } = vi.hoisted(() => ({
  captureCalls: [] as Array<{ config: unknown; err: unknown; properties: unknown }>,
}))

vi.mock('@rallypoint/logger', async (importOriginal) => ({
  // Real module for pure helpers (errorCauseChain); only the capture path
  // is stubbed to record calls.
  ...(await importOriginal<typeof import('@rallypoint/logger')>()),
  createExceptionCapture: (config: unknown) => (err: unknown, properties: unknown) => {
    captureCalls.push({ config, err, properties })
    return Promise.resolve()
  },
  posthogSessionProps: (id: string | undefined) => (id ? { $session_id: id } : {}),
}))

import { createErrorHandler, createCaptureServerException } from './error-handler.js'
import { ApiError } from './errors.js'

function makeCtx(over: { env?: Record<string, unknown>; sessionId?: string } = {}) {
  const info = vi.fn()
  const warn = vi.fn()
  const error = vi.fn()
  const waitUntil = vi.fn()
  const ctx = {
    var: {
      env: over.env ?? {},
      requestId: 'req_1',
      logger: { info, warn, error },
    },
    req: {
      path: '/api/v1/thing',
      method: 'POST',
      header: (name: string) => (name === 'x-posthog-session-id' ? over.sessionId : undefined),
    },
    executionCtx: { waitUntil },
    json: (body: unknown, status: number) => ({ body, status }),
  }
  return { ctx, info, warn, error, waitUntil }
}

beforeEach(() => {
  captureCalls.length = 0
})

describe('createErrorHandler — ApiError (default mode)', () => {
  it('returns the {error} envelope at the ApiError status and logs at info without message', async () => {
    const handler = createErrorHandler({ service: 'rallypoint-events' })
    const { ctx, info, warn } = makeCtx()

    const res = (await handler(
      new ApiError({ code: 'not_found', message: 'nope', status: 404, details: { id: 1 } }),
      ctx as never,
    )) as unknown as { body: { error: unknown }; status: number }

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'nope', details: { id: 1 } } })
    expect(info).toHaveBeenCalledWith(
      { requestId: 'req_1', code: 'not_found', status: 404 },
      'request rejected',
    )
    expect(warn).not.toHaveBeenCalled()
    // ApiErrors are handled, never captured to PostHog.
    expect(captureCalls).toHaveLength(0)
  })
})

describe('createErrorHandler — unknown error', () => {
  it('returns 500 internal_error with a ULID error_id, logs at error, and captures with the service', async () => {
    const handler = createErrorHandler({ service: 'rallypoint-events' })
    const { ctx, error, waitUntil } = makeCtx({ env: { POSTHOG_KEY: 'phc_x' } })

    const res = (await handler(new Error('kaboom'), ctx as never)) as unknown as {
      body: { error: { code: string; message: string; details: { error_id: string } } }
      status: number
    }

    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('internal_error')
    const errorId = res.body.error.details.error_id
    // ULID: 26-char Crockford base32 (no I/L/O/U).
    expect(errorId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(error).toHaveBeenCalledOnce()
    expect(waitUntil).toHaveBeenCalledOnce()

    expect(captureCalls).toHaveLength(1)
    expect(captureCalls[0].config).toMatchObject({ service: 'rallypoint-events', apiKey: 'phc_x' })
    expect(captureCalls[0].properties).toMatchObject({
      requestId: 'req_1',
      path: '/api/v1/thing',
      method: 'POST',
      errorId,
      status: 500,
    })
  })

  it('logs the cause chain of a wrapper error (drizzle-d1 shape)', async () => {
    const handler = createErrorHandler({ service: 'rallypoint-events' })
    const { ctx, error } = makeCtx()

    const wrapped = new Error('Failed query: select "id_hash" from "sessions" …', {
      cause: new Error('D1_ERROR: Network connection lost.'),
    })
    await handler(wrapped, ctx as never)

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ causes: ['Error: D1_ERROR: Network connection lost.'] }),
      }),
      'unhandled error',
    )
  })
})

describe('createErrorHandler — planner warn-on-5xx opt-in', () => {
  it('logs 5xx ApiErrors at warn with the message', async () => {
    const handler = createErrorHandler({
      service: 'rallypoint-planner',
      warnOnServerApiErrors: true,
    })
    const { ctx, warn, info } = makeCtx()

    await handler(
      new ApiError({ code: 'bad_gateway', message: 'Upstream down.', status: 502 }),
      ctx as never,
    )

    expect(warn).toHaveBeenCalledWith(
      { requestId: 'req_1', code: 'bad_gateway', status: 502, message: 'Upstream down.' },
      'request rejected',
    )
    expect(info).not.toHaveBeenCalled()
  })

  it('keeps 4xx ApiErrors at info (with the message in meta)', async () => {
    const handler = createErrorHandler({
      service: 'rallypoint-planner',
      warnOnServerApiErrors: true,
    })
    const { ctx, warn, info } = makeCtx()

    await handler(
      new ApiError({ code: 'validation_failed', message: 'bad', status: 400 }),
      ctx as never,
    )

    expect(info).toHaveBeenCalledWith(
      { requestId: 'req_1', code: 'validation_failed', status: 400, message: 'bad' },
      'request rejected',
    )
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('createCaptureServerException', () => {
  it('forwards requestId/path/method + forwarded session id + caller properties', () => {
    const capture = createCaptureServerException({ service: 'rallypoint-svc' })
    const { ctx, waitUntil } = makeCtx({ env: { POSTHOG_KEY: 'k' }, sessionId: 'sess_abc123' })

    capture(ctx as never, new Error('x'), { extra: 1 })

    expect(waitUntil).toHaveBeenCalledOnce()
    expect(captureCalls[0].properties).toMatchObject({
      requestId: 'req_1',
      path: '/api/v1/thing',
      method: 'POST',
      $session_id: 'sess_abc123',
      extra: 1,
    })
  })

  it('swallows a missing execution context (waitUntil throws)', () => {
    const capture = createCaptureServerException({ service: 's' })
    const { ctx } = makeCtx()
    ctx.executionCtx.waitUntil = () => {
      throw new Error('no execution context')
    }
    expect(() => capture(ctx as never, new Error('x'), {})).not.toThrow()
  })
})
