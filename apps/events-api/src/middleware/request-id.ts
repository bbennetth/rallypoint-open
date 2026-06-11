import { createMiddleware } from 'hono/factory'
import { ulid } from 'ulid'
import type { HonoApp } from '../context.js'

// Attach a ULID request-id to every request; echo it back as
// X-RP-Request-Id so logs and client-reported errors can be
// correlated. Same header name as apps/id-api so a single dashboard
// can ingest both services.

export const requestId = createMiddleware<HonoApp>(async (c, next) => {
  const id = ulid()
  c.set('requestId', id)
  c.header('X-RP-Request-Id', id)
  await next()
})
