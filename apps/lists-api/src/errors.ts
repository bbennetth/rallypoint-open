import { ApiError, isApiError, coreErrors } from '@rallypoint/api-kit'

export { ApiError, isApiError }

// Global/shared codes (validation, notFound, forbidden, csrfInvalid,
// unauthorized, upstreamUnavailable, conflict, rateLimited, ...) come from
// @rallypoint/api-kit's coreErrors. Lists-specific codes live below.

export const errors = {
  ...coreErrors,
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
  // Idempotent-create ran into a (list_id, ref) that's pinned to a
  // soft-deleted item. The ref is reserved; the caller must use a
  // different ref or treat the soft-delete as intentional. Mirrors
  // money-api's expenseRefTakenByDeleted.
  itemRefTakenByDeleted(detail: Record<string, unknown>): ApiError {
    return new ApiError({
      code: 'item_ref_taken_by_deleted',
      message: 'A tombstoned list item already claims this ref.',
      status: 409,
      details: detail,
    })
  },
  // Same as itemRefTakenByDeleted, scoped to the series create path.
  seriesRefTakenByDeleted(detail: Record<string, unknown>): ApiError {
    return new ApiError({
      code: 'series_ref_taken_by_deleted',
      message: 'A tombstoned series already claims this ref.',
      status: 409,
      details: detail,
    })
  },
} as const
