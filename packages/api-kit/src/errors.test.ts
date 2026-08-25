import { describe, it, expect } from 'vitest'
import { ApiError, isApiError, coreErrors } from './errors.js'

describe('ApiError / isApiError', () => {
  it('constructs with code/status/message and optional details', () => {
    const e = new ApiError({ code: 'x', message: 'boom', status: 418, details: { a: 1 } })
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('ApiError')
    expect(e.code).toBe('x')
    expect(e.status).toBe(418)
    expect(e.message).toBe('boom')
    expect(e.details).toEqual({ a: 1 })
  })

  it('omits details when not supplied', () => {
    const e = new ApiError({ code: 'x', message: 'no details', status: 400 })
    expect(e.details).toBeUndefined()
  })

  it('isApiError narrows only genuine ApiErrors', () => {
    expect(isApiError(new ApiError({ code: 'x', message: 'm', status: 400 }))).toBe(true)
    expect(isApiError(new Error('plain'))).toBe(false)
    expect(isApiError({ code: 'x' })).toBe(false)
    expect(isApiError(null)).toBe(false)
  })
})

describe('coreErrors', () => {
  it('validation → 400 validation_failed carrying details', () => {
    const e = coreErrors.validation({ field: 'name' })
    expect([e.code, e.status]).toEqual(['validation_failed', 400])
    expect(e.details).toEqual({ field: 'name' })
  })

  it('bodyInvalid → 400 body_invalid', () => {
    const e = coreErrors.bodyInvalid()
    expect([e.code, e.status, e.message]).toEqual([
      'body_invalid',
      400,
      'Request body was not valid JSON.',
    ])
  })

  it('notFound/forbidden/unauthorized/upstreamUnavailable use defaults and accept overrides', () => {
    expect(coreErrors.notFound().message).toBe('Resource not found.')
    expect(coreErrors.notFound('Gone.').message).toBe('Gone.')
    expect([coreErrors.forbidden().code, coreErrors.forbidden().status]).toEqual(['forbidden', 403])
    expect([coreErrors.unauthorized().code, coreErrors.unauthorized().status]).toEqual([
      'unauthorized',
      401,
    ])
    expect([
      coreErrors.upstreamUnavailable().code,
      coreErrors.upstreamUnavailable().status,
    ]).toEqual(['upstream_unavailable', 503])
  })

  it('csrfInvalid defaults to the shared wording and accepts an override', () => {
    const def = coreErrors.csrfInvalid()
    expect([def.code, def.status, def.message]).toEqual([
      'csrf_token_invalid',
      403,
      'CSRF token missing or invalid.',
    ])
    // id-api's variant is an override of the same code, not a fork.
    expect(coreErrors.csrfInvalid('CSRF token missing or did not match.').message).toBe(
      'CSRF token missing or did not match.',
    )
  })

  it('conflict → 409 with caller-supplied code/message', () => {
    const e = coreErrors.conflict('slug_taken', 'That slug is taken.')
    expect([e.code, e.status, e.message]).toEqual(['slug_taken', 409, 'That slug is taken.'])
  })

  it('rateLimited → 429 with retry_after_seconds + bucket in details', () => {
    const e = coreErrors.rateLimited(42, 'ip:signin')
    expect([e.code, e.status]).toEqual(['rate_limited', 429])
    expect(e.details).toEqual({ retry_after_seconds: 42, bucket: 'ip:signin' })
  })
})
