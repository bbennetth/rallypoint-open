import type { MiddlewareHandler } from 'hono'
import { createRequireAllowedOrigin } from '@rallypoint/api-kit'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'

// Origin allowlist for /api/v1/ui/*. Shared (hardened) implementation lives in
// @rallypoint/api-kit; this app supplies its allowed-origin env key. As of the
// api-kit extraction, admin-api uses the hardened variant its five siblings
// already had: state-changing requests (POST/PUT/PATCH/DELETE) that omit the
// Origin header are now rejected (403), not allowed through.

export function requireAllowedOrigin(): MiddlewareHandler<HonoApp> {
  return createRequireAllowedOrigin({
    allowedOriginEnvKeys: ['ADMIN_UI_ORIGIN'],
    errors: { forbidden: errors.forbidden },
  }) as MiddlewareHandler<HonoApp>
}
