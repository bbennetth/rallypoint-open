import { Hono } from 'hono'
import { z } from 'zod'
import type { Context } from 'hono'
import type { AiTracesRpc } from '@rallypoint/ai'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { applyPerUserRateLimit } from '../middleware/rate-limit.js'
import { readJsonBody } from './_body.js'
import {
  ASSIST_MODEL,
  AssistRequestSchema,
  buildAssistInput,
  coerceSuggestion,
  parseAssistOutput,
  type AssistResponse,
} from '../lib/assist.js'
import { runAssist, type AiBinding, type AssistTrace } from '../services/assist.js'

// AI Assist BFF — free-text/voice capture → AI categorization. The parse
// endpoint is a STATELESS composition: it calls Workers AI and returns a
// structured suggestion. It saves nothing. planner-web confirms/saves the
// suggestion through the EXISTING create endpoints (tasks/events/notes/
// shopping/diary), so the offline outbox + notification enqueue-on-write stay
// intact and no domain table/rule moves into this thin BFF.
//
// The AI + trace bindings come off `c.env` (the raw Worker bindings), not the
// Services bag — the parse path is the only consumer, so threading them
// through every Services fake would be pure churn. Absent AI binding (a
// deployment without Workers AI) → 503; unparseable model output → 422 (the
// client falls back to the manual quick-add form prefilled with the text).

// Per-user throttle for the Workers AI parse call. Every request hits the
// model, so cap it like fitness-api's scan endpoints — slightly looser
// because assist is text-only (cheaper) and fires as the user types/dictates.
const ASSIST_RATE_LIMIT = { route: 'ai-assist', limit: 15, windowSeconds: 60 } as const

function unavailable(): ApiError {
  return new ApiError({
    code: 'assist_unavailable',
    message: 'AI Assist is not available right now.',
    status: 503,
  })
}

function unparsable(): ApiError {
  return new ApiError({
    code: 'assist_unparsable',
    message: 'Could not understand that. Try rephrasing, or add it manually.',
    status: 422,
  })
}

// Build the per-call trace context: session user, a waitUntil that survives
// the response, and the user's content opt-out. Opt-out fails CLOSED — a
// settings-read error omits content rather than capturing against an unknown
// preference (mirrors fitness-api's buildScanTrace). Exported for the other
// AI BFF routes (braindump.ts) so the opt-out semantics stay in one place.
export async function buildAssistTrace(
  c: Context<HonoApp>,
  aiRpc: AiTracesRpc | null,
): Promise<AssistTrace> {
  const userId = c.var.session!.userId
  let contentOptOut = true
  try {
    const shared = await c.var.services.settings.get(userId, 'shared')
    contentOptOut = shared['aiTrainingOptOut'] === true
  } catch (err) {
    c.var.logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'aiTrainingOptOut read failed — omitting assist trace content',
    )
  }
  return {
    aiRpc,
    waitUntil: (p) => {
      try {
        c.executionCtx.waitUntil(p)
      } catch {
        void p // no execution context (some test harnesses)
      }
    },
    userId,
    contentOptOut,
  }
}

const FeedbackSchema = z.object({
  responseId: z.string().min(1).max(128),
  verdict: z.enum(['accepted', 'edited', 'rejected']),
  // The edited final value is opaque (it lands in ai-api's final_value_json),
  // but cap its serialized size so an authenticated caller can't push an
  // unbounded blob through the fire-and-forget RPC — defense-in-depth beside
  // the text/notes caps on the parse path.
  edited: z
    .unknown()
    .optional()
    .refine((v) => v === undefined || JSON.stringify(v ?? null).length <= 4000, {
      message: 'edited payload is too large',
    }),
})

export const assistRoutes = new Hono<HonoApp>()
  // --- parse free text into a structured suggestion ------------------
  .post('/api/v1/ui/assist/parse', requireSession(), async (c) => {
    const ai = c.env.AI as AiBinding | undefined
    if (!ai) throw unavailable()
    await applyPerUserRateLimit(c, { userId: c.var.session!.userId, ...ASSIST_RATE_LIMIT })

    const parsed = AssistRequestSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { text, clientNow, tz } = parsed.data

    const aiRpc = (c.env.AI_TRACES as AiTracesRpc | undefined) ?? null
    const trace = await buildAssistTrace(c, aiRpc)
    const input = buildAssistInput(text, clientNow, tz)

    let run
    try {
      const model = c.var.env.ASSIST_MODEL ?? ASSIST_MODEL
      run = await runAssist(ai, model, input, c.var.env.AI_GATEWAY_ID, trace, c.var.logger)
    } catch (err) {
      c.var.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'assist model call failed',
      )
      throw unavailable()
    }

    // JSON recovery failed (no/garbled object) — the client falls back to the
    // manual quick-add form (@rallypoint/ai already warn-logged the diagnostics).
    if (!run.ok) throw unparsable()
    const rawModel = parseAssistOutput(run.object)
    if (rawModel === null) throw unparsable()

    const suggestion = coerceSuggestion(rawModel, tz, clientNow)
    const body: AssistResponse = {
      ...suggestion,
      // A trace context is always passed to runAssist, so both ids are minted.
      traceId: run.traceId ?? run.responseId ?? '',
      responseId: run.responseId ?? '',
    }
    return c.json(body)
  })

  // --- record what the user did with a suggestion --------------------
  // Advisory + fire-and-forget from the client's view: an unconfigured
  // AI_TRACES binding or an unknown/expired responseId is `{ok:false}`, not an
  // error. The userId comes from the session, never the body.
  .post('/api/v1/ui/assist/feedback', requireSession(), async (c) => {
    const parsed = FeedbackSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    const aiRpc = c.env.AI_TRACES as AiTracesRpc | undefined
    if (!aiRpc) return c.json({ ok: false })

    const result = await aiRpc.recordFeedback({
      responseId: parsed.data.responseId,
      userId: c.var.session!.userId,
      action: parsed.data.verdict,
      ...(parsed.data.edited !== undefined ? { finalValue: parsed.data.edited } : {}),
    })
    return c.json(result)
  })
