import type { Context } from 'hono'
import { ulid } from 'ulid'
import type { HonoApp } from '../context.js'
import { isApiError, type ApiError } from '../errors.js'

// Top-level error handler. Converts thrown errors into the
// {error: {code, message, details?}} envelope from
// docs/design/error-shape.md (reused verbatim by the events doc
// per §9). 5xx paths emit a ULID `error_id` and log the underlying
// exception without exposing the stack to the client.

export async function errorHandler(err: Error, c: Context<HonoApp>): Promise<Response> {
  if (isApiError(err)) {
    const apiErr = err as ApiError
    c.var.logger?.info(
      { requestId: c.var.requestId, code: apiErr.code, status: apiErr.status },
      'request rejected',
    )
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
