import { ApiError, isApiError, coreErrors } from '@rallypoint/api-kit'

export { ApiError, isApiError }

// Global/shared codes (validation, notFound, forbidden, csrfInvalid,
// unauthorized, upstreamUnavailable, conflict, rateLimited, ...) come from
// @rallypoint/api-kit's coreErrors. Events-specific codes live below
// (docs/design/events-v1.md §9).

export const errors = {
  ...coreErrors,
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
  // A ref-idempotency replay matched a soft-deleted event. Return 409
  // rather than resurrecting the tombstone (mirrors lists-api's
  // item_ref_taken_by_deleted / money-api's expense_ref_taken_by_deleted).
  eventRefTakenByDeleted(detail: Record<string, unknown>): ApiError {
    return new ApiError({
      code: 'event_ref_taken_by_deleted',
      message: 'A tombstoned event already claims this ref.',
      status: 409,
      details: detail,
    })
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
  // `message` is overridable because not every image surface accepts the
  // same set: app icons are PNG-only (iOS apple-touch-icon only renders
  // PNG reliably), so the default map-oriented text would misinform.
  unsupportedImageType(message = 'Image must be JPEG, PNG, or WebP.'): ApiError {
    return new ApiError({
      code: 'unsupported_image_type',
      message,
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
} as const
