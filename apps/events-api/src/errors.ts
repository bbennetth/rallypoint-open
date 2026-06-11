import type { ContentfulStatusCode } from 'hono/utils/http-status'

// Domain-error class. Throwing one of these from any handler is
// the supported way to surface a structured 4xx — the
// error-handler middleware converts the throw into the standard
// envelope (docs/design/error-shape.md, which both services share).

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
// envelope. Slice 2 grows this with events-specific codes
// (`event_not_found`, `event_slug_taken`, etc.) per
// docs/design/events-v1.md §9.

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
  eventNotFound(): ApiError {
    return new ApiError({ code: 'event_not_found', message: 'Event not found.', status: 404 })
  },
  eventSlugTaken(): ApiError {
    return new ApiError({
      code: 'event_slug_taken',
      message: 'That slug is already in use.',
      status: 409,
    })
  },
  conflict(code: string, message: string): ApiError {
    return new ApiError({ code, message, status: 409 })
  },
  // --- map upload (slice 5, design §3.9/§9) ------------------------
  // Declared image too big — either byte length (field) or a decoded
  // edge (dimension). details names which limit was violated.
  imageTooLarge(details: Record<string, unknown>): ApiError {
    return new ApiError({
      code: 'image_too_large',
      message: 'Image exceeds the allowed size.',
      status: 400,
      details,
    })
  },
  imageTooSmall(details: Record<string, unknown>): ApiError {
    return new ApiError({
      code: 'image_too_small',
      message: 'Image is smaller than the allowed minimum.',
      status: 400,
      details,
    })
  },
  unsupportedImageType(): ApiError {
    return new ApiError({
      code: 'unsupported_image_type',
      message: 'Image must be JPEG, PNG, or WebP.',
      status: 400,
    })
  },
  // Bind requested before the bytes landed in object storage (the
  // presigned PUT never happened or failed). 422: the request is
  // structurally valid but the precondition (object uploaded) isn't met.
  mapObjectMissing(): ApiError {
    return new ApiError({
      code: 'map_object_missing',
      message: 'No uploaded image was found for this map. Upload before binding.',
      status: 422,
    })
  },
  // --- groups (slice 6, design §5.5/§9) -----------------------------
  groupNotFound(): ApiError {
    return new ApiError({ code: 'group_not_found', message: 'Group not found.', status: 404 })
  },
  // The join-by-code resolver matched neither an active group join code
  // nor an open group invite.
  groupJoinCodeInvalid(): ApiError {
    return new ApiError({
      code: 'group_join_code_invalid',
      message: 'That join code is not valid.',
      status: 404,
    })
  },
  // --- rallies (slice 9b) ------------------------------------------
  rallyNotFound(): ApiError {
    return new ApiError({ code: 'rally_not_found', message: 'Rally not found.', status: 404 })
  },
  // --- rate limiting -----------------------------------------------
  rateLimited(retryAfterSeconds: number, bucket: string): ApiError {
    return new ApiError({
      code: 'rate_limited',
      message: 'Too many requests, try again later.',
      status: 429,
      details: { retry_after_seconds: retryAfterSeconds, bucket },
    })
  },
} as const
