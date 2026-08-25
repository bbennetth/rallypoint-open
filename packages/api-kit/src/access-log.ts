import type { MiddlewareHandler } from 'hono'

// One log line per request at info level, after the response is
// finalized. Fields chosen to be useful in dashboards without leaking
// auth-sensitive content (each app's logger redact list is the backstop).
// Copy-pasted verbatim into all seven consumer apps before extraction;
// it lives here once now.

export interface ApiKitAccessLogger {
  info(obj: object, msg: string): void
}

interface AccessLogCtxVars {
  logger: ApiKitAccessLogger
  requestId: string
}

export function createAccessLog(): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now()
    await next()
    const ms = Math.round(performance.now() - start)
    const vars = c.var as unknown as AccessLogCtxVars
    vars.logger.info(
      {
        requestId: vars.requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: ms,
      },
      'request',
    )
  }
}
