import {
  runAiJson,
  type AiJsonResult,
  type AiRunResult,
  type AiRunner,
  type AiTracesRpc,
  type AiWarnLogger,
} from '@rallypoint/ai'

// AI Assist model call — a thin planner adapter over @rallypoint/ai's shared
// pipeline (capacity retry on 3040/429 × AI Gateway × tracing × JSON recovery),
// all the glue this used to hand-roll. The route owns prompt building +
// coercion; this owns only the call + trace mapping, mirroring fitness-api's
// runTracedVision. app 'planner', feature 'assist'.

// The Workers AI binding, structurally the shared pipeline's runner over the
// loose Workers-AI result union. context.ts / worker.ts use this as the env
// `AI` binding type.
export type AiBinding = AiRunner<AiRunResult>

// Per-call trace context built from the request (session user + waitUntil +
// the user's aiTrainingOptOut). `aiRpc` null → the call runs untraced, but is
// still retried/gatewayed and still minted a responseId/traceId (so client
// feedback has an id to echo).
export interface AssistTrace {
  aiRpc: AiTracesRpc | null
  waitUntil: (p: Promise<unknown>) => void
  userId: string
  contentOptOut: boolean
}

// Run the assist call and recover its JSON payload. Returns the shared
// AiJsonResult: `ok` with the recovered object (+ responseId/traceId), or
// `!ok` with a recovery failure the route maps to 422. Throws only when the
// model call itself fails (capacity exhausted after retries, or a hard error)
// — the route maps that to 503. A trace context is ALWAYS passed so the ids
// are minted even when aiRpc is absent.
export function runAssist(
  ai: AiBinding,
  model: string,
  input: Record<string, unknown>,
  gatewayId: string | undefined,
  trace: AssistTrace,
  logger?: AiWarnLogger,
  // Trace corpus feature tag; the braindump route passes its own so its
  // enrich/summary calls are distinguishable from quick-add assist.
  feature: string = 'assist',
): Promise<AiJsonResult> {
  return runAiJson(ai, model, input, {
    gatewayId,
    ...(logger ? { logger } : {}),
    trace: {
      aiRpc: trace.aiRpc ?? undefined,
      waitUntil: trace.waitUntil,
      userId: trace.userId,
      app: 'planner',
      feature,
      contentOptOut: trace.contentOptOut,
    },
  })
}
