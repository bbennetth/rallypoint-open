import { createMiddleware } from 'hono/factory'
import type { HonoApp } from '../context.js'

// Drains the PostHog log-sink buffer once per request. Registered
// outermost so its post-`next()` flush runs after every other middleware
// and handler has logged (including the error handler). The buffer is
// isolate-shared, so this flush ships whatever accumulated during the
// request in one batched POST that survives the response via
// `executionCtx.waitUntil`. `finally` guarantees the flush is scheduled
// even when a downstream handler throws.
export function logFlush(flush: () => Promise<void>) {
  return createMiddleware<HonoApp>(async (c, next) => {
    try {
      await next()
    } finally {
      try {
        c.executionCtx.waitUntil(flush())
      } catch {
        // No execution context (some test harnesses) — fire and forget.
        void flush()
      }
    }
  })
}
