import { runAiCall, type AiTracesRpc } from '@rallypoint/ai'
import type { AiBinding, VisionRunResult } from './vision-chat.js'
import type { AiRunOptions } from './ai-options.js'

// Per-call trace context the routes hand into the vision services. Built
// by buildScanTrace (lib/ai-trace.ts) from the session + the user's
// aiTrainingOptOut setting. `lastResponseId` is an out-param: the service
// keeps its domain-shaped return value, and the route reads the id off
// the trace object after the call to surface it to the client (which
// echoes it back with feedback).
export interface ScanTrace {
  aiRpc: AiTracesRpc | null
  waitUntil: (p: Promise<unknown>) => void
  userId: string
  contentOptOut: boolean
  // Chain marker for correction re-scans: the client sends the FIRST
  // responseId of the loop; re-scans group under it as their traceId.
  parentResponseId?: string | undefined
  lastResponseId?: string
}

/** Run one Workers AI call through @rallypoint/ai's shared pipeline
 * (capacity retry × gateway × tracing). Thin fitness adapter: maps the
 * route-shaped ScanTrace onto the pipeline's TraceContext. Without a
 * trace context (unit tests, non-route callers) the call runs untraced
 * but still retried/gatewayed. */
export async function runTracedVision(
  ai: AiBinding,
  model: string,
  input: Record<string, unknown>,
  gateway: AiRunOptions | undefined,
  feature: string,
  trace: ScanTrace | undefined,
): Promise<VisionRunResult> {
  const { result, responseId } = await runAiCall(ai, model, input, {
    gatewayId: gateway?.gateway.id,
    ...(trace
      ? {
          trace: {
            aiRpc: trace.aiRpc ?? undefined,
            waitUntil: trace.waitUntil,
            userId: trace.userId,
            app: 'fitness',
            feature,
            traceId: trace.parentResponseId,
            parentId: trace.parentResponseId,
            contentOptOut: trace.contentOptOut,
          },
        }
      : {}),
  })
  if (trace && responseId !== undefined) trace.lastResponseId = responseId
  return result
}
