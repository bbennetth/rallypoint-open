import type { Context, ErrorHandler } from 'hono'
import { createErrorHandler, createCaptureServerException } from '@rallypoint/api-kit'
import type { HonoApp } from '../context.js'

// Top-level error handler + PostHog exception capture. Shared implementation
// lives in @rallypoint/api-kit (createErrorHandler); this app supplies only
// its service tag. planner-api opts into warn-on-5xx logging: 5xx ApiErrors
// (e.g. bad_gateway / upstream_unavailable when a peer RPC binding call
// fails) are operational problems worth surfacing at warn with the message;
// 4xx stay at info.

const SERVICE = 'rallypoint-planner'

export const errorHandler = createErrorHandler({
  service: SERVICE,
  warnOnServerApiErrors: true,
}) as ErrorHandler<HonoApp>

const capture = createCaptureServerException({ service: SERVICE })

export function captureServerException(
  c: Context<HonoApp>,
  err: unknown,
  properties: Record<string, unknown>,
): void {
  capture(c, err, properties)
}
