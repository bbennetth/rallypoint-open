import type { Context } from 'hono'
import { ulid } from 'ulid'
import type { HonoApp } from '../context.js'
import { isApiError, type ApiError } from '../errors.js'

// Top-level error handler. Converts thrown errors into the
// {error: {code, message, details?}} envelope from
// docs/design/error-shape.md (shared verbatim across services). 5xx
// paths emit a ULID `error_id` and log the underlying exception
// without exposing the stack to the client.

export async function errorHandler(err: Error, c: Context<HonoApp>): Promise<Response> {
  if (isApiError(err)) {
    const apiErr = err as ApiError
    const meta = {
      requestId: c.var.requestId,
      code: apiErr.code,
      status: apiErr.status,
      message: apiErr.message,
    }
    // 5xx ApiErrors are operational problems worth surfacing at warn with
    // the message (e.g. bad_gateway when a peer SDK gate rejects because its
    // PLANNER_API_KEY isn't configured, or upstream_unavailable); 4xx are
    // routine client rejections kept at info.
    if (apiErr.status >= 500) c.var.logger?.warn(meta, 'request rejected')
    else c.var.logger?.info(meta, 'request rejected')
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
  c.var.logger?.error(
    {
      requestId: c.var.requestId,
      errorId,
      err: { message: err.message, stack: err.stack, name: err.name },
    },
    'unhandled error',
  )
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
