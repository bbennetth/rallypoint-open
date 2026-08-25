import { ApiError, isApiError, coreErrors } from '@rallypoint/api-kit'

export { ApiError, isApiError }

// Global/shared codes (validation, notFound, forbidden, csrfInvalid,
// unauthorized, upstreamUnavailable, conflict, rateLimited, ...) come from
// @rallypoint/api-kit's coreErrors. Planner-specific codes live below.

export const errors = {
  ...coreErrors,
  // A peer service (lists/events) returned a response the BFF can't act on
  // — notably the SDK gate's anti-fingerprint 404 when no peer API key is
  // configured upstream (see isSdkGateMiss in lib/sdk-error.ts). Surface a
  // 502 so it reads as a gateway problem rather than a missing planner route.
  badGateway(message = 'Upstream service is unavailable.'): ApiError {
    return new ApiError({ code: 'bad_gateway', message, status: 502 })
  },
} as const
