import { createMiddleware } from 'hono/factory'
import type { HonoApp } from '../context.js'

// One log line per request at info level, after the response
// finalizes. Fields match the sibling services so they slot into the
// same aggregation dashboards.

export const accessLog = createMiddleware<HonoApp>(async (c, next) => {
  const start = performance.now()
  await next()
  const ms = Math.round(performance.now() - start)
  c.var.logger.info(
    {
      requestId: c.var.requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: ms,
    },
    'request',
  )
})
