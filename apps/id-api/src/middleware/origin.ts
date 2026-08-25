import type { MiddlewareHandler } from 'hono'
import { createRequireAllowedOrigin } from '@rallypoint/api-kit'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'

// Origin allowlist for /api/v1/ui/* (hardened: state-changing requests must
// carry an Origin header). Shared implementation lives in @rallypoint/api-kit;
// id-api allows two origins: UI_ORIGIN (the hosted UI) and PUBLIC_BASE_URL
// (the API's own origin — for the slice-2 inline /verify-email page which is
// served by the API and POSTs back to itself).

export function requireAllowedOrigin(): MiddlewareHandler<HonoApp> {
  return createRequireAllowedOrigin({
    allowedOriginEnvKeys: ['UI_ORIGIN', 'PUBLIC_BASE_URL'],
    errors: { forbidden: errors.forbidden },
  }) as MiddlewareHandler<HonoApp>
}
