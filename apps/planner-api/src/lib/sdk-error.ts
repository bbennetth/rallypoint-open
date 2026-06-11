import { ListsClientError } from '@rallypoint/lists-client'
import { EventsClientError } from '@rallypoint/events-client'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ANTI_FINGERPRINT_NOT_FOUND } from '@rallypoint/shared'
import { ApiError, errors } from '../errors.js'
import { createLogger } from '@rallypoint/logger'
import type { Logger } from '../logger.js'

// The lists/events SDK app-api-key gate (apps/{lists,events}-api/src/
// middleware/app-api-key.ts) returns this EXACT envelope — status 404,
// code 'not_found', message 'Route not found.' — when NO peer key is
// configured on the upstream worker at all (anti-fingerprint: "this route
// doesn't exist here"). For planner it never means a genuinely missing
// route: the /api/v1/sdk/* paths the clients call always exist. It means
// the shared PLANNER_API_KEY/EVENTS_API_KEY secret isn't set on the
// upstream — in prod the identical dev-default keys are disabled, so an
// un-pushed secret leaves the gate holding zero keys. Forwarding it
// verbatim makes a deploy/secrets gap look like planner's own /ui route is
// missing, so the proxies remap it to a 502 bad_gateway. Any OTHER 404 (a
// genuine resource-not-found, which carries a different message) still
// passes through unchanged.
function isSdkGateMiss(err: { status: number; code: string; message: string }): boolean {
  return (
    err.status === 404 &&
    err.code === ANTI_FINGERPRINT_NOT_FOUND.code &&
    err.message === ANTI_FINGERPRINT_NOT_FOUND.message
  )
}

// planner-api is a thin BFF over the Lists SDK; a ListsClientError carries
// the upstream error envelope (status/code/message/details, shared verbatim
// across services). Re-throw it as an ApiError so planner's error-handler
// emits the same envelope and preserves the upstream status. A
// non-ListsClientError (a transport failure reaching lists-api) is left to
// bubble to the 500 handler — a Lists outage is not a client 4xx.
export async function proxyLists<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ListsClientError) {
      if (isSdkGateMiss(err)) {
        throw errors.badGateway('The Lists service is unavailable.')
      }
      throw new ApiError({
        code: err.code,
        message: err.message,
        status: err.status as ContentfulStatusCode,
        ...(err.details !== undefined
          ? { details: err.details as Record<string, unknown> }
          : {}),
      })
    }
    throw err
  }
}

// Best-effort variant for additive data: swallow ANY failure (an upstream
// error envelope or a transport failure reaching the service) and return the
// fallback. Used for the group (festival) events folded into upcoming/my-day —
// those are supplementary to the actor's tasks + personal events, so an
// events-api hiccup degrades to the fallback rather than failing the whole view.
// Note: this also swallows programmer errors thrown inside `fn` (surfacing only
// as missing data, not a 500) — keep `fn` a thin SDK call so there's little to
// hide.
// Every swallowed failure emits a structured warn instead of becoming a
// silent data gap. Callers may pass `logger` (c.var.logger) to carry the
// request context; without one the module-level service logger fires, so
// the warn can never be silently skipped.
const fallbackLogger = createLogger({ service: 'rallypoint-planner' })

export async function bestEffort<T>(
  fn: () => Promise<T>,
  fallback: T,
  logger?: Logger,
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    ;(logger ?? fallbackLogger).warn({ err }, 'bestEffort: swallowed failure, returning fallback')
    return fallback
  }
}

// The Events SDK analogue of proxyLists (slice 7). Same posture: map an
// EventsClientError's upstream envelope onto an ApiError so the status/code
// pass through verbatim; let a transport failure bubble to the 500 handler.
export async function proxyEvents<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof EventsClientError) {
      if (isSdkGateMiss(err)) {
        throw errors.badGateway('The Events service is unavailable.')
      }
      throw new ApiError({
        code: err.code,
        message: err.message,
        status: err.status as ContentfulStatusCode,
        ...(err.details !== undefined
          ? { details: err.details as Record<string, unknown> }
          : {}),
      })
    }
    throw err
  }
}
