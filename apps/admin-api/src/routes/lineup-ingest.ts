import { Hono } from 'hono'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { readJsonBody } from './_body.js'

// AI lineup ingestion for system-owned festivals — thin proxies to
// events-api's EventsRPC adminLineup* methods over the EVENTS service
// binding (same trust model as system-events.ts: requireSession +
// requireAdmin here, actor re-checked against events-api's own
// ADMIN_USER_IDS). Validation of the ingest body lives in events-api's
// core fn, so this router only shapes envelopes.

type Kinded = { kind: string; issues?: { path: string; message: string }[] }

function throwCommon(result: Kinded): void {
  if (result.kind === 'forbidden') throw errors.forbidden()
  if (result.kind === 'not_found') throw errors.notFound('Not found.')
  if (result.kind === 'invalid') {
    const issues = result.issues ?? []
    throw new ApiError({
      code: 'validation_failed',
      message: issues[0] ? `${issues[0].path ? issues[0].path + ': ' : ''}${issues[0].message}` : 'Request body failed validation.',
      status: 400,
      details: { issues },
    })
  }
}

const CONFLICT_MESSAGES: Record<string, string> = {
  ai_unavailable: 'The AI binding is not available in this deployment.',
  not_pending: 'This ingestion has already been decided.',
  proposal_missing: 'This ingestion has no reviewable proposal.',
  stale_proposal:
    'The event changed since this proposal was created — re-run the ingestion for a fresh diff.',
  empty_proposal: 'The proposal contains no lineup changes to apply.',
}

function throwConflict(code: string): never {
  throw errors.conflict(code, CONFLICT_MESSAGES[code] ?? 'The request conflicts with current state.')
}

export const lineupIngestRoutes = new Hono<HonoApp>()
  // Run an extraction: { source_url? , pasted_text?, replace? } → 201
  // with the persisted (pending) ingestion incl. its diff, or 502-ish
  // envelopes for fetch/AI failures (the failed row is still persisted
  // for audit and included).
  .post('/api/v1/ui/system-events/:id/lineup-ingestions', async (c) => {
    const actor = c.var.session!.userId
    const body = (await readJsonBody(c)) as Record<string, unknown>
    const result = await c.var.services.systemEvents.ingestLineup(actor, c.req.param('id'), {
      sourceUrl: body.source_url,
      pastedText: body.pasted_text,
      replace: body.replace,
    })
    throwCommon(result)
    if (result.kind === 'conflict') throwConflict(result.code)
    if (result.kind === 'failed') {
      throw new ApiError({
        code: result.code,
        message:
          result.code === 'fetch_failed'
            ? 'Could not fetch the source page — paste the page text instead.'
            : 'The AI extraction produced an unusable response — try again.',
        status: 422,
        details: { ingestion: result.data },
      })
    }
    if (result.kind !== 'ok') throw errors.forbidden()
    return c.json(result.data, 201)
  })

  .get('/api/v1/ui/system-events/:id/lineup-ingestions', async (c) => {
    const actor = c.var.session!.userId
    const status = c.req.query('status')
    const result = await c.var.services.systemEvents.listLineupIngestions(
      actor,
      c.req.param('id'),
      status ? { status } : {},
    )
    throwCommon(result)
    if (result.kind !== 'ok') throw errors.forbidden()
    return c.json({ items: result.data })
  })

  .get('/api/v1/ui/lineup-ingestions/:iid', async (c) => {
    const actor = c.var.session!.userId
    const result = await c.var.services.systemEvents.getLineupIngestion(actor, c.req.param('iid'))
    throwCommon(result)
    if (result.kind !== 'ok') throw errors.forbidden()
    return c.json(result.data)
  })

  .post('/api/v1/ui/lineup-ingestions/:iid/approve', async (c) => {
    const actor = c.var.session!.userId
    const result = await c.var.services.systemEvents.approveLineupIngestion(
      actor,
      c.req.param('iid'),
    )
    throwCommon(result)
    if (result.kind === 'conflict') throwConflict(result.code)
    if (result.kind !== 'ok') throw errors.forbidden()
    return c.json(result.data)
  })

  .post('/api/v1/ui/lineup-ingestions/:iid/reject', async (c) => {
    const actor = c.var.session!.userId
    const result = await c.var.services.systemEvents.rejectLineupIngestion(
      actor,
      c.req.param('iid'),
    )
    throwCommon(result)
    if (result.kind === 'conflict') throwConflict(result.code)
    if (result.kind !== 'ok') throw errors.forbidden()
    return c.json(result.data)
  })
