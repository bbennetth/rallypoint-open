import type { MiddlewareHandler } from 'hono'
import { createRequireAllowedOrigin } from '@rallypoint/api-kit'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'

// Origin allowlist for /api/v1/ui/* (hardened: state-changing requests must
// carry an Origin header). Shared implementation lives in @rallypoint/api-kit;
// this app supplies its allowed-origin env key.

export function requireAllowedOrigin(): MiddlewareHandler<HonoApp> {
  return createRequireAllowedOrigin({
    allowedOriginEnvKeys: ['EVENTS_UI_ORIGIN'],
    errors: { forbidden: errors.forbidden },
  }) as MiddlewareHandler<HonoApp>
}
