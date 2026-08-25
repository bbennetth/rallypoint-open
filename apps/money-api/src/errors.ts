import { ApiError, isApiError, coreErrors } from '@rallypoint/api-kit'

export { ApiError, isApiError }

// Global/shared codes (validation, notFound, forbidden, csrfInvalid,
// unauthorized, upstreamUnavailable, conflict, rateLimited, ...) come from
// @rallypoint/api-kit's coreErrors. Money-specific codes live below.

export const errors = {
  ...coreErrors,
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
} as const
