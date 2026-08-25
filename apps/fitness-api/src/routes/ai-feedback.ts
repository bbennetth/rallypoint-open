import { Hono } from 'hono'
import { z } from 'zod'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { readJsonBody } from './_body.js'

// POST /api/v1/ui/ai/feedback — record what the user did with an AI scan
// result (accepted / edited / rejected / retried), keyed by the
// responseId the scan endpoints return. Forwards to ai-api's AiRPC over
// the AI_TRACES binding; the userId comes from the session, never the
// body. Fire-and-forget from the client's perspective — the response is
// advisory (`ok:false` for an unknown/expired responseId is not an
// error).

const feedbackSchema = z.object({
  responseId: z.string().min(1).max(128),
  action: z.enum(['accepted', 'edited', 'rejected', 'retried']),
  finalValue: z.unknown().optional(),
})

export const aiFeedbackRoutes = new Hono<HonoApp>().post('/api/v1/ui/ai/feedback', async (c) => {
  const aiTraces = c.var.services.aiTraces
  if (!aiTraces) {
    throw errors.notFound('AI feedback is not configured for this deployment.')
  }
  const parsed = feedbackSchema.safeParse(await readJsonBody(c))
  if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
  const result = await aiTraces.recordFeedback({
    responseId: parsed.data.responseId,
    userId: c.var.session!.userId,
    action: parsed.data.action,
    ...(parsed.data.finalValue !== undefined ? { finalValue: parsed.data.finalValue } : {}),
  })
  return c.json(result)
})
