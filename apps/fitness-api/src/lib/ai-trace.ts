import type { Context } from 'hono'
import type { HonoApp } from '../context.js'
import type { ScanTrace } from '../services/ai-trace-run.js'

// Build the per-call ScanTrace for an AI scan route: session user,
// waitUntil (so the fire-and-forget trace report survives the response),
// and the user's content opt-out.
//
// Opt-out semantics (user directive): opted-out users still produce an
// ops-telemetry trace row (model, latency, error) but no prompt/response
// content and no image blobs. The flag lives in the cross-app `shared`
// settings namespace as `aiTrainingOptOut` (id-web account settings owns
// the toggle). The read FAILS CLOSED: if the settings lookup errors,
// content is omitted rather than captured against an unknown preference.
export async function buildScanTrace(
  c: Context<HonoApp>,
  parentResponseId?: string,
): Promise<ScanTrace> {
  const userId = c.var.session!.userId
  let contentOptOut = true
  try {
    const shared = await c.var.services.settings.get(userId, 'shared')
    contentOptOut = shared['aiTrainingOptOut'] === true
  } catch (err) {
    c.var.logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'aiTrainingOptOut read failed — omitting trace content',
    )
  }
  return {
    aiRpc: c.var.services.aiTraces ?? null,
    waitUntil: (p) => {
      try {
        c.executionCtx.waitUntil(p)
      } catch {
        // No execution context (some test harnesses) — fire and forget.
        void p
      }
    },
    userId,
    contentOptOut,
    parentResponseId,
  }
}
