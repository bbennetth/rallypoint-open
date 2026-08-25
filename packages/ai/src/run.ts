// The one on-ramp for Workers AI calls: retry × AI Gateway × tracing ×
// JSON recovery, composed from this package's own layers. New AI features
// call runAiCall/runAiJson instead of hand-rolling the glue — the
// fitness muscle-review outage happened precisely because it was the one
// call site that bypassed this pipeline (bare `ai.run`, no gateway, no
// trace, no logging: invisible failures).
//
// Layering (all optional, all composable):
//   - retry:   withCapacityRetry — transient 3040/429 only. Each retry is
//              a FRESH traced run, so a capacity blip that recovers leaves
//              both the failed attempt and the success in the trace corpus.
//   - gateway: `gatewayId` → ai.run's `{ gateway: { id } }` option
//              (Cloudflare AI Gateway: logging, caching, cost visibility).
//   - trace:   tracedAiRun → ai-api's ai_traces corpus. Omit in dev/tests.
//   - json:    recoverJsonPayload + automatic warn-log with shape
//              diagnostics on failure — no caller can be blind again.

import { withCapacityRetry, type AiRetryConfig } from './retry.js'
import { tracedAiRun, type TraceContext } from './traced-run.js'
import {
  recoverJsonPayload,
  type AiRunResult,
  type JsonRecoveryDiagnostics,
  type JsonRecoveryFailure,
} from './result.js'

/** ai.run options understood by the Workers AI binding's gateway routing. */
export interface AiGatewayRunOptions {
  gateway: { id: string }
}

/** Structural view of the Workers AI binding (or any compatible runner). */
export interface AiRunner<R = AiRunResult> {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: AiGatewayRunOptions,
  ): Promise<R>
}

/** Minimal logger surface — matches @rallypoint/logger's pino-style
 * `warn(obj, msg)` without a package dependency. */
export interface AiWarnLogger {
  warn(obj: Record<string, unknown>, msg: string): void
}

export interface AiCallOptions {
  /** Cloudflare AI Gateway id; blank/undefined → direct Workers AI call
   * (byte-for-byte the pre-gateway two-arg behavior). */
  gatewayId?: string | undefined
  /** Trace context for ai-api's ai_traces corpus; omit to run untraced. */
  trace?: TraceContext | undefined
  /** Warn-logger for JSON-recovery failures (runAiJson only). */
  logger?: AiWarnLogger | undefined
  retry?: AiRetryConfig | undefined
}

export interface AiCallResult<R> {
  result: R
  /** Present when the call was traced — clients echo it back as feedback. */
  responseId?: string
  /** The trace chain id (defaults to responseId for a chain of one); present
   * when the call was traced. Distinct from responseId so a caller can both
   * group re-scans (traceId) and reference this specific response. */
  traceId?: string
}

/** Run one model call through retry × gateway × tracing. */
export async function runAiCall<R>(
  ai: AiRunner<R>,
  model: string,
  input: Record<string, unknown>,
  opts: AiCallOptions = {},
): Promise<AiCallResult<R>> {
  const id = opts.gatewayId?.trim()
  const gateway: AiGatewayRunOptions | undefined = id ? { gateway: { id } } : undefined
  const hooks = opts.retry ? { config: opts.retry } : {}
  const trace = opts.trace
  if (!trace) {
    const result = await withCapacityRetry(() => ai.run(model, input, gateway), hooks)
    return { result }
  }
  const { result, responseId, traceId } = await withCapacityRetry(
    () => tracedAiRun(ai, model, input, gateway, trace),
    hooks,
  )
  return { result, responseId, traceId }
}

export type AiJsonResult =
  | { ok: true; object: Record<string, unknown>; responseId?: string; traceId?: string }
  | {
      ok: false
      failure: JsonRecoveryFailure
      diagnostics: JsonRecoveryDiagnostics
      responseId?: string
      traceId?: string
    }

/** Run one structured-output model call and recover its JSON payload.
 * Recovery failures are warn-logged with shape diagnostics automatically
 * (model, feature, failure kind, responseType/resultKeys/rawPreview) —
 * the trace row (when tracing is on) carries the full raw response.
 * `extract` defaults to first-object; reason-then-JSON prompts pass
 * extractLastJsonObject. */
export async function runAiJson(
  ai: AiRunner<AiRunResult>,
  model: string,
  input: Record<string, unknown>,
  opts: AiCallOptions & { extract?: (text: string) => string | null } = {},
): Promise<AiJsonResult> {
  const { result, responseId, traceId } = await runAiCall(ai, model, input, opts)
  const recovered = recoverJsonPayload(result, opts.extract ? { extract: opts.extract } : {})
  const idPart = {
    ...(responseId !== undefined ? { responseId } : {}),
    ...(traceId !== undefined ? { traceId } : {}),
  }
  if (recovered.ok) return { ok: true, object: recovered.object, ...idPart }
  opts.logger?.warn(
    {
      model,
      ...(opts.trace ? { feature: opts.trace.feature } : {}),
      ...idPart,
      failure: recovered.failure,
      ...recovered.diagnostics,
    },
    'AI JSON payload unrecoverable',
  )
  return { ok: false, failure: recovered.failure, diagnostics: recovered.diagnostics, ...idPart }
}
