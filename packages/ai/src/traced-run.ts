import { extractTraceRequest, extractTraceResponse } from './messages.js'
import {
  TRACE_SCHEMA_VERSION,
  type AiTracesRpc,
  type TraceImage,
  type TraceRecord,
} from './types.js'

// tracedAiRun — drop-in wrapper around Workers AI `ai.run()` that reports
// each call to ai-api's trace corpus. Two invariants:
//
//   1. The user-facing call is never delayed or broken by tracing: the
//      report goes out via `waitUntil` after the result returns, and every
//      failure inside the reporting path is swallowed.
//   2. Opt-out suppresses content, never telemetry: with `contentOptOut`
//      the record still carries model/latency/tokens/error but no
//      request/response messages and no image bytes.

export interface AiRunnerLike<R> {
  run(model: string, input: Record<string, unknown>, options?: never): Promise<R>
}

export interface TraceContext {
  /** ai-api's AiRPC via service binding; undefined disables tracing. */
  aiRpc: AiTracesRpc | undefined
  /** ExecutionContext.waitUntil (pre-bound) — keeps the isolate alive for
   * the fire-and-forget report. */
  waitUntil: (p: Promise<unknown>) => void
  userId: string
  app: string
  feature: string
  /** Chain id — pass the traceId of the first scan when re-scanning with
   * corrections; defaults to the new responseId (chain of one). */
  traceId?: string | undefined
  parentId?: string | undefined
  contentOptOut: boolean
}

export interface TracedRun<R> {
  result: R
  responseId: string
  traceId: string
}

export async function tracedAiRun<R, O>(
  ai: { run(model: string, input: Record<string, unknown>, options?: O): Promise<R> },
  model: string,
  input: Record<string, unknown>,
  options: O | undefined,
  ctx: TraceContext,
): Promise<TracedRun<R>> {
  const responseId = crypto.randomUUID()
  const traceId = ctx.traceId ?? responseId
  const startedAt = Date.now()
  let result: R
  try {
    result = await ai.run(model, input, options)
  } catch (err) {
    report(ctx, buildRecord(ctx, responseId, traceId, model, input, startedAt, undefined, err))
    throw err
  }
  report(ctx, buildRecord(ctx, responseId, traceId, model, input, startedAt, result, undefined))
  return { result, responseId, traceId }
}

function buildRecord(
  ctx: TraceContext,
  responseId: string,
  traceId: string,
  model: string,
  input: Record<string, unknown>,
  startedAt: number,
  result: unknown,
  err: unknown,
): { record: TraceRecord; images: TraceImage[] } {
  const record: TraceRecord = {
    responseId,
    traceId,
    parentId: ctx.parentId,
    userId: ctx.userId,
    app: ctx.app,
    feature: ctx.feature,
    provider: 'workers-ai',
    model,
    latencyMs: Date.now() - startedAt,
    cached: false,
    contentOmitted: ctx.contentOptOut,
    schemaVersion: TRACE_SCHEMA_VERSION,
  }
  if (err !== undefined) {
    record.error = err instanceof Error ? err.message : String(err)
  }
  let images: TraceImage[] = []
  if (!ctx.contentOptOut) {
    try {
      const extracted = extractTraceRequest(input)
      record.request = extracted.request
      images = extracted.images
      if (err === undefined) {
        const res = extractTraceResponse(result)
        record.response = res.response
        record.tokensIn = res.tokensIn
        record.tokensOut = res.tokensOut
      }
    } catch {
      // Content extraction failed — record telemetry only rather than
      // losing the row (or, worse, breaking the caller).
      record.request = undefined
      record.response = undefined
      images = []
    }
  }
  return { record, images }
}

function report(ctx: TraceContext, built: { record: TraceRecord; images: TraceImage[] }): void {
  if (!ctx.aiRpc) return
  try {
    const send = Promise.resolve()
      .then(() =>
        ctx.aiRpc!.recordTrace(built.record, built.images.length > 0 ? built.images : undefined),
      )
      .catch(() => {
        // Best-effort: a trace-store outage must never surface to users.
      })
    ctx.waitUntil(send)
  } catch {
    // No execution context (some test harnesses) — drop the report.
  }
}
