import type { MiddlewareHandler } from 'hono'
import { createAccessLog } from '@rallypoint/api-kit'
import type { HonoApp } from '../context.js'

// One log line per request at info level, after the response finalizes.
// Shared implementation lives in @rallypoint/api-kit (createAccessLog).

export const accessLog = createAccessLog() as MiddlewareHandler<HonoApp>
