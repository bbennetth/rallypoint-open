import type { Context, ErrorHandler } from 'hono'
import { createErrorHandler, createCaptureServerException } from '@rallypoint/api-kit'
import type { HonoApp } from '../context.js'

// Top-level error handler + PostHog exception capture. Shared implementation
// lives in @rallypoint/api-kit (createErrorHandler); this app supplies only
// its service tag. captureServerException is called directly by the AI scan
// routes (routes/scan.ts, routes/food.ts).

const SERVICE = 'rallypoint-fitness'

export const errorHandler = createErrorHandler({ service: SERVICE }) as ErrorHandler<HonoApp>

const capture = createCaptureServerException({ service: SERVICE })

export function captureServerException(
  c: Context<HonoApp>,
  err: unknown,
  properties: Record<string, unknown>,
): void {
  capture(c, err, properties)
}
