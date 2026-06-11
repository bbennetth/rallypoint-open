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
// envelope. Slices 2+ grow this with money-specific codes as the
// ledger/expense/settlement surfaces land.

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
  ledgerNotFound(): ApiError {
    return new ApiError({ code: 'ledger_not_found', message: 'Ledger not found.', status: 404 })
  },
  ledgerGroupNotFound(): ApiError {
    return new ApiError({
      code: 'ledger_group_not_found',
      message: 'Ledger group not found.',
      status: 404,
    })
  },
  // Used for both "join code does not match anything" and "expired"
  // until the resolver layer narrows it. The variants below split the
  // post-resolution states for clearer UX.
  inviteCodeInvalid(): ApiError {
    return new ApiError({
      code: 'ledger_invite_code_invalid',
      message: 'Invite code is invalid.',
      status: 404,
    })
  },
  inviteAlreadyConsumed(): ApiError {
    return new ApiError({
      code: 'ledger_invite_already_consumed',
      message: 'Invite has already been used.',
      status: 409,
    })
  },
  inviteExpired(): ApiError {
    return new ApiError({
      code: 'ledger_invite_expired',
      message: 'Invite has expired.',
      status: 400,
    })
  },
  expenseNotFound(): ApiError {
    return new ApiError({
      code: 'expense_not_found',
      message: 'Expense not found.',
      status: 404,
    })
  },
  // Surfaced when the engine rejects a split payload (e.g. by_amount
  // rows don't sum to total, or a participant isn't a ledger member).
  // The details field carries the specific reason so the UI can render
  // a helpful message.
  splitInvalid(detail: Record<string, unknown>): ApiError {
    return new ApiError({
      code: 'split_invalid',
      message: 'Split payload is invalid.',
      status: 400,
      details: detail,
    })
  },
  settlementNotFound(): ApiError {
    return new ApiError({
      code: 'settlement_not_found',
      message: 'Settlement not found.',
      status: 404,
    })
  },
  // Surfaced when a settlement names a from/to that isn't a current
  // ledger member, or names the same user twice. details.violation
  // disambiguates.
  settlementInvalid(detail: Record<string, unknown>): ApiError {
    return new ApiError({
      code: 'settlement_invalid',
      message: 'Settlement payload is invalid.',
      status: 400,
      details: detail,
    })
  },
  categoryNotFound(): ApiError {
    return new ApiError({
      code: 'category_not_found',
      message: 'Category not found.',
      status: 404,
    })
  },
  categoryNameTaken(): ApiError {
    return new ApiError({
      code: 'category_name_taken',
      message: 'A category with that name already exists on this ledger.',
      status: 409,
    })
  },
  // Tried to set an expense's category_id to a category that doesn't
  // belong to the same ledger (or doesn't exist).
  categoryWrongLedger(): ApiError {
    return new ApiError({
      code: 'category_wrong_ledger',
      message: 'Category does not belong to this ledger.',
      status: 400,
    })
  },
  // Idempotent-create ran into a (ledger_id, ref) that's pinned to a
  // soft-deleted expense. The ref is reserved; the caller must use a
  // different ref or treat the soft-delete as intentional.
  expenseRefTakenByDeleted(detail: Record<string, unknown>): ApiError {
    return new ApiError({
      code: 'expense_ref_taken_by_deleted',
      message: 'A tombstoned expense already claims this ref.',
      status: 409,
      details: detail,
    })
  },
  receiptTooLarge(detail: Record<string, unknown>): ApiError {
    return new ApiError({
      code: 'receipt_too_large',
      message: 'Receipt exceeds the size cap.',
      status: 400,
      details: detail,
    })
  },
  receiptNotFound(): ApiError {
    return new ApiError({
      code: 'receipt_not_found',
      message: 'No receipt is attached to this expense.',
      status: 404,
    })
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
