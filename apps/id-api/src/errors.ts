import type { ContentfulStatusCode } from 'hono/utils/http-status'

// Domain-error class used by handlers. Throwing one of these
// from any handler is the supported way to surface a structured
// 4xx response; the error-handler middleware converts the throw
// into the standard envelope (docs/design/error-shape.md).

export class ApiError extends Error {
  readonly code: string
  readonly status: ContentfulStatusCode
  readonly details?: Record<string, unknown>

  constructor(input: {
    code: string
    message: string
    status: ContentfulStatusCode
    details?: Record<string, unknown>
  }) {
    super(input.message)
    this.code = input.code
    this.status = input.status
    if (input.details !== undefined) this.details = input.details
    this.name = 'ApiError'
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError
}

// Convenience constructors for the global codes from
// docs/design/error-shape.md. Slice-specific codes get their own
// helper in the slice's directory.

export const errors = {
  validation(details: Record<string, unknown>): ApiError {
    return new ApiError({
      code: 'validation_failed',
      message: 'Request body failed validation.',
      status: 400,
      details,
    })
  },
  bodyInvalid(): ApiError {
    return new ApiError({
      code: 'body_invalid',
      message: 'Request body was not valid JSON.',
      status: 400,
    })
  },
  sessionRequired(): ApiError {
    return new ApiError({
      code: 'session_required',
      message: 'A valid session is required.',
      status: 401,
    })
  },
  bearerRequired(): ApiError {
    return new ApiError({
      code: 'bearer_required',
      message: 'A bearer token is required.',
      status: 401,
    })
  },
  bearerInvalid(): ApiError {
    return new ApiError({
      code: 'bearer_invalid',
      message: 'The bearer token did not match a valid session.',
      status: 401,
    })
  },
  csrfInvalid(): ApiError {
    return new ApiError({
      code: 'csrf_token_invalid',
      message: 'CSRF token missing or did not match.',
      status: 403,
    })
  },
  forbidden(message = 'Forbidden.'): ApiError {
    return new ApiError({ code: 'forbidden', message, status: 403 })
  },
  rateLimited(retryAfterSeconds: number, bucket: string): ApiError {
    return new ApiError({
      code: 'rate_limited',
      message: 'Too many requests, try again later.',
      status: 429,
      details: { retry_after_seconds: retryAfterSeconds, bucket },
    })
  },
} as const
