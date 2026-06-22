import type { ContentfulStatusCode } from 'hono/utils/http-status'

// Domain-error class. Throwing one of these from any handler is the
// supported way to surface a structured 4xx — the error-handler
// middleware converts the throw into the standard envelope
// (docs/design/error-shape.md, shared verbatim across services).

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

// Global convenience constructors mirroring the platform error
// envelope. Slices 2+ grow this with lists-specific codes as the
// item/group/per-type surfaces land.

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
  notFound(message = 'Resource not found.'): ApiError {
    return new ApiError({ code: 'not_found', message, status: 404 })
  },
  forbidden(message = 'Forbidden.'): ApiError {
    return new ApiError({ code: 'forbidden', message, status: 403 })
  },
  csrfInvalid(): ApiError {
    return new ApiError({
      code: 'csrf_token_invalid',
      message: 'CSRF token missing or invalid.',
      status: 403,
    })
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
  // Semantically-invalid request the schema can't catch (422). Used by the
  // cross-list move when the item shape forbids the move (e.g. a series
  // occurrence — move the series, not one materialized occurrence).
  unprocessable(code: string, message: string): ApiError {
    return new ApiError({ code, message, status: 422 })
  },
  listNotFound(): ApiError {
    return new ApiError({ code: 'list_not_found', message: 'List not found.', status: 404 })
  },
  itemNotFound(): ApiError {
    return new ApiError({ code: 'item_not_found', message: 'List item not found.', status: 404 })
  },
  groupNotFound(): ApiError {
    return new ApiError({ code: 'group_not_found', message: 'Group not found.', status: 404 })
  },
  fieldDefNotFound(): ApiError {
    return new ApiError({ code: 'field_def_not_found', message: 'Field not found.', status: 404 })
  },
  statusNotFound(): ApiError {
    return new ApiError({ code: 'status_not_found', message: 'Status not found.', status: 404 })
  },
  commentNotFound(): ApiError {
    return new ApiError({ code: 'comment_not_found', message: 'Comment not found.', status: 404 })
  },
  labelNotFound(): ApiError {
    return new ApiError({ code: 'label_not_found', message: 'Label not found.', status: 404 })
  },
  viewNotFound(): ApiError {
    return new ApiError({ code: 'view_not_found', message: 'View not found.', status: 404 })
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
