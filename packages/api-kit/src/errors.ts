import type { ContentfulStatusCode } from 'hono/utils/http-status'

// Domain-error class + the global convenience constructors from
// docs/design/error-shape.md. Throwing an ApiError from any handler is the
// supported way to surface a structured 4xx/5xx — the error-handler
// middleware (createErrorHandler) converts the throw into the standard
// envelope.
//
// The class and isApiError were byte-identical across all seven HTTP APIs,
// and the generic factories below (validation/notFound/forbidden/...) were
// copy-pasted alongside them — the same "fixed in one, drifts in the others"
// anti-pattern epic #675 exists to stop. Apps spread `coreErrors` into their
// own `errors` object and add their domain-specific constructors on top.

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

// Global convenience constructors mirroring the platform error envelope.
// `csrfInvalid`'s message is overridable so id-api's wording variant
// ('…did not match.') is an override, not a fork.

export const coreErrors = {
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
  notFound(message = 'Resource not found.'): ApiError {
    return new ApiError({ code: 'not_found', message, status: 404 })
  },
  forbidden(message = 'Forbidden.'): ApiError {
    return new ApiError({ code: 'forbidden', message, status: 403 })
  },
  csrfInvalid(message = 'CSRF token missing or invalid.'): ApiError {
    return new ApiError({ code: 'csrf_token_invalid', message, status: 403 })
  },
  // Session bearer missing / unrecognised / revoked. The session
  // middleware pairs this with a Set-Cookie that clears the cookie.
  unauthorized(message = 'Authentication required.'): ApiError {
    return new ApiError({ code: 'unauthorized', message, status: 401 })
  },
  // RPID was unreachable while verifying the replayed bearer. NOT a
  // revocation — the session row is preserved so a transient RPID
  // hiccup doesn't sign everyone out.
  upstreamUnavailable(message = 'Authentication service unavailable.'): ApiError {
    return new ApiError({ code: 'upstream_unavailable', message, status: 503 })
  },
  conflict(code: string, message: string): ApiError {
    return new ApiError({ code, message, status: 409 })
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
