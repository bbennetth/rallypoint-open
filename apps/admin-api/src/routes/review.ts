import { Hono } from 'hono'
import { reviewSubmissionSchema, submissionStatusSchema } from '@rallypoint/fitness-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { readJsonBody } from './_body.js'

// The exercise-submission review queue — thin proxies to fitness-api's
// FitnessRPC admin methods over the FITNESS service binding. Access control
// (requireSession + requireAdmin) and CSRF/origin are mounted in build-app;
// this router owns only validation + envelope shaping.

function parseNote(body: unknown): { note?: string } {
  const parsed = reviewSubmissionSchema.safeParse(body ?? {})
  if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
  return parsed.data.note !== undefined ? { note: parsed.data.note } : {}
}

export const reviewRoutes = new Hono<HonoApp>()
  // List submissions. ?status= filters (pending|approved|rejected); the
  // review queue's default view is the pending pile.
  .get('/api/v1/ui/submissions', async (c) => {
    const raw = c.req.query('status') ?? 'pending'
    const parsed = submissionStatusSchema.safeParse(raw)
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const items = await c.var.services.fitness.listSubmissions(parsed.data)
    return c.json({ items })
  })

  .get('/api/v1/ui/submissions/:id', async (c) => {
    const item = await c.var.services.fitness.getSubmission(c.req.param('id'))
    if (!item) throw errors.notFound('Submission not found.')
    return c.json(item)
  })

  .post('/api/v1/ui/submissions/:id/approve', async (c) => {
    const opts = parseNote(await readJsonBodyOrEmpty(c))
    const item = await c.var.services.fitness.approveSubmission(c.req.param('id'), opts)
    if (!item) throw errors.notFound('Submission not found.')
    if (item === 'not_pending') {
      throw errors.conflict('submission_not_pending', 'Submission has already been reviewed.')
    }
    return c.json(item)
  })

  .post('/api/v1/ui/submissions/:id/reject', async (c) => {
    const opts = parseNote(await readJsonBodyOrEmpty(c))
    const item = await c.var.services.fitness.rejectSubmission(c.req.param('id'), opts)
    if (!item) throw errors.notFound('Submission not found.')
    if (item === 'not_pending') {
      throw errors.conflict('submission_not_pending', 'Submission has already been reviewed.')
    }
    return c.json(item)
  })

  // Re-run the automatic AI triage scan. 409 while a fresh scan is
  // still in flight; 'failed' returns 200 with the outcome so the UI
  // can badge it without treating the click as an error.
  .post('/api/v1/ui/submissions/:id/rescan', async (c) => {
    const res = await c.var.services.fitness.rescanSubmission(c.req.param('id'), {
      actorUserId: c.var.session!.userId,
    })
    if (res.outcome === 'not_found') throw errors.notFound('Submission not found.')
    if (res.outcome === 'already_pending') {
      throw errors.conflict('scan_pending', 'A scan is already in progress for this submission.')
    }
    if (res.outcome === 'ai_unavailable') {
      throw errors.upstreamUnavailable('The AI scanner is not available in this deployment.')
    }
    return c.json(res)
  })

// Approve/reject bodies are optional ({note?}); tolerate an absent body
// rather than 400ing a bare POST.
async function readJsonBodyOrEmpty(c: Parameters<typeof readJsonBody>[0]): Promise<unknown> {
  try {
    return await readJsonBody(c)
  } catch {
    return {}
  }
}
