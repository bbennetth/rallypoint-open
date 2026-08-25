import { ApiError, isApiError, coreErrors } from '@rallypoint/api-kit'

export { ApiError, isApiError }

// Global/shared codes (validation, notFound, forbidden, csrfInvalid,
// unauthorized, upstreamUnavailable, conflict, rateLimited, ...) come from
// @rallypoint/api-kit's coreErrors. Fitness-domain codes live below.

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
  // Workers AI reported transient capacity/rate pressure (AiError 3040 /
  // httpCode 429, "Capacity temporarily exceeded"). Distinct from our own
  // rate_limited (429): this is the upstream model provider, not our
  // limiter — a 503 the client may retry after a short wait. The server
  // already retried a bounded number of times before surfacing this.
  aiCapacity(retryAfterSeconds = 5): ApiError {
    return new ApiError({
      code: 'ai_capacity',
      message: 'The photo analyzer is briefly at capacity. Try again in a moment.',
      status: 503,
      details: { retry_after_seconds: retryAfterSeconds },
    })
  },
  // A vision pass failed for a non-capacity reason (model returned no
  // usable JSON, an upstream error, etc). Enveloped 502 so the browser
  // client gets a real code + message instead of a bare `{error: string}`
  // body that parseError() can only render as "Request failed (502).".
  // Shared by every AI scan surface (food/drink/label/WOD).
  scanFailed(message = 'Could not read that photo.'): ApiError {
    return new ApiError({ code: 'scan_failed', message, status: 502 })
  },
  // A vision pass succeeded but produced an unusable result (e.g. a
  // nutrition label with no legible serving size). 422 — retaking a
  // sharper photo is the fix, not a retry of the same bytes.
  scanUnreadable(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError({
      code: 'scan_unreadable',
      message,
      status: 422,
      ...(details !== undefined ? { details } : {}),
    })
  },
} as const
