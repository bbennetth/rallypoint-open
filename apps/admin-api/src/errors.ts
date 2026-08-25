import { ApiError, isApiError, coreErrors } from '@rallypoint/api-kit'

export { ApiError, isApiError }

// Global/shared codes (validation, notFound, forbidden, csrfInvalid,
// unauthorized, upstreamUnavailable, conflict, rateLimited, ...) come from
// @rallypoint/api-kit's coreErrors. Admin-domain slices add their own codes
// here as domain surfaces land.

export const errors = {
  ...coreErrors,
  // Scan-photo size gate. A dedicated top-level message (rather than a
  // validation issue buried in details) because the web client's error
  // banner only renders `message` — "Request body failed validation."
  // told users nothing about oversized photos.
  imageTooLarge(maxBytes: number): ApiError {
    return new ApiError({
      code: 'image_too_large',
      message: `Image is too large (${Math.round(maxBytes / (1024 * 1024))} MiB max).`,
      status: 400,
    })
  },
} as const
