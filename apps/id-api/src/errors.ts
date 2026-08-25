import { ApiError, isApiError, coreErrors } from '@rallypoint/api-kit'

export { ApiError, isApiError }

// Shared codes come from @rallypoint/api-kit's coreErrors. id-api uses an
// auth-centric subset (no notFound/unauthorized/upstreamUnavailable/conflict)
// plus its own session/bearer taxonomy below, so it picks the specific core
// keys it uses rather than spreading the whole set (which would silently widen
// what id-api handlers could throw). Its csrfInvalid keeps id-api's original
// wording as an override of the same code.

export const errors = {
  validation: coreErrors.validation,
  bodyInvalid: coreErrors.bodyInvalid,
  forbidden: coreErrors.forbidden,
  rateLimited: coreErrors.rateLimited,
  csrfInvalid: (): ApiError => coreErrors.csrfInvalid('CSRF token missing or did not match.'),
  sessionRequired(): ApiError {
    return new ApiError({
      code: 'session_required',
      message: 'A valid session is required.',
      status: 401,
    })
  },
  bearerRequired(): ApiError {
    return new ApiError({
      code: 'bearer_required',
      message: 'A bearer token is required.',
      status: 401,
    })
  },
  bearerInvalid(): ApiError {
    return new ApiError({
      code: 'bearer_invalid',
      message: 'The bearer token did not match a valid session.',
      status: 401,
    })
  },
} as const
