import type { Context } from 'hono'
import { ulid } from 'ulid'
import { createExceptionCapture, errorCauseChain, posthogSessionProps } from '@rallypoint/logger'
import { isApiError, type ApiError } from './errors.js'

// Top-level error handler. Converts thrown errors into the
// {error: {code, message, details?}} envelope from docs/design/error-shape.md.
// 5xx paths emit a ULID `error_id`, log the underlying exception without
// exposing the stack to the client, and ship a $exception event to PostHog
// error tracking (no-op when POSTHOG_KEY is unset).
//
// Copy-pasted across all seven HTTP APIs, differing only by the `service`
// string (and planner-api's warn-on-5xx logging opt-in); it lives here once
// now, configured via createErrorHandler({ service, ... }).

interface ErrorHandlerCtxVars {
  env?: { POSTHOG_KEY?: string; POSTHOG_HOST?: string } & Record<string, unknown>
  requestId: string
  logger?: {
    info(obj: object, msg: string): void
    warn(obj: object, msg: string): void
    error(obj: object, msg: string): void
  }
}

export interface ErrorHandlerConfig {
  /** Service tag on captured $exception events, e.g. `'rallypoint-events'`. */
  service: string
  /**
   * planner-api only. When true, ApiErrors with a 5xx status are logged at
   * `warn` with their message (operational problems worth surfacing, e.g.
   * bad_gateway / upstream_unavailable when a peer RPC binding call fails);
   * 4xx stay at `info`. The other apps log every ApiError at `info` without
   * the message. Defaults to false.
   */
  warnOnServerApiErrors?: boolean
}

export function createCaptureServerException(config: ErrorHandlerConfig) {
  const service = config.service
  return (c: Context, err: unknown, properties: Record<string, unknown>): void => {
    const vars = c.var as unknown as ErrorHandlerCtxVars
    const send = createExceptionCapture({
      apiKey: vars.env?.POSTHOG_KEY,
      host: vars.env?.POSTHOG_HOST,
      service,
    })(err, {
      requestId: vars.requestId,
      path: c.req.path,
      method: c.req.method,
      // posthog-js session id forwarded by web-kit's csrf client — links this
      // server $exception to the browser session replay in PostHog.
      ...posthogSessionProps(c.req.header('x-posthog-session-id')),
      ...properties,
    })
    try {
      c.executionCtx.waitUntil(send)
    } catch {
      // No execution context (some test harnesses) — fire and forget.
      void send
    }
  }
}

export function createErrorHandler(config: ErrorHandlerConfig) {
  const capture = createCaptureServerException(config)
  return async (err: Error, c: Context): Promise<Response> => {
    const vars = c.var as unknown as ErrorHandlerCtxVars
    if (isApiError(err)) {
      const apiErr = err as ApiError
      if (config.warnOnServerApiErrors) {
        const meta = {
          requestId: vars.requestId,
          code: apiErr.code,
          status: apiErr.status,
          message: apiErr.message,
        }
        if (apiErr.status >= 500) vars.logger?.warn(meta, 'request rejected')
        else vars.logger?.info(meta, 'request rejected')
      } else {
        vars.logger?.info(
          { requestId: vars.requestId, code: apiErr.code, status: apiErr.status },
          'request rejected',
        )
      }
      return c.json(
        {
          error: {
            code: apiErr.code,
            message: apiErr.message,
            details: apiErr.details ?? undefined,
          },
        },
        apiErr.status,
      )
    }
    const errorId = ulid()
    // Wrapper errors (drizzle D1) hide the real failure on `.cause` — log
    // the chain so Workers logs show the actionable text, not just
    // "Failed query: …".
    const causes = errorCauseChain(err)
    vars.logger?.error(
      {
        requestId: vars.requestId,
        errorId,
        err: {
          message: err.message,
          stack: err.stack,
          name: err.name,
          ...(causes.length > 0 ? { causes } : {}),
        },
      },
      'unhandled error',
    )
    capture(c, err, { errorId, status: 500 })
    return c.json(
      {
        error: {
          code: 'internal_error',
          message: 'An unexpected error occurred.',
          details: { error_id: errorId },
        },
      },
      500,
    )
  }
}
